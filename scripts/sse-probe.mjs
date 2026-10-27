#!/usr/bin/env node
// SSE latency / concurrency / cancel probe (Node 18+, no dependencies).
//
// Measures per stream: TTFE, inter-event gap, total time, per-event lag (receive time - backend emittedAt,
// meaningful only when client and backend share a clock), and optionally cancel propagation by aborting
// after N events and reading the backend's /internal/streams/{requestId} record.
//
// Examples:
//   node scripts/sse-probe.mjs --target http://localhost:8080 --count 10 --delay 200 --repeat 5
//   node scripts/sse-probe.mjs --target http://localhost:8082 --concurrency 100 --pid 12345
//   node scripts/sse-probe.mjs --target http://localhost:8080 --count 100 --abort-after 3 --repeat 5
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: opt } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h', default: false },
    target: { type: 'string', default: 'http://localhost:8081' },
    backend: { type: 'string', default: 'http://localhost:8081' },
    label: { type: 'string' },
    message: { type: 'string', default: 'hello' },
    count: { type: 'string', default: '10' },
    delay: { type: 'string', default: '200' },
    'fail-mode': { type: 'string', default: 'NONE' },
    concurrency: { type: 'string', default: '1' },
    repeat: { type: 'string', default: '1' },
    warmup: { type: 'string', default: '0' },
    'abort-after': { type: 'string' },
    'cancel-wait': { type: 'string', default: '30000' },
    timeout: { type: 'string', default: '120000' },
    pid: { type: 'string' },
    actuator: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
})

if (opt.help) {
  const header = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1).filter((l) => l.startsWith('//'))
  console.log(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
  console.log(`
Options (defaults):
  --target URL           gateway or backend to stream from (http://localhost:8081)
  --backend URL          backend for /internal/streams lookups (http://localhost:8081)
  --label NAME           label in the output
  --count N --delay MS   tokens per stream and interval (10, 200)
  --fail-mode MODE       NONE | BEFORE_HEADERS | MID_STREAM
  --concurrency N        simultaneous streams per round (1)
  --repeat N --warmup N  measured / discarded rounds (1, 0)
  --abort-after N        abort each stream after N tokens and measure backend cancel propagation
  --cancel-wait MS       how long to wait for the backend to leave RUNNING (30000)
  --timeout MS           per-stream timeout (120000)
  --pid PID[,PID]        sample %cpu / RSS of these processes with ps
  --actuator URL         sample jvm.threads.live from this Spring Boot actuator
  --json                 print one JSON summary line`)
  process.exit(0)
}

const count = Number(opt.count)
const delayMs = Number(opt.delay)
const concurrency = Number(opt.concurrency)
const repeat = Number(opt.repeat)
const warmup = Number(opt.warmup)
const abortAfter = opt['abort-after'] != null ? Number(opt['abort-after']) : null
const label = opt.label ?? opt.target
const runId = Math.random().toString(36).slice(2, 8)

