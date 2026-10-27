// What can be tested: targets (running services), scenarios with their pass criteria, and
// pitfall configurations that are expected to fail. Everything the UI shows comes from here.

const url = (id, fallback) => process.env[`TARGET_URL_${id.toUpperCase().replace(/-/g, '_')}`] ?? fallback

export const BACKEND_URL = url('backend', 'http://ai-backend:8081')

export const TARGETS = {
  direct: {
    label: 'Backend 직접',
    kind: 'backend',
    url: BACKEND_URL,
    description: 'Gateway 없이 Backend를 직접 호출. 비교 기준선',
  },
  mvc: {
    label: 'MVC 기본',
    kind: 'mvc',
    url: url('mvc', 'http://gateway-mvc:8080'),
    description: 'Gateway MVC 기본값. JDK HTTP 클라이언트, Tomcat 플랫폼 스레드 최대 200개',
  },
  tuned: {
    label: 'MVC tuned',
    kind: 'mvc',
    url: url('tuned', 'http://gateway-mvc-tuned:8080'),
    description: 'Jetty 클라이언트 + read-timeout 10분 + Jetty 커넥션 풀 2048 + 가상 스레드 + accept-count 1000 (application-tuned.yml)',
  },
  webflux: {
    label: 'WebFlux',
    kind: 'webflux',
    url: url('webflux', 'http://gateway-webflux:8082'),
    description: 'Gateway WebFlux 기본값 + connect-timeout 2초, response-timeout 10초',
  },
  'pit-jdk-rt10s': {
    label: 'MVC + JDK + read-timeout 10s',
    kind: 'mvc',
    pitfall: true,
    url: url('pit-jdk-rt10s', 'http://pit-jdk-rt10s:8080'),
    description: '기본 JDK 클라이언트에 spring.http.client.read-timeout=10s',
  },
  'pit-jetty-nort': {
    label: 'MVC + Jetty, read-timeout 미설정',
    kind: 'mvc',
    pitfall: true,
    url: url('pit-jetty-nort', 'http://pit-jetty-nort:8080'),
    description: 'spring.http.client.factory=jetty만 설정',
  },
  'pit-jetty-pool64': {
    label: 'MVC + Jetty, 커넥션 풀 64',
    kind: 'mvc',
    pitfall: true,
    url: url('pit-jetty-pool64', 'http://pit-jetty-pool64:8080'),
    description: 'tuned에서 Jetty 커넥션 풀만 Jetty 기본값(64)으로',
  },
  'pit-jetty-platform': {
    label: 'MVC + Jetty, 플랫폼 스레드',
    kind: 'mvc',
    pitfall: true,
    url: url('pit-jetty-platform', 'http://pit-jetty-platform:8080'),
    description: 'tuned에서 가상 스레드만 끔 (Tomcat 스레드 최대 200개)',
  },
  'pit-vt-jdk': {
    label: 'MVC + 가상 스레드만',
    kind: 'mvc',
    pitfall: true,
    url: url('pit-vt-jdk', 'http://pit-vt-jdk:8080'),
    description: '가상 스레드만 켜고 JDK 클라이언트 유지',
  },
  'pit-simple': {
    label: 'MVC + simple 클라이언트',
    kind: 'mvc',
    pitfall: true,
    url: url('pit-simple', 'http://pit-simple:8080'),
    description: 'spring.http.client.factory=simple (HttpURLConnection)',
  },
}

export const MAIN_TARGETS = ['direct', 'mvc', 'tuned', 'webflux']
const GATEWAYS = ['mvc', 'tuned', 'webflux']

const FRONT_PROXY = url('front-proxy', 'http://front-proxy')
const NGINX_PORTS = { mvc: 8180, webflux: 8280, tuned: 8380 }
const NGINX_VARIANTS = [
  { offset: 0, label: 'nginx 기본' },
  { offset: 1, label: 'nginx 버퍼링 강제' },
  { offset: 2, label: 'nginx gzip' },
]

