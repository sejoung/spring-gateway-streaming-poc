// One test case = one k6 run of this script against one target.
// Needs a k6 binary built with xk6-sse (apps/test-runner/Dockerfile builds one).
//
// Every request leaves one raw-data point `sse_request_ms` in k6's JSON output. Its metadata holds
// the request id and a `detail` JSON with status, outcome, every received event and the backend's
// cancel record, so the runner (or anyone with the file) can judge and drill into single requests.
//
//   k6 run -e KIND=stream -e BASE_URL=http://localhost:8080 -e COUNT=10 -e DELAY_MS=200 sse-case.js
import exec from 'k6/execution'
import http from 'k6/http'
import { sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'
import sse from 'k6/x/sse'

const env = (name, fallback) => (__ENV[name] !== undefined && __ENV[name] !== '' ? __ENV[name] : fallback)

const KIND = env('KIND', 'stream') // stream | cors
const CASE = env('CASE', 'adhoc')
const RUN = env('RUN', 'cli')
const BASE_URL = env('BASE_URL', 'http://localhost:8080')
const PATH = env('PATH_PREFIX', '') + '/api/chat/stream'
const BACKEND_URL = env('BACKEND_URL', 'http://localhost:8081')
const COUNT = Number(env('COUNT', 10))
const DELAY_MS = Number(env('DELAY_MS', 200))
const FAIL_MODE = env('FAIL_MODE', 'NONE')
const VUS = Number(env('VUS', 1))
const ITERATIONS = Number(env('ITERATIONS', 1))
const WARMUP = Number(env('WARMUP', 0))
// Warmup iterations can use a shorter stream so a 20s case does not need a 20s warmup.
const WARMUP_COUNT = Number(env('WARMUP_COUNT', COUNT))
const WARMUP_DELAY_MS = Number(env('WARMUP_DELAY_MS', DELAY_MS))
// >0: after warmup every VU waits for the same wall-clock instant, so the measured requests connect at once.
const BARRIER_MS = Number(env('BARRIER_MS', 0))
const ABORT_AFTER = Number(env('ABORT_AFTER', 0))
const CANCEL_WAIT_MS = Number(env('CANCEL_WAIT_MS', 15000))
// Per-request deadline so a stalled stream fails instead of hanging the run. Three times the stream's length
// leaves room for requests that legitimately queue behind other streams (MVC with 200 threads, scenario 12).
const TIMEOUT = env('TIMEOUT', `${Math.ceil((3 * COUNT * DELAY_MS) / 1000) + 30}s`)
// identity: ask the gateway not to compress. auto: let Go's HTTP client negotiate gzip and decompress.
const ACCEPT_ENCODING = env('ACCEPT_ENCODING', 'identity')
const CHECK_GZIP = env('CHECK_GZIP', 'false') === 'true'
const ORIGIN = env('ORIGIN', 'http://localhost:5173')

export const options = {
  scenarios: {
    case: { executor: 'per-vu-iterations', vus: VUS, iterations: WARMUP + ITERATIONS, maxDuration: '20m' },
  },
  summaryTrendStats: ['min', 'med', 'p(95)', 'max'],
}

const requestMs = new Trend('sse_request_ms', true)
const ttfeMs = new Trend('sse_ttfe_ms', true)
const lagMs = new Trend('sse_event_lag_ms', true)
const complete = new Rate('sse_complete')
const checkPoint = new Trend('case_check')

function emit(metric, value, tags, rid, detail) {
  exec.vu.metrics.metadata.rid = rid
  exec.vu.metrics.metadata.detail = JSON.stringify(detail)
  metric.add(value, tags)
  delete exec.vu.metrics.metadata.rid
  delete exec.vu.metrics.metadata.detail
}

function requestId() {
  return `${RUN}-${CASE}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`.slice(0, 64)
}

function awaitBackend(rid, abortedAt) {
  const deadline = Date.now() + CANCEL_WAIT_MS
  let record = null
  for (;;) {
    const res = http.get(`${BACKEND_URL}/internal/streams/${rid}`, { tags: { name: 'backend-record' } })
    if (res.status === 200) record = res.json()
    if ((record && record.outcome !== 'RUNNING') || Date.now() > deadline) break
    sleep(0.05)
  }
  if (!record) return { backendOutcome: 'UNKNOWN' }
  return {
    backendOutcome: record.outcome,
    backendFinishedAt: record.finishedAt,
    cancelPropagationMs: record.outcome === 'RUNNING' ? null : record.finishedAt - abortedAt,
    eventsAfterAbort: record.emittedEvents - ABORT_AFTER,
  }
}

function checkGzip() {
  const res = http.post(`${BASE_URL}${PATH}`, JSON.stringify({ message: 'gzip-check', count: 2, delayMs: 50 }), {
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Accept-Encoding': 'gzip' },
    tags: { name: 'gzip-check' },
  })
  const encoding = res.headers['Content-Encoding'] || null
  emit(checkPoint, encoding === 'gzip' ? 1 : 0, { case: CASE, check: 'gzip' }, 'gzip-check', {
    status: res.status,
    contentEncoding: encoding,
  })
}

function streamOnce() {
  const rid = requestId()
  const warmup = exec.vu.iterationInScenario < WARMUP
  const headers = { 'Content-Type': 'application/json', 'X-Request-Id': rid }
  if (ACCEPT_ENCODING !== 'auto') headers['Accept-Encoding'] = ACCEPT_ENCODING

  const t0 = Date.now()
  const d = { status: 0, outcome: null, error: null, headersMs: null, ttfeMs: null, tokens: 0, inOrder: true, sawDone: false, events: [] }
  let abortedAt = null

  const res = sse.open(`${BASE_URL}${PATH}`, {
    method: 'POST',
    body: JSON.stringify({ message: 'k6', count: warmup ? WARMUP_COUNT : COUNT, delayMs: warmup ? WARMUP_DELAY_MS : DELAY_MS, failMode: FAIL_MODE }),
    headers,
    timeout: TIMEOUT,
    tags: { case: CASE },
  }, (client) => {
    client.on('open', () => { d.headersMs = Date.now() - t0 })
    client.on('event', (e) => {
      const now = Date.now()
      const at = now - t0
      if (d.ttfeMs === null) d.ttfeMs = at
      if (e.name === 'token') {
        const data = JSON.parse(e.data)
        if (data.index !== d.tokens) d.inOrder = false
        d.tokens++
        const lag = now - data.emittedAt
        d.events.push([data.index, at, lag])
        if (!warmup) lagMs.add(lag, { case: CASE })
        if (ABORT_AFTER > 0 && d.tokens === ABORT_AFTER) {
          abortedAt = Date.now()
          client.close()
        }
      } else if (e.name === 'done') {
        d.sawDone = true
        d.events.push(['done', at, null])
      }
    })
    client.on('error', (e) => {
      // Closing the stream ourselves (abort) also surfaces as an error; only real failures count.
      if (abortedAt === null && d.error === null) d.error = String(e.error())
      client.close()
    })
  })

  const totalMs = Date.now() - t0
  d.status = res ? res.status : 0
  d.contentType = res && res.headers ? res.headers['Content-Type'] || null : null
  d.cacheControl = res && res.headers ? res.headers['Cache-Control'] || null : null
  if (res && res.error && !d.error) d.error = res.error
  d.totalMs = totalMs

  if (d.status === 0) d.outcome = 'connect_error'
  else if (d.status !== 200) d.outcome = 'http_error'
  else if (abortedAt !== null) d.outcome = 'aborted'
  else if (d.error) d.outcome = 'stream_error'
  else if (d.sawDone && d.tokens === (warmup ? WARMUP_COUNT : COUNT)) d.outcome = 'complete'
  else if (d.sawDone) d.outcome = 'token_mismatch'
  else d.outcome = 'no_done'

  if (abortedAt !== null) {
    d.abortedAtMs = abortedAt - t0
    Object.assign(d, awaitBackend(rid, abortedAt))
  }

  const tags = { case: CASE, warmup: String(warmup), outcome: d.outcome }
  emit(requestMs, totalMs, tags, rid, d)
  if (!warmup) {
    if (d.ttfeMs !== null) ttfeMs.add(d.ttfeMs, { case: CASE })
    complete.add(d.outcome === 'complete' || d.outcome === 'aborted', { case: CASE })
  }
  console.log(`${rid} status=${d.status} outcome=${d.outcome} tokens=${d.tokens} ttfe=${d.ttfeMs} total=${totalMs}` +
    (d.backendOutcome ? ` backend=${d.backendOutcome} cancelMs=${d.cancelPropagationMs}` : '') +
    (d.error ? ` error=${d.error}` : ''))
}

function corsOnce() {
  const preflight = (origin) =>
    http.options(`${BASE_URL}${PATH}`, null, {
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-request-id' },
      tags: { name: 'cors-preflight' },
    })
  const allowed = preflight(ORIGIN)
  const denied = preflight('http://not-allowed.example')
  const d = {
    allowed: {
      origin: ORIGIN,
      status: allowed.status,
      allowOrigin: allowed.headers['Access-Control-Allow-Origin'] || null,
      allowHeaders: allowed.headers['Access-Control-Allow-Headers'] || null,
    },
    denied: { origin: 'http://not-allowed.example', status: denied.status, allowOrigin: denied.headers['Access-Control-Allow-Origin'] || null },
  }
  const ok = d.allowed.status === 200 && d.allowed.allowOrigin === ORIGIN &&
    /x-request-id/i.test(d.allowed.allowHeaders || '') && d.denied.status === 403
  emit(checkPoint, ok ? 1 : 0, { case: CASE, check: 'cors' }, requestId(), d)
  console.log(`cors allowed=${d.allowed.status} allowOrigin=${d.allowed.allowOrigin} denied=${d.denied.status}`)
}

export function setup() {
  return { barrierAt: BARRIER_MS > 0 ? Date.now() + BARRIER_MS : null }
}

export default function (data) {
  if (KIND === 'cors') return corsOnce()
  if (data.barrierAt && exec.vu.iterationInScenario === WARMUP) {
    const wait = data.barrierAt - Date.now()
    if (wait > 0) sleep(wait / 1000)
  }
  if (CHECK_GZIP && exec.vu.idInTest === 1 && exec.vu.iterationInScenario === 0) checkGzip()
  streamOnce()
}
