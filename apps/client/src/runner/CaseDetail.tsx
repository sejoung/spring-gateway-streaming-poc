import { useEffect, useMemo, useState } from 'react'
import { api, type CaseResult, type Catalog, type RequestRecord } from './api'
import { BACKEND_OUTCOME_LABEL, OUTCOME_LABEL, caseState, explanationFor, ms, scenarioById, statsText, targetById } from './format'

interface Props {
  catalog: Catalog
  runId: string
  result: CaseResult
  running: boolean
  onClose: () => void
  onRerun: (caseId: string) => void
}

const PAGE = 200

export default function CaseDetail({ catalog, runId, result, running, onClose, onRerun }: Props) {
  const scenario = scenarioById(catalog, result.scenarioId)
  const target = targetById(catalog, result.targetId)
  const state = caseState(result)
  const ex = explanationFor(scenario, target)
  const m = result.metrics ?? {}

  const [requests, setRequests] = useState<RequestRecord[] | null>(null)
  const [requestError, setRequestError] = useState<string | null>(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [selected, setSelected] = useState<RequestRecord | null>(null)
  const [log, setLog] = useState<string | null>(null)

  useEffect(() => {
    if (result.status !== 'done') return
    let cancelled = false
    setRequests(null)
    setSelected(null)
    api.requests(runId, result.id)
      .then((list) => !cancelled && setRequests(list))
      .catch((e: Error) => !cancelled && setRequestError(e.message))
    return () => {
      cancelled = true
    }
  }, [runId, result.id, result.status])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const shown = useMemo(() => {
    const list = (requests ?? []).filter((r) => !onlyProblems || !['complete', 'aborted'].includes(r.outcome) || r.backendOutcome === 'COMPLETED')
    return list.slice(0, PAGE)
  }, [requests, onlyProblems])

  async function openRequest(r: RequestRecord) {
    setSelected(await api.request(runId, result.id, r.rid))
  }

  async function toggleLog() {
    if (log !== null) return setLog(null)
    setLog(await api.log(runId, result.id).catch((e: Error) => e.message))
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="eyebrow">
              {scenario.tid} · {target.label}
            </div>
            <h2 id="detail-title">
              {scenario.no}. {scenario.title} <span className={`chip ${state.tone}`}>{state.text}</span>
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </header>

        <section className="detail-block">
          <dl className="why">
            <dt>판정 기준</dt>
            <dd>{scenario.criterion}</dd>
            <dt>판정 근거</dt>
            <dd>{result.reason ?? '아직 판정되지 않았습니다'}</dd>
            {result.verdict === 'fail' && ex && (
              <>
                <dt>왜</dt>
                <dd>{ex.why}</dd>
                <dt>해결</dt>
                <dd>{ex.fix}</dd>
              </>
            )}
            {result.expected === 'fail' && (
              <>
                <dt>참고</dt>
                <dd>설정 함정 확인용 구성입니다. 실패가 예상된 결과입니다.</dd>
              </>
            )}
            <dt>대상</dt>
            <dd>{target.description}</dd>
          </dl>
          <div className="actions">
            <button onClick={() => onRerun(result.id)} disabled={running}>
              이 건만 다시 실행
            </button>
            <a className="button secondary" href={api.rawUrl(runId, result.id)}>
              k6 원시 데이터 받기
            </a>
            <button className="secondary" onClick={toggleLog}>
              {log === null ? 'k6 로그 보기' : 'k6 로그 닫기'}
            </button>
          </div>
          {log !== null && <pre className="log">{log || '로그가 비어 있습니다'}</pre>}
        </section>

        {result.status === 'done' && m.requests != null && (
          <section className="detail-block">
            <h3>측정값</h3>
            <div className="table-wrap">
              <table className="kv">
                <tbody>
                  <tr><th>측정한 요청</th><td>{m.requests}건{m.warmupRequests ? ` (워밍업 ${m.warmupRequests}건 제외)` : ''}</td></tr>
                  <tr><th>결과</th><td>{Object.entries(m.outcomes ?? {}).map(([k, n]) => `${OUTCOME_LABEL[k] ?? k} ${n}`).join(', ')}</td></tr>
                  <tr><th>첫 토큰 p50 / p95 / 최대</th><td>{statsText(m.ttfeMs)}</td></tr>
                  <tr><th>응답 완료 p50 / p95 / 최대</th><td>{statsText(m.totalMs)}</td></tr>
                  <tr><th>토큰 간격 p50 / p95 / 최대</th><td>{statsText(m.gapMs)}</td></tr>
                  <tr><th>지연(lag) p50 / p95 / 최대</th><td>{statsText(m.lagMs)}</td></tr>
                  {m.cancelPropagationMs && <tr><th>중단 → Backend 종료</th><td>{statsText(m.cancelPropagationMs)} (취소됐는지, 끝까지 생성했는지는 아래 요청별 기록의 Backend 열)</td></tr>}
                  {m.eventsAfterAbort && <tr><th>중단 후 생성된 토큰</th><td>최대 {m.eventsAfterAbort.max}개</td></tr>}
                  {result.resources && (
                    <tr>
                      <th>Gateway 리소스</th>
                      <td>
                        CPU 평균 {result.resources.cpuAvgPct ?? '-'}% / 최대 {result.resources.cpuMaxPct ?? '-'}%, 힙+비힙 최대 {result.resources.memMaxMb ?? '-'}MB, 스레드 최대 {result.resources.threadsMax ?? '-'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="caption">지연(lag)은 클라이언트 수신 시각에서 Backend가 토큰에 기록한 생성 시각을 뺀 값입니다. CPU는 JVM이 보는 전체 코어 대비 비율입니다.</p>
          </section>
        )}

        {result.status === 'done' && (
          <section className="detail-block">
            <div className="section-head row">
              <h3>요청별 기록</h3>
              <label className="check">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> 문제 있는 요청만
              </label>
            </div>
            {requestError && <p className="error">{requestError}</p>}
            {!requests && !requestError && <p className="muted">불러오는 중…</p>}
            {requests && (
              <>
                <p className="caption">
                  {requests.length}건 중 {shown.length}건 표시. 행을 누르면 토큰별 타임라인을 봅니다.
                </p>
                <div className="table-wrap tall">
                  <table className="requests">
                    <thead>
                      <tr>
                        <th>요청 ID</th>
                        {result.subrunCount && result.subrunCount > 1 ? <th>회차</th> : null}
                        <th>상태</th>
                        <th>결과</th>
                        <th>토큰</th>
                        <th>첫 토큰</th>
                        <th>전체</th>
                        {scenario.judge === 'cancel' && <th>Backend</th>}
                        {scenario.judge === 'cancel' && <th>종료까지</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => (
                        <tr key={r.rid} className={`clickable ${selected?.rid === r.rid ? 'selected' : ''}`} onClick={() => openRequest(r)}>
                          <td className="mono">
                            {r.rid}
                            {r.warmup && <span className="chip queued">워밍업</span>}
                          </td>
                          {result.subrunCount && result.subrunCount > 1 ? <td>{r.subLabel ?? r.sub + 1}</td> : null}
                          <td>{r.status || '-'}</td>
                          <td>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</td>
                          <td>{r.tokens}</td>
                          <td>{ms(r.ttfeMs)}</td>
                          <td>{ms(r.totalMs)}</td>
                          {scenario.judge === 'cancel' && <td>{BACKEND_OUTCOME_LABEL[r.backendOutcome ?? ''] ?? r.backendOutcome}</td>}
                          {scenario.judge === 'cancel' && <td>{ms(r.cancelPropagationMs)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        )}

        {selected && <Timeline record={selected} />}
      </div>
    </div>
  )
}

function Timeline({ record }: { record: RequestRecord }) {
  let prev: number | null = null
  return (
    <section className="detail-block">
      <h3>
        타임라인 <span className="mono muted">{record.rid}</span>
      </h3>
      <dl className="why compact">
        <dt>응답 헤더</dt>
        <dd>
          {record.headersMs != null ? `${ms(record.headersMs)}에 도착` : '받지 못함'} · HTTP {record.status || '-'} · {record.contentType ?? 'Content-Type 없음'}
        </dd>
        <dt>결과</dt>
        <dd>
          {OUTCOME_LABEL[record.outcome] ?? record.outcome} · 토큰 {record.tokens}개 · done {record.sawDone ? '받음' : '못 받음'} · {ms(record.totalMs)}
          {record.error && <div className="error">{record.error}</div>}
        </dd>
        {record.abortedAtMs != null && (
          <>
            <dt>중단</dt>
            <dd>
              {ms(record.abortedAtMs)}에 클라이언트가 연결을 끊음 → Backend {BACKEND_OUTCOME_LABEL[record.backendOutcome ?? ''] ?? record.backendOutcome}
              {record.cancelPropagationMs != null && `, 끊은 뒤 ${ms(record.cancelPropagationMs)}`}
              {record.eventsAfterAbort != null && `, 그 사이 토큰 ${record.eventsAfterAbort}개 더 생성`}
            </dd>
          </>
        )}
      </dl>
      {record.events && record.events.length > 0 ? (
        <div className="table-wrap tall">
          <table className="requests">
            <thead>
              <tr>
                <th>이벤트</th>
                <th>수신 (요청 시작 기준)</th>
                <th>이전 토큰과 간격</th>
                <th>지연(lag)</th>
              </tr>
            </thead>
            <tbody>
              {record.events.map(([idx, at, lag]) => {
                const gap = prev === null ? null : at - prev
                prev = at
                return (
                  <tr key={`${idx}-${at}`}>
                    <td>{idx === 'done' ? 'done' : `token #${idx}`}</td>
                    <td>{ms(at)}</td>
                    <td>{gap === null ? '-' : ms(gap)}</td>
                    <td>{lag == null ? '-' : ms(lag)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">받은 이벤트가 없습니다.</p>
      )}
    </section>
  )
}
