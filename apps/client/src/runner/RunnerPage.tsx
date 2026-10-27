import { useCallback, useEffect, useRef, useState } from 'react'
import CaseDetail from './CaseDetail'
import Report from './Report'
import { api, type Catalog, type Health, type LogEntry, type Run, type RunListItem, type RunMode } from './api'
import { MODE_LABEL, dateTime, duration, scenarioById, targetById } from './format'

const MAX_LOG = 300

/** ?run=<id>&case=<caseId> makes a run (and an opened case) shareable as a link. */
function readLink() {
  const params = new URLSearchParams(location.search)
  return { run: params.get('run'), case: params.get('case') }
}

function writeLink(runId: string | null, caseId: string | null) {
  const params = new URLSearchParams()
  if (runId) params.set('run', runId)
  if (caseId) params.set('case', caseId)
  const query = params.toString()
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
}

export default function RunnerPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [runnerDown, setRunnerDown] = useState(false)
  const [runs, setRuns] = useState<RunListItem[]>([])
  const [run, setRun] = useState<Run | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const [openCase, setOpenCase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showLog, setShowLog] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)

  const refreshRuns = useCallback(async () => {
    const list = await api.runs()
    setRuns(list)
    return list
  }, [])

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => setRunnerDown(true))
    const link = readLink()
    refreshRuns()
      .then(async (list) => {
        const wanted = list.find((r) => r.id === link.run) ?? list[0]
        if (!wanted) return
        await selectRun(wanted.id)
        if (wanted.id === link.run && link.case) setOpenCase(link.case)
      })
      .catch(() => setRunnerDown(true))
    const poll = async () => {
      try {
        setHealth(await api.health())
        setRunnerDown(false)
      } catch {
        setRunnerDown(true)
      }
    }
    poll()
    const timer = setInterval(poll, 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live updates for the selected run while it is running.
  useEffect(() => {
    if (!run || run.status !== 'running') return
    const source = new EventSource(api.eventsUrl(run.id))
    source.addEventListener('snapshot', (e) => {
      const snap = JSON.parse((e as MessageEvent).data) as Run
      setRun(snap)
      setLog(snap.log ?? [])
    })
    source.addEventListener('case', (e) => {
      const { case: c, summary } = JSON.parse((e as MessageEvent).data)
      setRun((prev) => (prev ? { ...prev, summary, cases: prev.cases.map((x) => (x.id === c.id ? c : x)) } : prev))
    })
    source.addEventListener('log', (e) => {
      const entry = JSON.parse((e as MessageEvent).data) as LogEntry
      setLog((prev) => (prev.length >= MAX_LOG ? [...prev.slice(-MAX_LOG + 1), entry] : [...prev, entry]))
    })
    source.addEventListener('end', () => {
      source.close()
      api.run(run.id).then(setRun)
      refreshRuns()
    })
    return () => source.close()
    // Reconnect only when a different run is selected or it starts running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.status === 'running'])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  useEffect(() => {
    if (run) writeLink(run.id, openCase)
  }, [run?.id, openCase]) // eslint-disable-line react-hooks/exhaustive-deps

  async function selectRun(id: string) {
    setOpenCase(null)
    const r = await api.run(id)
    setRun(r)
    setLog(r.log ?? [])
    setShowLog(r.status === 'running')
  }

  async function start(mode: RunMode, cases: string[] = []) {
    setError(null)
    try {
      const { id } = await api.start(mode, cases)
      setOpenCase(null)
      await refreshRuns()
      await selectRun(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const running = !!health?.running || run?.status === 'running'
  const doneCount = run?.cases.filter((c) => c.status === 'done' || c.status === 'skipped').length ?? 0
  const current = run?.cases.find((c) => c.status === 'running')
  const downTargets = catalog && health ? catalog.targets.filter((t) => health.targets[t.id] === false) : []
  const openResult = run && openCase ? run.cases.find((c) => c.id === openCase) : undefined

  if (runnerDown && !catalog) {
    return (
      <div className="page">
        <section className="panel notice">
          <h2>테스트 실행기에 연결할 수 없습니다</h2>
          <p>
            저장소 루트에서 <code>docker compose up --build</code>로 전체 구성을 띄운 뒤 이 페이지를 새로고침하세요. 개발 서버(<code>npm run dev</code>)로 볼 때는 실행기가{' '}
            <code>localhost:8070</code>에 떠 있어야 합니다.
          </p>
        </section>
      </div>
    )
  }
  if (!catalog) return <div className="page muted">불러오는 중…</div>

  return (
    <div className="page">
      <section className="panel controls-bar">
        <div className="control-row">
          <div className="buttons">
            <button onClick={() => start('full')} disabled={running}>
              전체 실행 <span className="hint">판정표 16개 + 설정 함정 6개 · 약 12분</span>
            </button>
            <button className="secondary" onClick={() => start('quick')} disabled={running}>
              빠른 실행 <span className="hint">핵심 7개 · 약 1.5분</span>
            </button>
            {running && run?.status === 'running' && (
              <button className="danger" onClick={() => api.stop(run.id)}>
                중지
              </button>
            )}
          </div>
          {runs.length > 0 && (
            <label className="run-select">
              <span>실행 기록</span>
              <select id="run-select" value={run?.id ?? ''} onChange={(e) => selectRun(e.target.value)}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {dateTime(r.startedAt)} · {MODE_LABEL[r.mode]} · {statusText(r.status)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <Services catalog={catalog} health={health} />
        {downTargets.length > 0 && (
          <p className="warn-text">
            응답하지 않는 서비스가 있습니다: {downTargets.map((t) => t.label).join(', ')}. 이 서비스의 케이스는 "측정 불가"로 표시됩니다. 막 띄웠다면 30초쯤 기다려 주세요.
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {!run && (
        <section className="panel notice">
          <h2>아직 실행 기록이 없습니다</h2>
          <p>
            "빠른 실행"으로 핵심 시나리오를 1~2분 안에 확인하거나, "전체 실행"으로 판정표 16개와 설정 함정 6개를 모두 측정하세요(약 12분). 실행이 끝나면 여기에 성공/실패 판정표가 나옵니다.
          </p>
        </section>
      )}

      {run && (
        <section className="panel progress-panel">
          <div className="progress-head">
            <div>
              <b>
                {MODE_LABEL[run.mode]} · {statusText(run.status)}
              </b>
              <span className="muted">
                {' '}
                {dateTime(run.startedAt)} 시작 · {duration(run.startedAt, run.finishedAt)}
              </span>
            </div>
            <span className="mono">
              {doneCount} / {run.cases.length}
            </span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={run.cases.length} aria-valuenow={doneCount}>
            <div style={{ width: `${(100 * doneCount) / Math.max(1, run.cases.length)}%` }} />
          </div>
          {current && (
            <p className="muted">
              실행 중: {scenarioById(catalog, current.scenarioId).no}. {scenarioById(catalog, current.scenarioId).title} · {targetById(catalog, current.targetId).label}
            </p>
          )}
          <button className="link" onClick={() => setShowLog((v) => !v)}>
            {showLog ? '실행 로그 접기' : '실행 로그 펼치기'}
          </button>
          {showLog && (
            <pre className="log" ref={logRef}>
              {log.length ? log.map((l) => `${new Date(l.t).toLocaleTimeString('ko-KR')}  ${l.caseId ? `[${l.caseId}] ` : ''}${l.line}`).join('\n') : '로그가 없습니다'}
            </pre>
          )}
        </section>
      )}

      {run && <Report catalog={catalog} run={run} onOpen={setOpenCase} />}

      {run && openResult && (
        <CaseDetail
          catalog={catalog}
          runId={run.id}
          result={openResult}
          running={running}
          onClose={() => setOpenCase(null)}
          onRerun={(id) => start('custom', [id])}
        />
      )}
    </div>
  )
}

function statusText(status: Run['status']) {
  return { running: '실행 중', done: '완료', stopped: '중지됨', interrupted: '중단됨' }[status]
}

function Services({ catalog, health }: { catalog: Catalog; health: Health | null }) {
  return (
    <div className="services" aria-label="서비스 상태">
      {catalog.targets.map((t) => {
        const up = health?.targets[t.id]
        return (
          <span key={t.id} className={`service ${up === undefined ? '' : up ? 'up' : 'down'}`} title={t.description}>
            <i aria-hidden="true" />
            {t.label}
          </span>
        )
      })}
    </div>
  )
}