function parseSse(onEvent) {
  let buffer = ''
  let type = ''
  let data = []
  const dispatch = () => {
    if (data.length) onEvent({ event: type || 'message', data: data.join('\n') })
    type = ''
    data = []
  }
  return (chunk) => {
    buffer += chunk
    const lines = buffer.split(/\r\n|\r|\n/)
    buffer = lines.pop()
    for (const line of lines) {
      if (line === '') dispatch()
      else if (line.startsWith('event:')) type = line.slice(6).trimStart()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
  }
}

async function runStream(requestId) {
  const r = { requestId, ok: false, status: null, events: 0, tokens: 0, sawDone: false, gaps: [], lags: [] }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), Number(opt.timeout))
  const t0 = performance.now()
  let last = t0
  try {
    const res = await fetch(`${opt.target}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Request-Id': requestId },
      body: JSON.stringify({ message: opt.message, count, delayMs, failMode: opt['fail-mode'] }),
      signal: controller.signal,
    })
    r.status = res.status
    r.headersMs = performance.now() - t0
    r.contentType = res.headers.get('content-type')
    if (!res.ok) {
      r.error = `HTTP ${res.status}`
      await res.body?.cancel()
      return r
    }
    const push = parseSse((e) => {
      const now = performance.now()
      if (r.events === 0) r.ttfeMs = now - t0
      else if (e.event === 'token') r.gaps.push(now - last)
      last = now
      r.events++
      if (e.event === 'token') {
        r.tokens++
        r.lags.push(Date.now() - JSON.parse(e.data).emittedAt)
        if (abortAfter != null && r.tokens === abortAfter) {
          r.abortedAt = Date.now()
          controller.abort(new Error('probe abort'))
        }
      } else if (e.event === 'done') r.sawDone = true
    })
    const decoder = new TextDecoder()
    for await (const chunk of res.body) push(decoder.decode(chunk, { stream: true }))
    r.totalMs = performance.now() - t0
    r.ok = r.sawDone && r.tokens === count
    if (!r.ok) r.error = r.sawDone ? 'token count mismatch' : 'stream ended without done'
  } catch (e) {
    r.totalMs = performance.now() - t0
    if (r.abortedAt) r.ok = true
    else r.error = e.cause?.code ?? e.message
  } finally {
    clearTimeout(timer)
  }
  if (r.abortedAt) Object.assign(r, await awaitCancel(requestId, r.abortedAt))
  return r
}

/** Polls the backend stream record until it leaves RUNNING (or gives up). */
async function awaitCancel(requestId, abortedAt) {
  const deadline = Date.now() + Number(opt['cancel-wait'])
  for (;;) {
    const res = await fetch(`${opt.backend}/internal/streams/${requestId}`).catch(() => null)
    const rec = res?.ok ? await res.json() : null
    if (rec && rec.outcome !== 'RUNNING') {
      return {
        backendOutcome: rec.outcome,
        cancelPropagationMs: rec.finishedAt - abortedAt,
        eventsAfterAbort: rec.emittedEvents - abortAfter,
      }
    }
    if (Date.now() > deadline) {
      return { backendOutcome: 'STILL_RUNNING', cancelPropagationMs: null, eventsAfterAbort: rec ? rec.emittedEvents - abortAfter : null }
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function sampler() {
  const samples = []
  const pids = opt.pid ? opt.pid.split(',') : []
  if (!pids.length && !opt.actuator) return { stop: async () => null }
  let stopped = false
  const tick = async () => {
    const s = { t: Date.now() }
    if (pids.length) {
      const out = await new Promise((resolve) =>
        execFile('ps', ['-o', '%cpu=,rss=', '-p', pids.join(',')], (err, stdout) => resolve(err ? '' : stdout)),
      )
      const rows = out.trim().split('\n').filter(Boolean).map((l) => l.trim().split(/\s+/).map(Number))
      s.cpu = rows.reduce((a, [c]) => a + c, 0)
      s.rssMb = rows.reduce((a, [, rss]) => a + rss, 0) / 1024
    }
    if (opt.actuator) {
      const res = await fetch(`${opt.actuator}/actuator/metrics/jvm.threads.live`).catch(() => null)
      if (res?.ok) s.threads = (await res.json()).measurements[0].value
    }
    samples.push(s)
  }
  const loop = (async () => {
    while (!stopped) {
      await tick()
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  })()
  return {
    stop: async () => {
      stopped = true
      await loop
      const pick = (k) => samples.map((s) => s[k]).filter((v) => v != null)
      const cpu = pick('cpu')
      const rss = pick('rssMb')
      const threads = pick('threads')
      return {
        samples: samples.length,
        cpuAvgPct: cpu.length ? round(cpu.reduce((a, b) => a + b, 0) / cpu.length) : null,
        cpuMaxPct: cpu.length ? round(Math.max(...cpu)) : null,
        rssMaxMb: rss.length ? round(Math.max(...rss)) : null,
        threadsMax: threads.length ? Math.max(...threads) : null,
      }
    },
  }
}

const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d)

function stats(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b)
  if (!v.length) return null
  const q = (p) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]
  return { n: v.length, min: round(v[0]), p50: round(q(50)), p95: round(q(95)), p99: round(q(99)), max: round(v[v.length - 1]) }
}

async function round_(n, measured) {
  const ids = Array.from({ length: concurrency }, (_, i) => `probe-${runId}-${measured ? 'm' : 'w'}${n}-${i}`)
  return Promise.all(ids.map(runStream))
}

for (let i = 0; i < warmup; i++) await round_(i, false)

const resources = sampler()
const startedAt = Date.now()
const results = []
for (let i = 0; i < repeat; i++) results.push(...(await round_(i, true)))
const wallMs = Date.now() - startedAt
const res = await resources.stop()

const errors = {}
for (const r of results.filter((r) => !r.ok)) errors[r.error] = (errors[r.error] ?? 0) + 1

const summary = {
  label,
  target: opt.target,
  params: { count, delayMs, failMode: opt['fail-mode'], concurrency, repeat, warmup, abortAfter },
  streams: results.length,
  successRate: round((100 * results.filter((r) => r.ok).length) / results.length),
  errors,
  statuses: [...new Set(results.map((r) => r.status))],
  headersMs: stats(results.map((r) => r.headersMs)),
  ttfeMs: stats(results.map((r) => r.ttfeMs)),
  gapMs: stats(results.flatMap((r) => r.gaps)),
  lagMs: stats(results.flatMap((r) => r.lags)),
  totalMs: stats(results.filter((r) => r.ok && !r.abortedAt).map((r) => r.totalMs)),
  wallMs,
  resources: res,
}
if (abortAfter != null) {
  summary.cancel = {
    outcomes: results.reduce((acc, r) => ({ ...acc, [r.backendOutcome]: (acc[r.backendOutcome] ?? 0) + 1 }), {}),
    propagationMs: stats(results.map((r) => r.cancelPropagationMs)),
    eventsAfterAbort: stats(results.map((r) => r.eventsAfterAbort)),
  }
}

if (opt.json) {
  console.log(JSON.stringify(summary))
} else {
  const fmt = (s) => (s ? `p50=${s.p50} p95=${s.p95} max=${s.max} (n=${s.n})` : '-')
  console.log(`== ${label}  [${opt.target}]  count=${count} delayMs=${delayMs} concurrency=${concurrency} repeat=${repeat}`)
  console.log(`  success      ${summary.successRate}% of ${summary.streams}  statuses=${summary.statuses}  errors=${JSON.stringify(errors)}`)
  console.log(`  headers ms   ${fmt(summary.headersMs)}`)
  console.log(`  TTFE ms      ${fmt(summary.ttfeMs)}`)
  console.log(`  gap ms       ${fmt(summary.gapMs)}`)
  console.log(`  lag ms       ${fmt(summary.lagMs)}`)
  console.log(`  total ms     ${fmt(summary.totalMs)}`)
  if (summary.cancel) {
    console.log(`  cancel       outcomes=${JSON.stringify(summary.cancel.outcomes)}`)
    console.log(`  cancel ms    ${fmt(summary.cancel.propagationMs)}`)
    console.log(`  events after abort ${fmt(summary.cancel.eventsAfterAbort)}`)
  }
  if (res) console.log(`  resources    ${JSON.stringify(res)}`)
}
