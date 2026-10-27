// Types and calls for the test runner API (apps/test-runner), served under /runner-api.
export const API = '/runner-api'

export type Verdict = 'pass' | 'fail' | 'error' | 'baseline'
export type CaseStatus = 'queued' | 'running' | 'done' | 'skipped'
export type RunMode = 'full' | 'quick' | 'custom'

export interface Target {
  id: string
  label: string
  kind: 'backend' | 'mvc' | 'webflux'
  pitfall: boolean
  description: string
}

export interface Explanation {
  why: string
  fix: string
}

export interface Scenario {
  id: string
  no: number
  tid: string
  title: string
  judge: string
  criterion: string
  targets: string[]
  baseline?: string
  repeat?: number
  hasSubruns: boolean
  params: Record<string, number | string>
  explain?: Record<string, Explanation>
}

export interface Pitfall {
  id: string
  target: string
  scenario: string
  why: string
}

export interface Catalog {
  targets: Target[]
  mainTargets: string[]
  scenarios: Scenario[]
  pitfalls: Pitfall[]
  quickScenarios: string[]
}

export interface Stats {
  n: number
  min: number
  p50: number
  p95: number
  max: number
}

export interface CaseMetrics {
  requests?: number
  warmupRequests?: number
  outcomes?: Record<string, number>
  statuses?: number[]
  ttfeMs?: Stats | null
  totalMs?: Stats | null
  gapMs?: Stats | null
  lagMs?: Stats | null
  cancelPropagationMs?: Stats | null
  eventsAfterAbort?: Stats | null
}

export interface Resources {
  samples: number
  cpuAvgPct: number | null
  cpuMaxPct: number | null
  memMaxMb: number | null
  threadsMax: number | null
}

export interface CaseResult {
  id: string
  scenarioId: string
  targetId: string
  quick: boolean
  status: CaseStatus
  verdict?: Verdict
  reason?: string
  expected?: 'fail'
  metrics?: CaseMetrics
  resources?: Resources | null
  startedAt?: number
  finishedAt?: number
  subrunCount?: number
}

export interface TargetSummary {
  pass: number
  fail: number
  error: number
  baseline: number
  pending: number
}

export interface RunSummary {
  byTarget: Record<string, TargetSummary>
  pitfalls: { matched: number; done: number; total: number }
}

export interface LogEntry {
  t: number
  caseId: string | null
  line: string
}

export interface Run {
  id: string
  mode: RunMode
  status: 'running' | 'done' | 'stopped' | 'interrupted'
  startedAt: number
  finishedAt: number | null
  cases: CaseResult[]
  summary: RunSummary
  log?: LogEntry[]
}

export interface RunListItem {
  id: string
  mode: RunMode
  status: Run['status']
  startedAt: number
  finishedAt: number | null
  caseCount: number
  summary: RunSummary
}

export interface Health {
  runner: boolean
  running: string | null
  targets: Record<string, boolean>
}

/** One request as recorded by k6. events: [tokenIndex | 'done', receivedAtMs, lagMs | null] */
export interface RequestRecord {
  rid: string
  warmup: boolean
  sub: number
  subLabel: string | null
  status: number
  outcome: string
  error: string | null
  headersMs: number | null
  ttfeMs: number | null
  totalMs: number
  tokens: number
  inOrder: boolean
  sawDone: boolean
  contentType?: string | null
  cacheControl?: string | null
  abortedAtMs?: number
  backendOutcome?: string
  cancelPropagationMs?: number | null
  eventsAfterAbort?: number
  eventCount?: number
  events?: [number | 'done', number, number | null][]
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json() as Promise<T>
}

async function errorMessage(res: Response) {
  try {
    const body = (await res.json()) as { message?: string }
    return body.message ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

export const api = {
  catalog: () => get<Catalog>('/catalog'),
  health: () => get<Health>('/health'),
  runs: () => get<RunListItem[]>('/runs'),
  run: (id: string) => get<Run>(`/runs/${id}`),
  requests: (runId: string, caseId: string) => get<RequestRecord[]>(`/runs/${runId}/cases/${caseId}/requests`),
  request: (runId: string, caseId: string, rid: string) => get<RequestRecord>(`/runs/${runId}/cases/${caseId}/requests/${encodeURIComponent(rid)}`),
  async log(runId: string, caseId: string) {
    const res = await fetch(`${API}/runs/${runId}/cases/${caseId}/log`)
    if (!res.ok) throw new Error(await errorMessage(res))
    return res.text()
  },
  rawUrl: (runId: string, caseId: string) => `${API}/runs/${runId}/cases/${caseId}/raw`,
  async start(mode: RunMode, cases: string[] = []) {
    const res = await fetch(`${API}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, cases }),
    })
    if (!res.ok) throw new Error(await errorMessage(res))
    return (await res.json()) as { id: string }
  },
  async stop(runId: string) {
    await fetch(`${API}/runs/${runId}/stop`, { method: 'POST' })
  },
  eventsUrl: (runId: string) => `${API}/runs/${runId}/events`,
}
