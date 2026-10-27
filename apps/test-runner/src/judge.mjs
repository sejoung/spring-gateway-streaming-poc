// Turns the raw per-request records of one case into a verdict (pass/fail), a one-line reason
// in plain Korean, and the summary metrics shown next to it.

export function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const q = (p) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]
  return { n: v.length, min: v[0], p50: q(50), p95: q(95), max: v[v.length - 1] }
}

const ms = (n) => (n == null ? '-' : n >= 10000 ? `${(n / 1000).toFixed(1)}초` : `${Math.round(n)}ms`)

const OUTCOME_TEXT = {
  complete: '정상 완료',
  aborted: '중단',
  stream_error: '연결 오류',
  no_done: 'done 없이 종료',
  token_mismatch: '토큰 수 불일치',
  http_error: 'HTTP 오류',
  connect_error: '연결 실패',
}

function outcomeSummary(requests) {
  const counts = {}
  for (const r of requests) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
  return Object.entries(counts).map(([k, n]) => `${OUTCOME_TEXT[k] ?? k} ${n}`).join(', ')
}

/** Summary metrics for any stream case; warmup requests are excluded. */
export function summarize(requests) {
  const measured = requests.filter((r) => !r.warmup)
  const gaps = []
  const lags = []
  for (const r of measured) {
    let prev = null
    for (const [idx, at, lag] of r.events ?? []) {
      if (idx === 'done') continue
      if (prev !== null) gaps.push(at - prev)
      prev = at
      if (lag != null) lags.push(lag)
    }
  }
  const outcomes = {}
  for (const r of measured) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
  return {
    requests: measured.length,
    warmupRequests: requests.length - measured.length,
    outcomes,
    statuses: [...new Set(measured.map((r) => r.status))],
    ttfeMs: stats(measured.map((r) => r.ttfeMs)),
    totalMs: stats(measured.filter((r) => r.outcome === 'complete').map((r) => r.totalMs)),
    gapMs: stats(gaps),
    lagMs: stats(lags),
    cancelPropagationMs: stats(measured.map((r) => r.cancelPropagationMs)),
    eventsAfterAbort: stats(measured.map((r) => r.eventsAfterAbort)),
  }
}

const pass = (reason) => ({ verdict: 'pass', reason })
const fail = (reason) => ({ verdict: 'fail', reason })

function streamsBeforeEnd(requests) {
  // A buffering proxy delivers the first token only when the response completes.
  return requests.filter((r) => r.outcome === 'complete' && r.ttfeMs != null && r.ttfeMs < r.totalMs - 1000)
}

