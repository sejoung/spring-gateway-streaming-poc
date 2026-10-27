import type { CaseResult, Catalog, Run } from './api'
import { caseState, explanationFor, scenarioById, targetById } from './format'

interface Props {
  catalog: Catalog
  run: Run
  onOpen: (caseId: string) => void
}

export default function Report({ catalog, run, onOpen }: Props) {
  const byId = new Map(run.cases.map((c) => [c.id, c]))
  const get = (scenarioId: string, targetId: string) => byId.get(`${scenarioId}.${targetId}`)
  const pitfallCases = catalog.pitfalls.map((p) => ({ pitfall: p, result: get(p.scenario, p.target) })).filter((x) => x.result)
  const failures = run.cases.filter((c) => c.status === 'done' && c.verdict === 'fail' && !targetById(catalog, c.targetId).pitfall)

  return (
    <div className="report">
      <Glance catalog={catalog} run={run} />

      <section className="panel">
        <div className="section-head">
          <h2>판정표</h2>
          <p className="muted">칸을 누르면 그 건의 판정 근거, 요청별 기록, k6 원시 데이터를 볼 수 있습니다.</p>
        </div>
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th>시나리오와 판정 기준</th>
                {catalog.mainTargets.map((t) => (
                  <th key={t}>{targetById(catalog, t).label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {catalog.scenarios.map((s) => (
                <tr key={s.id}>
                  <td className="scenario-cell">
                    <div>
                      <b>
                        {s.no}. {s.title}
                      </b>{' '}
                      <span className="tid">{s.tid}</span>
                    </div>
                    <div className="crit">{s.criterion}</div>
                  </td>
                  {catalog.mainTargets.map((t) => {
                    if (!s.targets.includes(t)) return <td key={t} className="cell none">—</td>
                    return <Cell key={t} result={get(s.id, t)} onOpen={onOpen} />
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {failures.length > 0 && (
        <section className="panel">
          <div className="section-head">
            <h2>실패한 항목</h2>
            <p className="muted">실패마다 무엇이 일어났는지, 왜 그런지, 어떻게 해결하는지 정리했습니다.</p>
          </div>
          <div className="failures">
            {failures.map((c) => {
              const s = scenarioById(catalog, c.scenarioId)
              const target = targetById(catalog, c.targetId)
              const ex = explanationFor(s, target)
              return (
                <article key={c.id} className="failure">
                  <h3>
                    <span className="chip fail">{target.label}</span> {s.no}. {s.title}
                  </h3>
                  <dl className="why">
                    <dt>결과</dt>
                    <dd>{c.reason}</dd>
                    {ex && (
                      <>
                        <dt>왜</dt>
                        <dd>{ex.why}</dd>
                        <dt>해결</dt>
                        <dd>{ex.fix}</dd>
                      </>
                    )}
                  </dl>
                  <button className="link" onClick={() => onOpen(c.id)}>
                    상세 기록 보기
                  </button>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {pitfallCases.length > 0 && (
        <section className="panel">
          <div className="section-head">
            <h2>설정을 잘못하면 실패하는 항목</h2>
            <p className="muted">흔히 쓰는 설정으로 바꿨을 때 실제로 실패하는지 확인합니다. 실패가 나와야 예상대로입니다.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>설정</th>
                  <th>확인한 시나리오</th>
                  <th>결과</th>
                  <th>이유</th>
                </tr>
              </thead>
              <tbody>
                {pitfallCases.map(({ pitfall, result }) => {
                  const s = scenarioById(catalog, pitfall.scenario)
                  const target = targetById(catalog, pitfall.target)
                  const state = caseState(result)
                  const matched = result?.status === 'done' && result.verdict === 'fail'
                  const unexpected = result?.status === 'done' && result.verdict === 'pass'
                  return (
                    <tr key={pitfall.id} className="clickable" onClick={() => onOpen(result!.id)}>
                      <td>
                        <b>{target.label}</b>
                        <div className="crit">{target.description}</div>
                      </td>
                      <td className="wrap">
                        {s.no}. {s.title}
                      </td>
                      <td>
                        <span className={`chip ${state.tone}`}>{state.text}</span>
                        {matched && <div className="crit">예상대로</div>}
                        {unexpected && <div className="crit warn-text">예상과 다름</div>}
                      </td>
                      <td className="wrap">
                        {pitfall.why}
                        {result?.reason && <div className="crit">{result.reason}</div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

function Cell({ result, onOpen }: { result: CaseResult | undefined; onOpen: (id: string) => void }) {
  const state = caseState(result)
  if (!result) return <td className="cell none">—</td>
  return (
    <td className={`cell ${state.tone}`}>
      <button className="cell-button" onClick={() => onOpen(result.id)} title={result.reason ?? state.text}>
        {state.text}
      </button>
    </td>
  )
}

function Glance({ catalog, run }: { catalog: Catalog; run: Run }) {
  const counts = run.summary.byTarget
  return (
    <section className="glance">
      {catalog.mainTargets.map((t) => {
        const target = targetById(catalog, t)
        const c = counts[t]
        if (!c) return null
        const total = c.pass + c.fail + c.error + c.baseline + c.pending
        if (!total) return null
        return (
          <div key={t} className="score">
            <div className="score-name">{target.label}</div>
            <div className="score-counts">
              <span className="n-pass">성공 {c.pass}</span>
              <span className="n-fail">실패 {c.fail}</span>
              {c.error > 0 && <span className="n-error">측정 불가 {c.error}</span>}
              {c.pending > 0 && <span className="n-muted">대기 {c.pending}</span>}
            </div>
            <p>{target.description}</p>
          </div>
        )
      })}
    </section>
  )
}
