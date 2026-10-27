import type { CaseResult, Catalog, Explanation, RunMode, Scenario, Stats, Target } from './api'

export type Tone = 'pass' | 'fail' | 'error' | 'baseline' | 'running' | 'queued' | 'skipped' | 'none'

export function caseState(c: CaseResult | undefined): { text: string; tone: Tone } {
  if (!c) return { text: '—', tone: 'none' }
  if (c.status === 'queued') return { text: '대기', tone: 'queued' }
  if (c.status === 'running') return { text: '실행 중', tone: 'running' }
  if (c.status === 'skipped') return { text: '건너뜀', tone: 'skipped' }
  switch (c.verdict) {
    case 'pass':
      return { text: '성공', tone: 'pass' }
    case 'fail':
      return { text: '실패', tone: 'fail' }
    case 'baseline':
      return { text: '기준값', tone: 'baseline' }
    default:
      return { text: '측정 불가', tone: 'error' }
  }
}

export function ms(n: number | null | undefined) {
  if (n == null) return '-'
  if (n >= 10000) return `${(n / 1000).toFixed(1)}초`
  return `${Math.round(n)}ms`
}

export function statsText(s: Stats | null | undefined) {
  if (!s) return '-'
  return `${ms(s.p50)} / ${ms(s.p95)} / ${ms(s.max)}`
}

export function explanationFor(scenario: Scenario, target: Target): Explanation | undefined {
  return scenario.explain?.[target.id] ?? scenario.explain?.[target.kind]
}

export const MODE_LABEL: Record<RunMode, string> = { full: '전체 실행', quick: '빠른 실행', custom: '개별 실행' }

export function dateTime(t: number) {
  return new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function duration(from: number, to: number | null | undefined) {
  const s = Math.round(((to ?? Date.now()) - from) / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`
}

export const OUTCOME_LABEL: Record<string, string> = {
  complete: '정상 완료',
  aborted: '중단함',
  stream_error: '연결 오류',
  no_done: 'done 없이 종료',
  token_mismatch: '토큰 수 불일치',
  http_error: 'HTTP 오류',
  connect_error: '연결 실패',
}

export const BACKEND_OUTCOME_LABEL: Record<string, string> = {
  CANCELLED: '취소됨',
  COMPLETED: '끝까지 생성',
  FAILED: '오류',
  STILL_RUNNING: '아직 생성 중',
  RUNNING: '생성 중',
  UNKNOWN: '기록 없음',
}

export function targetById(catalog: Catalog, id: string) {
  return catalog.targets.find((t) => t.id === id)!
}

export function scenarioById(catalog: Catalog, id: string) {
  return catalog.scenarios.find((s) => s.id === id)!
}
