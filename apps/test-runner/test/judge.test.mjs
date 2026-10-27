import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planCases, scenarioById } from '../src/catalog.mjs'
import { judgeCase, stats } from '../src/judge.mjs'

const tokens = (n, delay = 200, lag = 1) => Array.from({ length: n }, (_, i) => [i, 200 + i * delay, lag])

function request(overrides = {}) {
  return {
    rid: 'r', warmup: false, status: 200, outcome: 'complete', error: null, headersMs: 200, ttfeMs: 200,
    totalMs: 2050, tokens: 10, inOrder: true, sawDone: true, contentType: 'text/event-stream;charset=UTF-8',
    cacheControl: 'no-cache', events: [...tokens(10), ['done', 2050, null]], ...overrides,
  }
}

const judge = (sid, requests, ctx = {}, checks = []) =>
  judgeCase(scenarioById(sid), [{ label: null, requests, checks }], { targetId: 'mvc', ...ctx })

test('stats uses nearest-rank percentiles', () => {
  assert.deepEqual(stats([5, 1, 4, 2, 3]), { n: 5, min: 1, p50: 3, p95: 5, max: 5 })
  assert.equal(stats([]), null)
})

test('normal passes only with SSE headers and ordered tokens', () => {
  assert.equal(judge('s01', [request()]).verdict, 'pass')
  assert.equal(judge('s01', [request({ cacheControl: null })]).verdict, 'fail')
  assert.equal(judge('s01', [request({ inOrder: false })]).verdict, 'fail')
})

test('buffering fails when the first token arrives with the end of the response', () => {
  assert.equal(judge('s02', [request()]).verdict, 'pass')
  assert.equal(judge('s02', [request({ ttfeMs: 2040 })]).verdict, 'fail')
})

test('warmup requests are not judged', () => {
  const result = judge('s02', [request({ warmup: true, ttfeMs: 2040 }), request()])
  assert.equal(result.verdict, 'pass')
  assert.equal(result.metrics.requests, 1)
  assert.equal(result.metrics.warmupRequests, 1)
})

test('latency compares against the baseline case', () => {
  const baseline = { metrics: { ttfeMs: { p50: 2 } } }
  assert.equal(judge('s03', [request({ ttfeMs: 3 })], { baseline }).verdict, 'pass')
  assert.equal(judge('s03', [request({ ttfeMs: 30 })], { baseline }).verdict, 'fail')
  assert.equal(judge('s03', [request({ ttfeMs: 2 })], { targetId: 'direct' }).verdict, 'baseline')
})

test('cancel fails when the backend finishes the stream after the abort', () => {
  const aborted = { outcome: 'aborted', tokens: 3, events: tokens(3) }
  assert.equal(judge('s07', [request({ ...aborted, backendOutcome: 'CANCELLED', cancelPropagationMs: 210, eventsAfterAbort: 1 })]).verdict, 'pass')
  const drained = judge('s07', [request({ ...aborted, backendOutcome: 'COMPLETED', cancelPropagationMs: 9600, eventsAfterAbort: 47 })])
  assert.equal(drained.verdict, 'fail')
  assert.match(drained.reason, /끝까지 생성/)
})

test('mid-stream error must surface as a connection error', () => {
  assert.equal(judge('s09', [request({ outcome: 'stream_error', tokens: 5, error: 'unexpected EOF' })]).verdict, 'pass')
  assert.equal(judge('s09', [request({ outcome: 'no_done', tokens: 5, sawDone: false })]).verdict, 'fail')
})

test('concurrency fails on a slow tail even when p95 is fine', () => {
  const fast = Array.from({ length: 99 }, () => request({ ttfeMs: 250 }))
  assert.equal(judge('s12', fast).verdict, 'pass')
  const result = judge('s12', [...fast, request({ ttfeMs: 1260 })])
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /1건이 1초 넘게/)
})

test('first token delay fails on a gateway timeout', () => {
  assert.equal(judge('s06', [request({ status: 504, outcome: 'http_error', ttfeMs: null, totalMs: 10050 })]).verdict, 'fail')
})

test('gzip needs a compressed response before judging delivery', () => {
  assert.equal(judge('s15', [request()], {}, [{ check: 'gzip', value: 1, detail: { contentEncoding: 'gzip' } }]).verdict, 'pass')
  assert.equal(judge('s15', [request()], {}, [{ check: 'gzip', value: 0, detail: { contentEncoding: null } }]).verdict, 'fail')
})

test('custom plans add the baseline and run it first', () => {
  assert.deepEqual(planCases('custom', ['s03.mvc']).map((c) => c.id), ['s03.direct', 's03.mvc'])
  assert.deepEqual(planCases('custom', ['nope.mvc', 's01.unknown']), [])
})

test('full plan covers every scenario target plus the pitfalls', () => {
  const ids = planCases('full').map((c) => c.id)
  assert.ok(ids.includes('s16.webflux'))
  assert.ok(ids.includes('s07.pit-simple'))
  assert.equal(new Set(ids).size, ids.length)
})
