import { useRef, useState } from 'react'
import { streamChat } from './streamChat'

type GatewayKey = 'mvc' | 'webflux'
type Status = 'idle' | 'connecting' | 'streaming' | 'done' | 'aborted' | 'error'

const GATEWAYS: Record<GatewayKey, { label: string; url: string }> = {
  mvc: { label: 'Gateway MVC (:8080)', url: import.meta.env.VITE_MVC_GATEWAY_URL ?? 'http://localhost:8080' },
  webflux: { label: 'Gateway WebFlux (:8082)', url: import.meta.env.VITE_WEBFLUX_GATEWAY_URL ?? 'http://localhost:8082' },
}

const MAX_ROWS = 300

interface ReceivedEvent {
  seq: number
  event: string
  index?: number
  content?: string
  /** ms since the request started */
  atMs: number
  /** ms since the previous event */
  gapMs: number
  /** receive time minus backend emittedAt (same-host clocks only) */
  lagMs?: number
}

interface TokenData {
  index: number
  content: string
  emittedAt: number
}

function newRequestId() {
  return `web-${crypto.randomUUID()}`
}

export default function App() {
  const [gateway, setGateway] = useState<GatewayKey>('mvc')
  const [message, setMessage] = useState('안녕하세요')
  const [count, setCount] = useState(10)
  const [delayMs, setDelayMs] = useState(200)

  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [events, setEvents] = useState<ReceivedEvent[]>([])
  const [text, setText] = useState('')
  const [ttfeMs, setTtfeMs] = useState<number | null>(null)
  const [totalMs, setTotalMs] = useState<number | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const running = status === 'connecting' || status === 'streaming'

  async function start() {
    const controller = new AbortController()
    abortRef.current = controller
    const id = newRequestId()
    const startedAt = performance.now()
    let lastAt = startedAt
    let seq = 0
    let sawDone = false

    setStatus('connecting')
    setError(null)
    setRequestId(id)
    setEvents([])
    setText('')
    setTtfeMs(null)
    setTotalMs(null)

    try {
      await streamChat(GATEWAYS[gateway].url, { message, count, delayMs }, id, controller.signal, {
        onOpen: ({ requestId: echoed }) => {
          setStatus('streaming')
          if (echoed) setRequestId(echoed)
        },
        onEvent: (e, receivedAt) => {
          const row: ReceivedEvent = {
            seq: seq++,
            event: e.event,
            atMs: receivedAt - startedAt,
            gapMs: receivedAt - lastAt,
          }
          if (row.seq === 0) setTtfeMs(row.atMs)
          lastAt = receivedAt
          if (e.event === 'token') {
            const data = JSON.parse(e.data) as TokenData
            row.index = data.index
            row.content = data.content
            row.lagMs = performance.timeOrigin + receivedAt - data.emittedAt
            setText((t) => (t ? `${t} ${data.content}` : data.content))
          } else if (e.event === 'done') {
            sawDone = true
          }
          setEvents((prev) => (prev.length >= MAX_ROWS ? [...prev.slice(1), row] : [...prev, row]))
        },
      })
      setTotalMs(performance.now() - startedAt)
      if (sawDone) {
        setStatus('done')
      } else {
        setStatus('error')
        setError('스트림이 done 이벤트 없이 종료되었습니다.')
      }
    } catch (e) {
      setTotalMs(performance.now() - startedAt)
      if (controller.signal.aborted) {
        setStatus('aborted')
      } else {
        setStatus('error')
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  const tokenRows = events.filter((e) => e.event === 'token')
  const gaps = tokenRows.slice(1).map((e) => e.gapMs)
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null

  return (
    <main>
      <header>
        <h1>Gateway SSE Streaming PoC</h1>
        <p>fetch + ReadableStream으로 POST SSE를 수신합니다. 이벤트별 수신 시각으로 Gateway 버퍼링 여부를 확인하세요.</p>
      </header>

      <section className="panel controls">
        <fieldset disabled={running}>
          <legend>Gateway</legend>
          {(Object.keys(GATEWAYS) as GatewayKey[]).map((key) => (
            <label key={key} className="radio">
              <input type="radio" name="gateway" checked={gateway === key} onChange={() => setGateway(key)} />
              {GATEWAYS[key].label}
            </label>
          ))}
        </fieldset>

        <div className="fields">
          <label>
            메시지
            <input value={message} onChange={(e) => setMessage(e.target.value)} disabled={running} />
          </label>
          <label>
            count
            <input type="number" min={1} max={10000} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={running} />
          </label>
          <label>
            delayMs
            <input type="number" min={0} max={60000} value={delayMs} onChange={(e) => setDelayMs(Number(e.target.value))} disabled={running} />
          </label>
        </div>

        <div className="buttons">
          <button onClick={start} disabled={running}>시작</button>
          <button onClick={stop} disabled={!running} className="secondary">중단</button>
        </div>
      </section>

      <section className="panel summary">
        <div><span>상태</span><strong className={`status ${status}`}>{status}</strong></div>
        <div><span>TTFE</span><strong>{fmt(ttfeMs)}</strong></div>
        <div><span>평균 간격</span><strong>{fmt(avgGap)}</strong></div>
        <div><span>전체</span><strong>{fmt(totalMs)}</strong></div>
        <div><span>토큰</span><strong>{tokenRows.length}</strong></div>
        <div className="wide"><span>Request ID</span><code>{requestId ?? '-'}</code></div>
        {error && <div className="wide error">{error}</div>}
      </section>

      <section className="panel">
        <h2>실시간 토큰</h2>
        <p className="tokens">{text || <span className="muted">아직 수신한 토큰이 없습니다.</span>}</p>
      </section>

      <section className="panel">
        <h2>이벤트 수신 시각</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>event</th>
                <th>index</th>
                <th>content</th>
                <th>수신 (ms)</th>
                <th>간격 (ms)</th>
                <th title="수신 시각 - backend emittedAt (같은 호스트에서만 의미 있음)">lag (ms)</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{e.event}</td>
                  <td>{e.index ?? ''}</td>
                  <td>{e.content ?? ''}</td>
                  <td>{e.atMs.toFixed(1)}</td>
                  <td>{e.gapMs.toFixed(1)}</td>
                  <td>{e.lagMs?.toFixed(1) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}

function fmt(ms: number | null) {
  return ms == null ? '-' : `${ms.toFixed(1)} ms`
}