const judges = {
  normal(rs) {
    const ok = rs.filter((r) => r.status === 200 && r.outcome === 'complete' && r.inOrder &&
      (r.contentType ?? '').startsWith('text/event-stream') && r.cacheControl === 'no-cache')
    if (ok.length === rs.length) return pass(`${rs.length}/${rs.length}건이 200, text/event-stream, 토큰 ${rs[0].tokens}개 + done을 순서대로 받음`)
    const bad = rs.find((r) => !ok.includes(r))
    return fail(`${rs.length - ok.length}/${rs.length}건 실패. 예: status ${bad.status}, ${OUTCOME_TEXT[bad.outcome] ?? bad.outcome}, Content-Type ${bad.contentType}, Cache-Control ${bad.cacheControl}`)
  },

  buffering(rs) {
    const ok = streamsBeforeEnd(rs)
    const s = summarize(rs)
    const detail = `첫 토큰 p50 ${ms(s.ttfeMs?.p50)}, 응답 완료 p50 ${ms(s.totalMs?.p50)}`
    return ok.length === rs.length ? pass(`${rs.length}/${rs.length}건 모두 응답 완료 전에 첫 토큰 도착 (${detail})`)
      : fail(`${rs.length - ok.length}/${rs.length}건은 응답이 끝날 무렵에야 첫 토큰이 도착 (${detail})`)
  },

  latency(rs, ctx) {
    const s = summarize(rs)
    if (ctx.targetId === ctx.scenario.baseline) {
      return { verdict: 'baseline', reason: `기준값: 첫 토큰 p50 ${s.ttfeMs?.p50}ms (토큰 간격 0ms)` }
    }
    const base = ctx.baseline?.metrics?.ttfeMs?.p50
    if (base == null) return { verdict: 'error', reason: 'Backend 직접 기준값이 없어 비교하지 못했습니다' }
    const diff = s.ttfeMs.p50 - base
    const text = `첫 토큰 p50 ${s.ttfeMs.p50}ms, Backend 직접 ${base}ms 대비 ${diff >= 0 ? '+' : ''}${diff}ms`
    return diff <= 10 ? pass(text) : fail(text)
  },

  long(rs) {
    const r = rs[0]
    if (r.outcome === 'complete') return pass(`토큰 ${r.tokens}개 + done을 ${ms(r.totalMs)}에 모두 받음`)
    return fail(`토큰 ${r.tokens}개를 받고 ${ms(r.totalMs)}에 끊김 (${OUTCOME_TEXT[r.outcome] ?? r.outcome}${r.error ? `: ${r.error}` : ''})`)
  },

  connect(rs) {
    const ok = rs.filter((r) => r.status >= 500 && r.totalMs <= 3500)
    const times = rs.map((r) => `${r.status || '연결 실패'}/${ms(r.totalMs)}`).join(', ')
    return ok.length === rs.length ? pass(`${rs.length}건 모두 3.5초 안에 5xx 응답 (${times})`) : fail(`기대와 다른 응답 (${times})`)
  },

  firstToken(rs) {
    const r = rs[0]
    if (r.outcome === 'complete') return pass(`첫 토큰 ${ms(r.ttfeMs)}에 도착, 스트림 유지 후 done 수신`)
    if (r.status !== 200) return fail(`${ms(r.totalMs)}에 HTTP ${r.status} 반환. 첫 토큰을 기다리지 못함`)
    return fail(`${OUTCOME_TEXT[r.outcome] ?? r.outcome} (${ms(r.totalMs)})`)
  },

  cancel(rs) {
    const cancelled = rs.filter((r) => r.backendOutcome === 'CANCELLED' && r.cancelPropagationMs <= 1000)
    const s = summarize(rs)
    if (cancelled.length === rs.length) {
      return pass(`${rs.length}/${rs.length}건 모두 Backend가 취소됨. 중단 후 최대 ${ms(s.cancelPropagationMs?.max)}, 그 사이 생성된 토큰 최대 ${s.eventsAfterAbort?.max ?? 0}개`)
    }
    const completed = rs.filter((r) => r.backendOutcome === 'COMPLETED')
    if (completed.length) {
      return fail(`${completed.length}/${rs.length}건은 클라이언트가 끊은 뒤에도 Backend가 끝까지 생성하고 정상 종료 (중단 후 토큰 ${s.eventsAfterAbort?.max}개 더 생성)`)
    }
    const slow = rs.filter((r) => r.backendOutcome === 'CANCELLED' && r.cancelPropagationMs > 1000)
    if (slow.length) return fail(`${slow.length}/${rs.length}건은 취소까지 1초 넘게 걸림 (최대 ${ms(s.cancelPropagationMs?.max)})`)
    return fail(`Backend 결과: ${[...new Set(rs.map((r) => r.backendOutcome))].join(', ')}`)
  },

  beforeHeaders(rs) {
    const r = rs[0]
    return r.status === 500 ? pass('Backend의 500을 그대로 받음') : fail(`HTTP ${r.status}, ${OUTCOME_TEXT[r.outcome] ?? r.outcome}`)
  },

  midStream(rs) {
    const r = rs[0]
    if (r.outcome === 'stream_error') return pass(`토큰 ${r.tokens}개 후 연결 오류 감지 (${r.error})`)
    if (r.outcome === 'no_done') return fail(`토큰 ${r.tokens}개 후 오류 없이 정상 종료처럼 닫힘 (done 이벤트 없음)`)
    return fail(`${OUTCOME_TEXT[r.outcome] ?? r.outcome}`)
  },

  concurrency(rs) {
    const s = summarize(rs)
    const done = rs.filter((r) => r.outcome === 'complete').length
    const text = `${done}/${rs.length}건 완료, 첫 토큰 p95 ${ms(s.ttfeMs?.p95)} (최대 ${ms(s.ttfeMs?.max)})`
    if (done !== rs.length) {
      const failed = rs.filter((r) => r.outcome !== 'complete')
      const sample = failed.find((r) => r.error)
      return fail(`${text}. 실패: ${outcomeSummary(failed)}${sample ? ` (예: 토큰 ${sample.tokens}개 후 ${sample.error})` : ''}`)
    }
    if (s.ttfeMs.p95 > 500) return fail(`${text}. p95 기준 0.5초 초과`)
    if (s.ttfeMs.max > 1000) {
      const late = rs.filter((r) => r.ttfeMs > 1000).length
      return fail(`${text}. ${late}건이 1초 넘게 늦음 (최대 기준 1초 초과)`)
    }
    return pass(text)
  },

  stability(rs, ctx) {
    const rates = ctx.subruns.map((sub) => {
      const m = sub.requests.filter((r) => !r.warmup)
      return m.length ? (100 * m.filter((r) => r.outcome === 'complete').length) / m.length : 0
    })
    const text = `${rates.length}회 완료율: ${rates.map((r) => `${r.toFixed(1)}%`).join(', ')}`
    return rates.every((r) => r >= 99) ? pass(text) : fail(text)
  },

  cors(rs, ctx) {
    const c = ctx.checks.find((x) => x.check === 'cors')
    if (!c) return { verdict: 'error', reason: 'CORS 검사 결과가 없습니다' }
    const d = c.detail
    const text = `허용 Origin ${d.allowed.status} (Allow-Origin ${d.allowed.allowOrigin ?? '없음'}), 다른 Origin ${d.denied.status}`
    return c.value === 1 ? pass(text) : fail(text)
  },

  gzip(rs, ctx) {
    const c = ctx.checks.find((x) => x.check === 'gzip')
    const encoding = c?.detail?.contentEncoding
    const ok = streamsBeforeEnd(rs)
    const s = summarize(rs)
    if (encoding !== 'gzip') return fail(`응답이 gzip으로 압축되지 않아 판정할 수 없음 (Content-Encoding: ${encoding ?? '없음'})`)
    const text = `Content-Encoding: gzip 확인. 첫 토큰 p50 ${ms(s.ttfeMs?.p50)}, 응답 완료 p50 ${ms(s.totalMs?.p50)}`
    return ok.length === rs.length ? pass(text) : fail(`${rs.length - ok.length}/${rs.length}건 버퍼링됨. ${text}`)
  },

  nginx(rs, ctx) {
    const parts = ctx.subruns.map((sub) => {
      const m = sub.requests.filter((r) => !r.warmup)
      const ok = streamsBeforeEnd(m).length === m.length && m.length > 0
      return { label: sub.label, ok, ttfe: stats(m.map((r) => r.ttfeMs))?.p50 }
    })
    const text = parts.map((p) => `${p.label} ${p.ok ? '통과' : '버퍼링'} (첫 토큰 p50 ${ms(p.ttfe)})`).join(', ')
    return parts.every((p) => p.ok) ? pass(text) : fail(text)
  },
}

/**
 * @param scenario catalog scenario
 * @param subruns  [{ label, requests: [...], checks: [...] }]
 * @param ctx      { targetId, baseline } baseline = case result of the scenario's baseline target
 */
export function judgeCase(scenario, subruns, ctx) {
  const requests = subruns.flatMap((s) => s.requests)
  const checks = subruns.flatMap((s) => s.checks)
  const measured = requests.filter((r) => !r.warmup)
  const metrics = scenario.kind === 'cors' ? {} : summarize(requests)
  if (scenario.kind !== 'cors' && !measured.length) {
    return { verdict: 'error', reason: '측정된 요청이 없습니다. k6 로그를 확인하세요', metrics }
  }
  const result = judges[scenario.judge](measured, { ...ctx, scenario, subruns, checks })
  return { ...result, metrics }
}