// `explain` is keyed by target id or target kind (id wins) and shown when that combination fails.
export const SCENARIOS = [
  {
    id: 's01', no: 1, tid: 'T01–T03', title: '정상 응답', judge: 'normal', targets: MAIN_TARGETS,
    criterion: '200, text/event-stream, Cache-Control: no-cache, 토큰 10개 + done이 순서대로',
    params: { COUNT: 10, DELAY_MS: 200, ITERATIONS: 3 },
    quick: { ITERATIONS: 2 },
  },
  {
    id: 's02', no: 2, tid: 'T02–T03', title: '버퍼링 없음', judge: 'buffering', targets: MAIN_TARGETS,
    criterion: '첫 토큰이 응답 완료보다 1초 이상 먼저 도착 (2초 스트림)',
    params: { COUNT: 10, DELAY_MS: 200, ITERATIONS: 3, WARMUP: 1 },
    quick: { ITERATIONS: 2, WARMUP: 0 },
  },
  {
    id: 's03', no: 3, tid: 'T04', title: '추가 지연', judge: 'latency', targets: MAIN_TARGETS, baseline: 'direct',
    criterion: '토큰 간격 0ms에서 첫 토큰 p50이 Backend 직접 대비 10ms 이상 늦지 않음',
    params: { COUNT: 10, DELAY_MS: 0, ITERATIONS: 30, WARMUP: 5 },
  },
  {
    id: 's04', no: 4, tid: 'T05', title: '30초 이상 스트림', judge: 'long', targets: MAIN_TARGETS, group: 'long',
    criterion: '토큰 160개 × 200ms(약 33초) 스트림이 끊기지 않고 done까지 도착',
    params: { COUNT: 160, DELAY_MS: 200, ITERATIONS: 1 },
    explain: {
      mvc: {
        why: 'MVC의 HTTP 클라이언트 read-timeout이 응답 전체 시간 제한으로 동작합니다. JDK 클라이언트는 설정값이 지나면 응답 본문을 닫고, Spring의 Jetty 팩토리는 설정하지 않으면 10초를 전체 시간 제한으로 씁니다.',
        fix: 'spring.http.client.read-timeout을 서비스의 최대 스트림 길이 이상으로 설정합니다.',
      },
    },
  },
  {
    id: 's05', no: 5, tid: '타임아웃', title: '연결 타임아웃', judge: 'connect', targets: GATEWAYS,
    criterion: 'Backend에 연결할 수 없을 때 3.5초 안에 5xx 응답 (connect-timeout 2초)',
    params: { COUNT: 1, DELAY_MS: 0, ITERATIONS: 3, PATH_PREFIX: '/unreachable', TIMEOUT: '30s' },
  },
  {
    id: 's06', no: 6, tid: '타임아웃', title: '첫 토큰 지연', judge: 'firstToken', targets: GATEWAYS, group: 'long',
    criterion: '첫 토큰이 12초 뒤에 나와도 스트림이 유지되고 done까지 도착',
    params: { COUNT: 2, DELAY_MS: 12000, ITERATIONS: 1 },
    explain: {
      webflux: {
        why: 'WebFlux의 response-timeout은 Backend의 응답 헤더가 올 때까지만 기다립니다. Backend는 첫 토큰과 함께 헤더를 보내므로, 이 값(10초)이 사실상 첫 토큰 대기 제한이 됩니다.',
        fix: 'response-timeout을 첫 토큰 최대 대기 시간보다 길게 잡거나, Backend가 헤더를 먼저 보내게 합니다. 스트림 본문에는 적용되지 않으므로 긴 스트림 자체에는 영향이 없습니다.',
      },
    },
  },
  {
    id: 's07', no: 7, tid: 'T06', title: '사용자 중단', judge: 'cancel', targets: MAIN_TARGETS,
    criterion: '토큰 3개 수신 후 연결을 끊으면 1초 안에 Backend가 토큰 생성을 멈춤 (Backend 기록이 CANCELLED)',
    params: { COUNT: 50, DELAY_MS: 200, ITERATIONS: 5, ABORT_AFTER: 3, CANCEL_WAIT_MS: 15000 },
    quick: { ITERATIONS: 2 },
    explain: {
      mvc: {
        why: 'MVC Gateway는 클라이언트에 다음 토큰을 쓰려다 실패해야 끊긴 것을 압니다. 그 뒤 Backend 응답을 닫는데, Spring의 JDK·simple 클라이언트는 닫을 때 연결 재사용을 위해 남은 응답을 끝까지 읽습니다(drain). 그래서 Backend는 클라이언트가 떠난 줄 모르고 끝까지 생성합니다.',
        fix: 'spring.http.client.factory=jetty. Jetty 클라이언트는 drain하지 않고 바로 연결을 닫습니다.',
      },
    },
  },
  {
    id: 's08', no: 8, tid: 'T09', title: '헤더 전 오류', judge: 'beforeHeaders', targets: MAIN_TARGETS,
    criterion: 'Backend가 응답 헤더 전에 500을 내면 클라이언트도 500을 받음',
    params: { COUNT: 10, DELAY_MS: 200, ITERATIONS: 1, FAIL_MODE: 'BEFORE_HEADERS' },
  },
  {
    id: 's09', no: 9, tid: 'T09', title: '스트림 중간 오류', judge: 'midStream', targets: MAIN_TARGETS,
    criterion: 'Backend가 토큰 5개 후 오류로 끊으면 클라이언트가 연결 오류로 감지',
    params: { COUNT: 10, DELAY_MS: 200, ITERATIONS: 1, FAIL_MODE: 'MID_STREAM' },
    explain: {
      mvc: {
        why: '응답이 이미 시작된 뒤 업스트림에서 예외가 나면 Tomcat이 응답을 정상 종료합니다. 클라이언트에는 스트림이 정상적으로 끝난 것처럼 보입니다.',
        fix: 'Gateway 설정으로는 해결되지 않습니다. 클라이언트가 done 이벤트를 받았을 때만 정상 완료로 판정하면 됩니다.',
      },
    },
  },
  {
    id: 's10', no: 10, tid: 'T10', title: '100개 동시', judge: 'concurrency', targets: MAIN_TARGETS, resources: true,
    criterion: '100개 동시 스트림이 전부 완료되고 첫 토큰 p95 0.5초 이내, 최대 1초 이내',
    params: { COUNT: 10, DELAY_MS: 200, VUS: 100, ITERATIONS: 3, WARMUP: 1 },
    quick: { ITERATIONS: 1, WARMUP: 1 },
    explain: {
      'pit-jetty-pool64': {
        why: 'Jetty HttpClient의 목적지별 커넥션 수 기본값은 64입니다. 스트림마다 Backend 연결을 하나씩 점유하므로 65번째부터 앞선 스트림이 끝나기를 기다립니다.',
        fix: 'Jetty maxConnectionsPerDestination을 목표 동시 스트림 수 이상으로 설정합니다 (poc.jetty-client.max-connections-per-destination).',
      },
    },
  },
  {
    id: 's11', no: 11, tid: 'T10', title: '500개 동시', judge: 'concurrency', targets: MAIN_TARGETS, resources: true,
    criterion: '500개 동시 스트림이 전부 완료되고 첫 토큰 p95 0.5초 이내, 최대 1초 이내',
    params: { COUNT: 10, DELAY_MS: 200, VUS: 500, ITERATIONS: 3, WARMUP: 1 },
    explain: {
      mvc: {
        why: 'MVC Gateway는 스트림 하나가 Tomcat 요청 스레드 하나를 스트림이 끝날 때까지 점유합니다. 플랫폼 스레드 최대 200개를 넘는 요청은 앞선 스트림이 끝날 때까지 첫 토큰을 받지 못합니다.',
        fix: 'spring.threads.virtual.enabled=true, 또는 server.tomcat.threads.max를 목표 동시 스트림 수 이상으로 설정합니다.',
      },
    },
  },
  {
    id: 's12', no: 12, tid: 'T10', title: '500개 동시 × 20초', judge: 'concurrency', targets: MAIN_TARGETS, resources: true,
    criterion: '20초짜리 스트림 500개가 한꺼번에 연결해도 전부 완료되고 첫 토큰 p95 0.5초 이내, 최대 1초 이내',
    // Short warmup first (a cold JVM alone pushes p95 over the limit), then all 500 connect at the same instant.
    params: { COUNT: 100, DELAY_MS: 200, VUS: 500, ITERATIONS: 1, WARMUP: 1, WARMUP_COUNT: 5, WARMUP_DELAY_MS: 100, BARRIER_MS: 6000 },
    explain: {
      mvc: {
        why: '스트림 하나가 Tomcat 스레드 하나를 20초 동안 점유하므로 200개씩 배치로 처리됩니다. 마지막 배치는 40초 넘게 첫 토큰을 기다립니다. 일부만 1초 남짓 늦는다면 Tomcat 연결 대기열(accept-count, 기본 100)이 넘친 것입니다. 이 경우 컨테이너의 /proc/net/netstat에서 ListenOverflows가 늘어납니다.',
        fix: '가상 스레드(spring.threads.virtual.enabled=true) 또는 server.tomcat.threads.max 확대. 대기열 넘침이면 server.tomcat.accept-count를 늘립니다(tuned는 1000).',
      },
    },
  },
  {
    id: 's13', no: 13, tid: 'T10', title: '500 VU 반복', judge: 'stability', targets: MAIN_TARGETS, resources: true, repeat: 3,
    criterion: '500개 동시 × 2회 실행을 3번 반복해서 모든 실행의 완료율이 99% 이상',
    params: { COUNT: 10, DELAY_MS: 200, VUS: 500, ITERATIONS: 2 },
    explain: {
      mvc: {
        why: '이전 측정에서 5회 중 1회 연결 실패가 있었고 원인은 확인하지 못했습니다. 상세 로그에서 실패한 요청의 오류 메시지를 확인하세요.',
        fix: '가상 스레드 또는 스레드 수 확대로 스레드 부족 상태를 없애고 다시 측정합니다.',
      },
    },
  },
  {
    id: 's14', no: 14, tid: 'T11', title: 'CORS', judge: 'cors', targets: GATEWAYS, kind: 'cors',
    criterion: 'http://localhost:5173 preflight는 200 + 허용 헤더, 다른 Origin은 403',
    params: { ITERATIONS: 1 },
  },
  {
    id: 's15', no: 15, tid: 'T12', title: 'Gateway gzip', judge: 'gzip', targets: GATEWAYS,
    criterion: 'Gateway가 gzip으로 압축해도 첫 토큰이 응답 완료보다 1초 이상 먼저 도착',
    params: { COUNT: 10, DELAY_MS: 200, ITERATIONS: 3, ACCEPT_ENCODING: 'auto', CHECK_GZIP: 'true' },
  },
  {
    id: 's16', no: 16, tid: 'T12', title: '앞단 nginx', judge: 'nginx', targets: GATEWAYS,
    criterion: 'nginx 기본·버퍼링 강제·gzip 세 설정 모두 첫 토큰이 응답 완료보다 1초 이상 먼저 도착',
    params: { COUNT: 10, DELAY_MS: 200, ITERATIONS: 2 },
    subruns: (targetId) =>
      NGINX_VARIANTS.map((v) => ({
        label: v.label,
        url: `${FRONT_PROXY}:${NGINX_PORTS[targetId] + v.offset}`,
        params: v.offset === 2 ? { ACCEPT_ENCODING: 'auto' } : {},
      })),
  },
]

