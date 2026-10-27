// k6 concurrent-stream load test.
//
// k6's http module buffers the whole response, so it measures success rate, TTFB and total duration,
// not per-event timing (use scripts/sse-probe.mjs for TTFE/gap/lag/cancel). TTFB is a good proxy for TTFE
// here because the backend commits its headers together with the first event.
//
//   k6 run -e TARGET=http://localhost:8080 -e VUS=100 scripts/load-test.js
//   docker run --rm -i -e TARGET=http://host.docker.internal:8082 -e VUS=500 grafana/k6:1.3.0 run - < scripts/load-test.js
import http from 'k6/http'
import { check } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const TARGET = __ENV.TARGET || 'http://localhost:8080'
const VUS = Number(__ENV.VUS || 100)
const ITERATIONS = Number(__ENV.ITERATIONS || 3)
const COUNT = Number(__ENV.COUNT || 10)
const DELAY_MS = Number(__ENV.DELAY_MS || 200)

export const options = {
  scenarios: {
    streams: { executor: 'per-vu-iterations', vus: VUS, iterations: ITERATIONS, maxDuration: '10m' },
  },
  thresholds: {
    stream_complete: ['rate>0.99'],
  },
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max'],
}

const streamComplete = new Rate('stream_complete')
const streamTtfb = new Trend('stream_ttfb', true)
const streamDuration = new Trend('stream_duration', true)

export default function () {
  const res = http.post(
    `${TARGET}/api/chat/stream`,
    JSON.stringify({ message: 'k6', count: COUNT, delayMs: DELAY_MS }),
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Request-Id': `k6-${__VU}-${__ITER}`,
      },
      timeout: '120s',
    },
  )

  const body = res.body || ''
  const tokens = (body.match(/^event:\s?token\r?$/gm) || []).length
  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'content-type is text/event-stream': (r) => (r.headers['Content-Type'] || '').startsWith('text/event-stream'),
    'all tokens received': () => tokens === COUNT,
    'done event received': () => /^event:\s?done\r?$/m.test(body),
  })

  streamComplete.add(ok)
  streamTtfb.add(res.timings.waiting)
  streamDuration.add(res.timings.duration)
}
