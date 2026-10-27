import { useEffect, useState } from 'react'
import StreamPlayground from './playground/StreamPlayground'
import RunnerPage from './runner/RunnerPage'

type Tab = 'report' | 'playground'

const TABS: { id: Tab; label: string }[] = [
  { id: 'report', label: '테스트 리포트' },
  { id: 'playground', label: '스트림 체험' },
]

function tabFromHash(): Tab {
  return location.hash === '#playground' ? 'playground' : 'report'
}

export default function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash)

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div>
            <div className="eyebrow">spring-gateway-streaming-poc</div>
            <h1>Gateway SSE 스트리밍 테스트</h1>
          </div>
          <nav className="tabs" aria-label="화면">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={tab === t.id ? 'active' : ''} aria-current={tab === t.id ? 'page' : undefined}>
                {t.label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main>{tab === 'report' ? <RunnerPage /> : <StreamPlayground />}</main>
    </>
  )
}