export const PITFALLS = [
  { id: 'p1', target: 'pit-jdk-rt10s', scenario: 's04', why: 'JDK 클라이언트의 read-timeout은 응답 전체 시간 제한입니다' },
  { id: 'p2', target: 'pit-jetty-nort', scenario: 's04', why: 'Spring의 Jetty 팩토리는 기본 10초를 전체 시간 제한으로 씁니다' },
  { id: 'p3', target: 'pit-jetty-pool64', scenario: 's10', why: '스트림마다 Backend 연결을 하나씩 점유하는데 풀이 64개입니다' },
  { id: 'p4', target: 'pit-jetty-platform', scenario: 's11', why: 'Tomcat 플랫폼 스레드 200개 상한은 그대로입니다' },
  { id: 'p5', target: 'pit-vt-jdk', scenario: 's07', why: '스레드 문제만 풀리고 JDK 클라이언트의 drain 문제는 남습니다' },
  { id: 'p6', target: 'pit-simple', scenario: 's07', why: 'simple 클라이언트도 응답을 닫을 때 drain합니다' },
]

export const QUICK_SCENARIOS = ['s01', 's02', 's07', 's08', 's09', 's10', 's14']

export const caseId = (scenarioId, targetId) => `${scenarioId}.${targetId}`

export function scenarioById(id) {
  return SCENARIOS.find((s) => s.id === id)
}

/** Cases (scenario × target) for a mode, or for an explicit list of case ids. */
export function planCases(mode, explicit = []) {
  if (mode === 'custom') {
    const ids = new Set(explicit)
    // The latency judgement compares against the backend baseline, so it always runs alongside.
    for (const id of explicit) {
      const [sid] = id.split('.')
      const s = scenarioById(sid)
      if (s?.baseline) ids.add(caseId(sid, s.baseline))
    }
    const order = (id) => {
      const [sid, tid] = id.split('.')
      const s = scenarioById(sid)
      // Scenario order first; within a scenario the baseline target runs before the others.
      return s.no * 100 + (tid === s.baseline ? 0 : 1 + Object.keys(TARGETS).indexOf(tid))
    }
    return [...ids].filter(isKnownCase).sort((a, b) => order(a) - order(b)).map((id) => planned(id, false))
  }
  const quick = mode === 'quick'
  const cases = []
  for (const s of SCENARIOS) {
    if (quick && !QUICK_SCENARIOS.includes(s.id)) continue
    for (const t of s.targets) cases.push(planned(caseId(s.id, t), quick))
  }
  if (!quick) for (const p of PITFALLS) cases.push(planned(caseId(p.scenario, p.target), false))
  return cases
}

function isKnownCase(id) {
  const [sid, tid] = id.split('.')
  const s = scenarioById(sid)
  if (!s || !TARGETS[tid]) return false
  return s.targets.includes(tid) || PITFALLS.some((p) => p.scenario === sid && p.target === tid)
}

function planned(id, quick) {
  const [scenarioId, targetId] = id.split('.')
  return { id, scenarioId, targetId, quick, status: 'queued' }
}

export function catalogForClient() {
  return {
    targets: Object.entries(TARGETS).map(([id, t]) => ({ id, label: t.label, kind: t.kind, pitfall: !!t.pitfall, description: t.description })),
    mainTargets: MAIN_TARGETS,
    scenarios: SCENARIOS.map(({ subruns, ...s }) => ({ ...s, hasSubruns: !!subruns })),
    pitfalls: PITFALLS,
    quickScenarios: QUICK_SCENARIOS,
  }
}
