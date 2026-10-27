# 측정 결과: Gateway MVC vs Gateway WebFlux (SSE 프록시)

측정일 2026-10-27. 같은 시나리오를 `docker compose up` 후 화면에서 다시 실행할 수 있다(README 참고). 각 항목을 **판정 기준을 만족했는지(성공/실패)**로 정리했다. 측정 시간(ms)은 판정 근거로 필요할 때만 [부록: 측정값](#부록-측정값)에서 확인하면 된다.

## 한눈에 보기

| 구성 | 성공 | 실패 | 기타 | 한 줄 요약 |
| --- | --- | --- | --- | --- |
| MVC 기본 | 11 | **4** | 불안정 1 | 사용자가 중단해도 Backend가 멈추지 않고, 동시 스트림 200개를 넘으면 대기한다 |
| MVC `tuned` | 15 | **1** | — | 스트림 중간 오류를 클라이언트가 오류로 알 수 없다(`done` 이벤트로 보완) |
| WebFlux | 15 | **1** | — | 첫 토큰이 10초보다 늦으면 504. `response-timeout` 설정값 문제라 값을 늘리면 된다 |

**결론: MVC를 유지하고 `tuned` 구성을 적용한다.** MVC 기본의 실패 4개는 모두 설정으로 해결됐다. `tuned`에 남은 실패 1개는 클라이언트가 `done` 이벤트로 완료를 판정하면 문제가 되지 않는다. WebFlux로 옮겨서 추가로 얻는 성공 항목이 없으므로 Security·필터 마이그레이션 비용을 정당화하기 어렵다. 자세한 내용은 [결론과 권장 설정](#결론과-권장-설정).

비교한 구성:

| 구성 | 내용 |
| --- | --- |
| Backend 직접 | Gateway 없이 Backend(:8081)를 직접 호출. 비교 기준선 |
| MVC 기본 | Gateway MVC 기본값. JDK HTTP 클라이언트, Tomcat 플랫폼 스레드 최대 200개 |
| MVC `tuned` | Jetty HTTP 클라이언트 + read-timeout 10분 + Jetty 커넥션 풀 2048 + 가상 스레드 (`application-tuned.yml`). 이후 Docker 재측정에서 `accept-count 1000`을 추가했다([docker compose 재측정](#docker-compose-재측정)) |
| WebFlux | Gateway WebFlux 기본값 + connect-timeout 2초, response-timeout 10초 |

## 판정표

`—`는 해당 없음이다. MVC `tuned` 열은 모두 `tuned` 프로필 또는 같은 설정을 명령행 인자로 준 인스턴스로 측정했다.

| # | 시나리오 | 판정 기준 | Backend 직접 | MVC 기본 | MVC `tuned` | WebFlux |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | T01–T03 정상 응답 | 200, `text/event-stream`, 토큰 10개 + `done`이 순서대로 | 성공 | 성공 | 성공 | 성공 |
| 2 | T02–T03 버퍼링 | 응답이 끝나기 전부터 토큰이 하나씩 도착 | 성공 | 성공 | 성공 | 성공 |
| 3 | T04 추가 지연 | Backend 직접 대비 첫 토큰이 10ms 이상 늦지 않음 | — | 성공 | 성공 | 성공 |
| 4 | T05 30초 이상 스트림 | 33초 스트림이 중간에 끊기지 않음 | 성공 | 성공 | 성공 | 성공 |
| 5 | 연결 타임아웃 | Backend에 연결할 수 없을 때 약 2초 안에 오류 응답 | — | 성공 | 성공 | 성공 |
| 6 | 첫 토큰 지연 | 첫 토큰이 12초 뒤에 나와도 스트림 유지 | — | 성공 | 성공 | **실패** |
| 7 | T06 사용자 중단 | 중단 후 1초 안에 Backend가 토큰 생성을 멈춤 | 성공 | **실패** | 성공 | 성공 |
| 8 | T09 헤더 전 오류 | Backend의 500을 클라이언트가 그대로 받음 | 성공 | 성공 | 성공 | 성공 |
| 9 | T09 스트림 중간 오류 | 클라이언트가 연결 오류로 감지 | 성공 | **실패** | **실패** | 성공 |
| 10 | T10 100개 동시 | 전부 성공 + 첫 토큰 p95 0.5초 이내 | 성공 | 성공 | 성공 | 성공 |
| 11 | T10 500개 동시 | 전부 성공 + 첫 토큰 p95 0.5초 이내 | 성공 | **실패** | 성공 | 성공 |
| 12 | T10 500개 동시 × 20초 | 전부 성공 + 첫 토큰 p95 0.5초 이내 | 성공 | **실패** | 성공 | 성공 |
| 13 | T10 k6 500 VU 반복 | 모든 실행에서 성공률 99% 이상 | 성공 | 불안정 (5회 중 1회 92.3%) | 성공 (1회) | 성공 (4회) |
| 14 | T11 CORS | 로컬 Origin preflight 허용, 다른 Origin 거부 | — | 성공 | 성공 | 성공 |
| 15 | T12 Gateway gzip | gzip을 켜도 토큰이 하나씩 도착 | — | 성공 | 성공 | 성공 |
| 16 | T12 앞단 nginx | nginx 기본·버퍼링 강제·gzip에서 토큰이 하나씩 도착 | — | 성공 | 성공 | 성공 |

## 실패한 항목

### MVC 기본 · 7번: 사용자가 중단해도 Backend가 멈추지 않음

- **무슨 일**: 클라이언트가 토큰 3개를 받고 연결을 끊어도, Backend는 남은 47개를 끝까지 만들고 정상 종료했다. 5회 모두 같았다.
- **왜**: MVC Gateway는 클라이언트에 다음 토큰을 쓰려다 실패해야 끊긴 것을 안다. 그 뒤 Backend 응답을 닫는데, Spring의 JDK 클라이언트는 닫을 때 연결 재사용을 위해 **남은 응답을 끝까지 읽는다**(drain). 그래서 Backend는 클라이언트가 떠난 줄 모른다.
- **영향**: 실제 LLM이라면 사용자가 보지 않을 토큰 비용이 끝까지 나가고, 그동안 Tomcat 스레드와 Backend 연결이 하나씩 묶인다.
- **해결**: Jetty 클라이언트(`spring.http.client.factory=jetty`)는 drain하지 않고 바로 닫는다. `tuned`에서 성공.
- 상세 과정과 측정값: [T06](#t06-클라이언트-abort--backend-취소-전파).

### MVC 기본 · 11·12번: 동시 스트림 200개를 넘으면 대기

- **무슨 일**: 요청은 모두 성공했지만, 201번째부터는 앞선 스트림이 끝날 때까지 첫 토큰을 받지 못했다. 500개 × 20초 스트림에서는 마지막 배치가 첫 토큰을 받기까지 40초 넘게 기다렸다.
- **왜**: MVC Gateway는 스트림 하나가 Tomcat 스레드 하나를 스트림이 끝날 때까지 점유한다. Tomcat 기본 최대 스레드는 200개다.
- **해결**: 가상 스레드(`spring.threads.virtual.enabled=true`)를 켜거나 `server.tomcat.threads.max`를 목표 동시 스트림 수 이상으로 늘린다. `tuned`에서 성공.

### MVC 기본 · 13번: k6 500 VU에서 1회 연결 실패 (불안정)

- **무슨 일**: 5회 실행 중 첫 1회에서 1,000건 중 77건이 연결 실패했다. 이후 4회는 모두 성공했다.
- **왜**: 재현되지 않았고 원인을 확인하지 못했다. 11번과 같은 스레드 부족 상태에서 연결이 몰린 것과 관련 있을 수 있지만 검증하지 않았다.

### MVC 기본·`tuned` · 9번: 스트림 중간 오류를 클라이언트가 오류로 알 수 없음

- **무슨 일**: Backend가 토큰 5개를 보낸 뒤 오류로 스트림을 끊었을 때, Backend 직접 호출과 WebFlux에서는 클라이언트가 연결 오류를 받았다. MVC를 거치면 스트림이 정상적으로 끝난 것처럼 닫혔다.
- **왜**: 응답이 이미 시작된 뒤 예외가 나면 Tomcat이 응답을 정상 종료한다.
- **해결**: Gateway 설정으로는 해결하지 못했다. 클라이언트가 **`done` 이벤트를 받았을 때만 정상 완료로 판정**하면 된다. 이 저장소의 React 클라이언트와 측정 스크립트는 이렇게 처리한다(`done 이벤트 없이 종료`를 오류로 표시).

### WebFlux · 6번: 첫 토큰이 10초보다 늦으면 504

- **무슨 일**: 첫 토큰이 12초 뒤에 나오는 스트림에서 WebFlux Gateway가 10초에 504를 반환했다.
- **왜**: WebFlux의 `response-timeout`은 Backend의 응답 헤더가 올 때까지만 기다린다. Backend는 첫 토큰과 함께 헤더를 보내므로, 이 값이 사실상 "첫 토큰 대기 제한"이 된다. 이 측정에서는 10초로 설정했다.
- **해결**: `response-timeout`을 첫 토큰 최대 대기 시간보다 길게 잡거나, Backend가 헤더를 먼저 보내게 한다. 스트림 본문에는 적용되지 않으므로 긴 스트림 자체에는 영향이 없다(4번 성공).

## 설정을 잘못하면 실패하는 항목

기본값이나 흔히 쓰는 설정으로 바꿨을 때 실패한 경우다. 운영 설정을 정할 때 피해야 한다.

| 설정 | 실패한 시나리오 | 이유 |
| --- | --- | --- |
| MVC + JDK 클라이언트 + `read-timeout=10s` | 4번 (30초 스트림이 10초에서 끊김) | JDK 클라이언트의 read-timeout은 응답 **전체** 시간 제한이다 |
| MVC + Jetty 클라이언트, read-timeout 미설정 | 4번 (10초에서 끊김) | Spring의 Jetty 팩토리는 기본 10초를 전체 시간 제한으로 쓴다 |
| MVC + Jetty 클라이언트, 커넥션 풀 기본값(64) | 10·11번 (65번째부터 대기) | 스트림마다 Backend 연결을 하나씩 점유한다 |
| MVC + Jetty 클라이언트, 플랫폼 스레드 | 11번 | 스레드 200개 상한은 그대로다 |
| MVC + 가상 스레드만 (JDK 클라이언트 유지) | 7번 | 스레드 문제만 풀리고 drain 문제는 남는다 |
| MVC + `simple` 클라이언트 | 7번 | `simple`도 닫을 때 drain한다 |
| MVC `tuned`인데 `server.tomcat.accept-count` 기본값(100) | 12번: 500개가 한꺼번에 연결하면 일부가 1초 늦음 | 연결 대기열이 넘쳐 버려진 SYN이 1초 뒤 재전송된다 (Docker 재측정에서 발견) |

참고로 MVC + `simple` 클라이언트 + `read-timeout=10s`는 4번에 성공했다. `simple`의 read-timeout은 토큰 사이 대기 시간에만 적용되기 때문이다.

## 결론과 권장 설정

README의 의사결정 기준에 판정 결과를 대입하면 다음과 같다.

- **MVC 유지 조건**(이벤트 단위 전달, 목표 동시 연결·지연·취소 처리 충족, 낮은 운영 복잡도): MVC 기본은 7·11·12번 실패로 **불충족**이다. `tuned`는 9번을 제외하고 충족하며, 9번은 클라이언트에서 보완된다. 운영 복잡도는 설정 몇 줄과 커넥션 풀 Bean 하나다.
- **WebFlux 전환 조건**(연결 수가 늘 때 리소스 효율이나 지연이 유의미하게 개선): `tuned` 대비 WebFlux가 추가로 성공하는 항목은 9번 하나다. 500개 동시까지 지연과 리소스 차이도 작았다(부록 참고). 이것만으로는 마이그레이션 비용을 정당화하기 어렵다.

**권장: 기존 MVC Gateway를 유지하고 `tuned` 구성을 적용한다.**

1. `spring.http.client.factory=jetty`. 7번 해결.
2. `spring.http.client.read-timeout`을 서비스의 최대 스트림 길이 이상으로 설정한다. Jetty는 이 값을 전체 시간 제한으로 쓰므로, 설정하지 않으면 10초에서 끊긴다.
3. Jetty `maxConnectionsPerDestination`을 목표 동시 스트림 수 이상으로 설정한다(기본 64). 이 저장소에서는 `poc.jetty-client.max-connections-per-destination`.
4. `spring.threads.virtual.enabled=true`, 또는 `server.tomcat.threads.max`를 목표 동시 스트림 수 이상으로 설정한다. 11·12번 해결.
5. 클라이언트는 `done` 이벤트로 정상 완료를 판정한다. 9번 보완.
6. `server.tomcat.accept-count`를 동시에 몰릴 수 있는 연결 수 이상으로 설정한다(기본 100, OS `somaxconn` 이하). Docker 재측정에서 발견했다.

다음 경우에는 WebFlux 전환을 다시 검토한다.

- 목표 동시 스트림이 500보다 훨씬 많아서, 별도 호스트에서 재측정했을 때 `tuned`가 실패하는 항목이 생길 때.
- 9번(스트림 중간 오류를 연결 오류로 구분)이 반드시 필요할 때.
- Jetty 클라이언트를 쓸 수 없는 제약이 생겼는데, Spring 업그레이드로 JDK 클라이언트의 drain 동작이 바뀌지 않았을 때. 저장소의 `GatewayMvcJdkClientTest`가 현재 동작을 고정하고 있어서, 동작이 바뀌면 이 테스트가 실패한다.

## docker compose 재측정

`docker compose up --build` 후 화면의 "전체 실행"으로 같은 16개 시나리오와 설정 함정 6개를 k6(xk6-sse)로 다시 측정했다. Docker Desktop VM(8 CPU, 16 GB) 안에서 컨테이너 13개를 함께 띄운 환경이다.

**판정 결과는 호스트 측정과 같다.** 실행 `20261027-092557-twb`(674초) 기준이다.

| 구성 | 성공 | 실패 | 실패한 시나리오 |
| --- | --- | --- | --- |
| MVC 기본 | 12 | 4 | 7 사용자 중단, 9 스트림 중간 오류, 11 500개 동시, 12 500개 동시 × 20초 |
| MVC `tuned` | 15 | 1 | 9 스트림 중간 오류 |
| WebFlux | 15 | 1 | 6 첫 토큰 지연 (504) |
| 설정 함정 6개 | — | 6/6 예상대로 실패 | |

MVC 기본의 성공 개수가 호스트 판정표(11)보다 하나 많다. 호스트에서 "불안정"이던 13번(500 VU 반복)이 3회 모두 100%였기 때문이다.

재측정하면서 새로 확인한 것:

1. **Tomcat 연결 대기열 넘침.** 첫 실행에서 `tuned`가 12번에 실패했다(첫 토큰 p95 1.26초).
   - 500건 중 26건만 약 1.26초에 몰려 있었고, 나머지는 약 0.3초였다.
   - 컨테이너의 `/proc/net/netstat`에서 `ListenOverflows`가 MVC 컨테이너에서만 늘었다(`tuned` 172, 기본 62, WebFlux·Backend 0).
   - Tomcat `accept-count` 기본값 100이 500개 동시 연결로 넘쳐서 버려진 SYN이 1초 뒤 재전송된 것이다.
   - `tuned`에 `server.tomcat.accept-count: 1000`을 추가하자 넘침이 0이 됐고, 12번도 통과했다(p95 263~342ms).
   - 기본값(100) 구성은 재시작 직후에는 매번 다시 실패했다. 하지만 JVM이 충분히 데워진 뒤에는 넘침 없이 통과하기도 해서, 재현이 일정하지 않다. 그래서 설정 함정 자동 판정에는 넣지 않고 이 문서에만 기록한다.
2. **동시 연결 판정에 "최대 1초 이내"를 추가했다.** p95만 보면 5% 미만의 요청이 1초 넘게 늦는 문제를 놓친다. 위 대기열 넘침이 정확히 그 경우였다.
3. **콜드 스타트 보정.** 12번은 워밍업 없이 측정하고 있었다. 방금 재시작한 WebFlux가 p95 705ms로 실패했는데, 이는 JIT 워밍업 문제였다. 그래서 짧은 워밍업(500개 × 0.5초 스트림)을 넣고, 이후 모든 요청이 같은 시각에 연결하도록 출발 시점을 맞췄다.
4. **WebFlux 스트림 1건 정체 (원인 미확인).** 한 실행에서 10번(100개 동시) 중 1건이 토큰 8개 후 멈췄다.
   - Backend 기록으로는 10개를 모두 보내고 정상 종료했다.
   - 클라이언트는 나머지를 받지 못해 18분 뒤 타임아웃됐다.
   - 같은 케이스를 5회 다시 돌렸을 때는 재현되지 않았다.
   - Gateway와 k6 클라이언트 중 어디서 멈췄는지는 확인하지 못했다.
   - 이후 요청 타임아웃을 "스트림 길이 × 3 + 30초"로 줄여서, 같은 일이 생기면 실행 전체가 멈추지 않고 해당 요청만 실패로 기록되게 했다.

## 부록: 측정값

판정의 근거가 된 수치다. 판정표만으로 충분하면 읽지 않아도 된다. 값이 두 개인 칸은 p50 / p95다.

### 주요 지표

단일 스트림 값은 `count=10, delayMs=200`, 워밍업 5회 후 30회 반복한 p50/p95. 동시 연결은 같은 파라미터로 워밍업 1라운드 후 3라운드.

| 지표 | Backend 직접 | MVC (기본) | MVC (`tuned`) | WebFlux Gateway |
| --- | --- | --- | --- | --- |
| 첫 이벤트 수신까지 TTFE (ms), delay 200 | 207.1 / 208.2 | 208.4 / 209.5 | 212.3 / 217.3 | 208.9 / 214.8 |
| TTFE (ms), delay 0 (순수 왕복 오버헤드) | 1.8 / 2.3 | 2.7 / 3.3 | 2.6 / 3.4 | 2.5 / 3.3 |
| 이벤트 간격 p50/p95 (ms) | 204.6 / 205.2 | 204.6 / 205.2 | 204.0 / 209.5 | 204.0 / 207.4 |
| 이벤트 lag p50/p95 (ms, 수신시각 − 생성시각) | 1 / 1 | 1 / 1 | 2 / 5 | 1 / 3 |
| 전체 완료 시간 p50 (ms) | 2040.5 | 2042.6 | 2048.6 | 2041.9 |
| 100개 동시 연결 성공률 / TTFE p95 | 100% / 232 | 100% / 264 | 100% / 233 | 100% / 231 |
| 500개 동시 연결 성공률 / TTFE p95 | 100% / 236 | 100% / **4355** | 100% / 257 | 100% / 266 |
| CPU 평균/최대 % (500 × 2초 스트림) | 13.7 / 31.6 (Backend) | 8.1 / 37.0 | 45.7 / 81.4 | 31.5 / 89.6 |
| RSS 최대 MB / 스레드 최대 (500 × 2초) | 419 / 30 (Backend) | 463 / 339 | 622 / 58 | 456 / 30 |
| 취소 전파 시간 (ms) | 0 / 1 | **전파 안 됨** (Backend가 남은 토큰을 끝까지 생성, T06) | 204 / 410 | 1 / 4 |

MVC(기본) 500 동시의 성공률은 100%지만 이는 요청이 실패하지 않고 **Tomcat 작업 큐에서 대기**했기 때문이다. 첫 200개 이후 요청은 앞선 스트림이 끝날 때까지 TTFE가 늘어난다(아래 T10).

### 시나리오별 측정값

#### T01–T03, T11 스모크 (`scripts/smoke-test.sh`)

Backend, MVC, WebFlux, MVC `tuned` 모두 통과: 200, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, 토큰 10개 + done 순서 보존, 1.1초 시점에 이미 토큰 5개 도착(버퍼링 없음), CORS preflight 허용.

CORS (T11): 두 Gateway 모두 `Origin: http://localhost:5173` preflight에 200과 `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: content-type, x-request-id`, `Access-Control-Expose-Headers: X-Request-Id`를 반환했다. 허용되지 않은 Origin은 403.

#### T04 최초 이벤트 지연

Gateway가 추가하는 TTFE는 `delayMs=0` 기준 p50 0.7~0.9ms(Backend 1.8ms → Gateway 2.5~2.7ms). 이벤트별 lag(수신 시각 − Backend `emittedAt`)도 p95 1~5ms라서 단일 스트림 지연은 **차이가 없다고 봐도 된다**.

#### T05 30초 이상 스트림 (`count=160, delayMs=200`, 약 33초)

| 구성 | 결과 |
| --- | --- |
| direct, mvc(기본, read-timeout 미설정), webflux(response-timeout 10s) | 160개 + done 정상 |
| mvc + `spring.http.client.read-timeout=10s` (JDK client) | **약 10초(47개)에서 스트림이 끊김** |
| mvc + `factory=jetty` (read-timeout 미설정) | **약 10초에서 끊김** (`TimeoutException: Total timeout 10000 ms elapsed`) |
| mvc + `factory=jetty` + `read-timeout=10m` | 정상 |
| mvc `tuned` | 정상 (32.9초) |
| mvc + `factory=simple` + `read-timeout=10s` | 정상 (이벤트 사이 대기 시간에만 적용) |

원인(소스 확인):

- Spring 6.2.11 `JdkClientHttpRequest`의 `TimeoutHandler`는 read-timeout이 지나면 응답 본문을 닫는다. 즉 **응답 전체 시간 제한**이다.
- `JettyClientHttpRequestFactory`는 기본 `readTimeout = 10s`를 Jetty `Request.timeout()`(요청·응답 전체 시간 제한)으로 적용한다.
- WebFlux `NettyRoutingFilter`의 `response-timeout`은 **응답 헤더 도착까지**만 적용되고 본문 스트림에는 적용되지 않는다. 이벤트 사이의 idle timeout은 없다.

#### 연결 타임아웃과 첫 토큰 지연

| 시나리오 | MVC 기본 (JDK) | MVC `tuned` (Jetty) | WebFlux |
| --- | --- | --- | --- |
| Backend 연결 불가 (10.255.255.1, connect-timeout 2s) | 500, 2.15초 | 500, 2.02~2.16초 (3회) | 500, 2.28초 |
| 첫 이벤트가 12초 뒤에 나오는 스트림 | 200, TTFB 12.08초 | 200, TTFB 12.02초 | **504, 10.07초** |

`spring.http.client.connect-timeout`은 Jetty 클라이언트에도 그대로 적용됐다.

Backend(WebFlux)는 첫 이벤트를 쓸 때 응답 헤더를 함께 보낸다. 그래서 WebFlux Gateway의 `response-timeout`은 사실상 **첫 토큰 대기 시간 제한**이 된다. 첫 토큰이 늦는 LLM(추론 모델 등)에서는 `response-timeout`을 그보다 길게 잡거나, Backend가 헤더/주석 이벤트를 먼저 flush해야 한다.

#### T06 클라이언트 Abort → Backend 취소 전파

사용자가 답변 도중 "중단"을 누르거나 탭을 닫았을 때 **Backend(LLM)가 토큰 생성을 언제 멈추는지**를 잰다.

**측정 방법**

1. 클라이언트가 `count=50, delayMs=200`(약 10초) 스트림을 요청한다.
2. 토큰 3개를 받은 순간 연결을 끊고 그 시각을 `abortedAt`으로 기록한다.
3. Backend는 스트림이 끝난 시각 `finishedAt`과 끝난 이유를 기록한다(`/internal/streams/{requestId}`). `CANCELLED`는 중간에 취소됨, `COMPLETED`는 50개를 끝까지 만들고 정상 종료됨이다.
4. **전파 시간 = `finishedAt − abortedAt`**. 클라이언트와 Backend가 같은 머신이라 시계가 같다.
5. **abort 이후 생성한 토큰 = Backend가 생성한 토큰 수 − 3**. 사용자가 받지 않을 토큰을 Backend가 몇 개 더 만들었는지다.

값이 두 개인 칸은 p50 / p95이고, 단위가 ms라서 `0`은 1ms 미만이다.

| 구성 | Backend 결과 | 전파 시간 (ms) | abort 이후 Backend가 생성한 토큰 |
| --- | --- | --- | --- |
| direct | CANCELLED 5/5 | 0 / 1 | 0 |
| mvc (JDK, 기본) | **COMPLETED 5/5** | 전파 안 됨 (≈9,750에 정상 종료) | **47 (전부)** |
| mvc + `factory=simple` | **COMPLETED 2/2** | 전파 안 됨 (≈9,580에 정상 종료) | 47 |
| mvc + `factory=jetty` | CANCELLED 5/5 | 412 / 419 | 2 |
| mvc `tuned` | CANCELLED 3/3 | 204 / 410 | 1~2 |
| webflux | CANCELLED 5/5 | 1 / 4 | 0 |

**direct, WebFlux: 즉시 취소.** Netty는 이벤트 루프가 연결된 소켓을 계속 지켜본다. 클라이언트가 연결을 닫으면(FIN) 바로 알아채고 스트림 구독을 취소한다. WebFlux Gateway는 이때 Backend로 가는 연결도 즉시 닫고, Backend가 그것을 보고 취소한다. 소켓 이벤트만으로 처리되므로 다음 토큰을 기다리지 않는다.

**MVC 기본: 취소되지 않음.** 표의 ≈9,750ms는 취소에 걸린 시간이 아니다. Backend가 남은 47개(47 × 약 205ms ≈ 9.6초)와 done까지 다 만들고 정상 종료한 시각이다. 순서는 다음과 같다.

```
while (Backend에서 읽기) {      ← 대부분의 시간을 여기서 대기
    클라이언트에 쓰기 + flush
}
```

1. MVC Gateway는 요청마다 Tomcat 스레드 하나가 위 반복문을 돈다. 클라이언트가 끊어도 스레드는 Backend 읽기에서 대기 중이라 바로 알 수 없다.
2. 다음 토큰이 와서 클라이언트에 쓰려고 할 때 쓰기 실패 예외가 나며 비로소 끊긴 것을 안다.
3. 반복문을 빠져나오면서 Gateway MVC `RestClientProxyExchange`가 Backend 응답(`ClientHttpResponse`)을 `close()`한다.
4. Spring 6.2.11의 `JdkClientHttpResponse.close()`는 커넥션 재사용을 위해 **남은 본문을 끝까지 읽는다**(`StreamUtils.drain`). `SimpleClientHttpResponse`, `HttpComponentsClientHttpResponse`, `ReactorClientHttpResponse`도 같다(소스 확인).
5. 그래서 Gateway가 Backend 스트림을 마지막까지 읽고, Backend는 클라이언트가 떠난 줄 모르고 정상 완료(`COMPLETED`)한다.

결과적으로 세 가지 낭비가 생긴다.

- 실제 LLM이었다면 사용자가 보지 않을 토큰의 비용이 끝까지 나간다.
- 그동안 Tomcat 스레드 하나와 Backend 연결 하나가 묶인다. 중단이 많을수록 스레드 상한(200)에 더 빨리 닿는다.
- 정상 완료로 끝나므로 Backend 로그와 지표로는 중단을 알 수 없다.

**MVC + Jetty, `tuned`: 200~400ms 후 취소.** `JettyClientHttpResponse.close()`는 drain하지 않고 바로 닫으므로 Backend가 취소된다. 0ms가 아닌 이유는 위 1~2단계 때문이다. MVC는 다음 토큰을 쓸 때만 단절을 알 수 있다. 끊긴 직후의 첫 쓰기는 OS 송신 버퍼에 들어가며 성공할 수 있고, 클라이언트 쪽 OS가 RST로 응답한 뒤 두 번째 쓰기에서 실패한다. 그래서 토큰 간격(200ms)의 1~2배가 걸린다(p50 204ms = 1간격, p95 410ms = 2간격). 그 사이 Backend가 만든 토큰 1~2개가 "abort 이후 생성한 토큰"이다.

**실무적 의미**

| 구성 | 사용자가 중단하면 |
| --- | --- |
| WebFlux | 즉시 멈춘다 |
| MVC `tuned` | 토큰 1~2개를 더 만들고 멈춘다 |
| MVC 기본 | **답변을 끝까지 다 만든다** |

- LLM 토큰 간격은 보통 수십 ms라서 `tuned`의 "1~2개 더"는 비용 차이가 거의 없다. MVC 유지를 권장한 근거 중 하나다.
- 단, MVC의 감지 시간은 **다음 토큰까지의 간격**에 비례한다. 모델이 첫 토큰 전에 30초 동안 생각하는 중에 사용자가 중단하면, MVC는 최대 30초 뒤에야 알아채고 그동안 Backend는 계속 작업한다. WebFlux는 이 경우에도 즉시 안다.
- MVC 기본 설정을 그대로 운영하는 것은 피해야 한다.

**회귀 테스트와 직접 확인**

`GatewayMvcJdkClientTest`가 현재 동작(drain, 취소 안 됨)을 고정하고, `GatewayMvcJettyClientTest`와 `GatewayWebfluxStreamingTest`가 취소 전파를 검증한다. Spring 업그레이드로 drain 동작이 바뀌면 `GatewayMvcJdkClientTest`가 실패한다.

```bash
node scripts/sse-probe.mjs --target http://localhost:8080 --count 50 --abort-after 3 --repeat 5   # MVC 기본
node scripts/sse-probe.mjs --target http://localhost:8082 --count 50 --abort-after 3 --repeat 5   # WebFlux
```

출력의 `cancel outcomes`가 `COMPLETED`면 전파되지 않은 것이고 `CANCELLED`면 전파된 것이다. Backend를 `--chat.stream.log-each-event=true`로 띄우면 로그로도 보인다. MVC 기본은 끊은 뒤에도 `token emitted ... index=3, 4, 5 …`가 49까지 찍힌 뒤 `stream completed`로 끝나고, WebFlux는 끊는 순간 `stream cancelled`가 찍힌다.

#### T09 Backend 오류

| 시나리오 | direct | MVC 기본·`tuned` | WebFlux |
| --- | --- | --- | --- |
| 헤더 전 오류 (`failMode=BEFORE_HEADERS`) | 500 JSON | 500 JSON 그대로 전달 | 500 JSON 그대로 전달 |
| 헤더 후 오류 (`failMode=MID_STREAM`, 토큰 5개 후) | 연결 비정상 종료 (`curl: (18)`) | **chunked 스트림을 정상 종료** (클라이언트는 EOF만 봄) | 연결 비정상 종료 (`curl: (18)`) |

MVC Gateway를 거치면 스트림 중간 오류가 정상 종료처럼 보인다. 클라이언트는 **`done` 이벤트 수신 여부로 완료를 판정**해야 한다. React 클라이언트와 `sse-probe.mjs`는 이렇게 처리한다(`stream ended without done`).

#### T10 동시 연결

`count=10, delayMs=200`(2초 스트림), 워밍업 1라운드 + 측정 3라운드. TTFE ms p50 / p95 / max.

| 동시 | direct | mvc | mvc-vt | mvc-jetty | mvc-jetty-vt | webflux |
| --- | --- | --- | --- | --- | --- | --- |
| 10 | 211 / 221 / 221 | 218 / 233 / 233 | 232 / 234 / 234 | 211 / 212 / 212 | 220 / 223 / 224 | 231 / 236 / 236 |
| 100 | 226 / 232 / 234 | 230 / 264 / 266 | 230 / 238 / 241 | 226 / 233 / 236 | 228 / 233 / 233 | 224 / 231 / 234 |
| 500 | 225 / 236 / 252 | **2286 / 4355 / 4397** | 297 / 343 / 357 | **2274 / 4312 / 4321** | 243 / 257 / 269 | 252 / 266 / 272 |

모든 구성의 성공률은 100%다. 리소스(500 동시, 2초 스트림, 측정 3라운드 동안):

| 구성 | CPU 평균 / 최대 % | RSS 최대 MB | 스레드 최대 |
| --- | --- | --- | --- |
| direct (Backend) | 13.7 / 31.6 | 419 | 30 |
| mvc | 8.1 / 37.0 | 463 | 339 |
| mvc-vt | 44.9 / 126.1 | 591 | 147 |
| mvc-jetty | 6.9 / 21.0 | 530 | 243 |
| mvc-jetty-vt | 45.7 / 81.4 | 622 | 58 |
| webflux | 31.5 / 89.6 | 456 | 30 |

**장시간 스트림 (500 동시 × 20초, `count=100`)**: LLM 응답에 가까운 조건.

| 구성 | TTFE p50 / p95 (ms) | 전체 p95 (ms) | 소요 시간 | CPU 평균 / 최대 % | RSS MB | 스레드 |
| --- | --- | --- | --- | --- | --- | --- |
| direct | 265 / 279 | 20,449 | 20.5초 | 15.5 / 26.8 | 324 | 30 |
| mvc | **20,645 / 40,996** | **61,138** | **61.2초** | 3.4 / 20.9 | 375 | 326 |
| mvc-vt | 356 / 394 | 20,435 | 20.5초 | 34.5 / 107.3 | 369 | 114 |
| mvc-jetty-vt | 285 / 324 | 20,365 | 20.6초 | 34.2 / 86.1 | 457 | 94 |
| webflux | 273 / 308 | 20,392 | 20.5초 | 28.2 / 58.0 | 355 | 30 |

해석:

- **MVC 플랫폼 스레드**: 스트림 하나가 Tomcat 스레드 하나를 스트림이 끝날 때까지 점유한다. 동시 스트림 상한은 `server.tomcat.threads.max`(200)이고, 나머지는 큐에서 기다린다. 500 × 20초에서 3배치로 처리되어 61초가 걸렸다. CPU가 낮게 나온 것은 일을 적게 해서가 아니라 대기 중이어서다.
- **Jetty 기본 커넥션 풀**: Jetty `HttpClient.maxConnectionsPerDestination` 기본값은 64다. 풀 크기를 늘리기 전에는 100 동시에서 TTFE p95 2,243ms, 500 동시에서 14,374ms였다. 스트림마다 업스트림 커넥션 하나를 계속 점유하기 때문이다. `JettyClientConfig`(`poc.jetty-client.max-connections-per-destination`, 기본 2048)로 해결했다.
- **가상 스레드**: 스레드 상한 문제는 해결되지만, CPU는 WebFlux보다 약간 높고(장시간 기준 평균 34% vs 28%) RSS도 약간 높았다.
- WebFlux는 연결 수와 무관하게 스레드 30개를 유지했다.

k6 교차 검증 (`scripts/load-test.js`, Docker에서 `host.docker.internal`로 실행, 500 VU × 2회):

| 대상 | stream_complete | TTFB med / p95 |
| --- | --- | --- |
| direct | 100% | 207ms / 223ms |
| mvc | 첫 실행 92.3% (77건 status 0), 이후 4회 연속 100% | 2.25s / 4.28s (첫 실행) |
| mvc `tuned` | 100% | 212ms / 242ms |
| webflux | 100% (4회) | 212ms / 228ms |

MVC 첫 실행의 연결 실패 77건은 재현되지 않았고 원인도 확인하지 못했다. Tomcat `accept-count`(100)를 넘는 연결 폭주 또는 Docker Desktop 포트 포워딩 때문일 수 있지만 검증하지 않았다.

#### T12 압축 / 앞단 프록시 버퍼링

| 구성 | TTFE p50 (ms) | 간격 p50 / p95 (ms) | lag p50 / p95 (ms) |
| --- | --- | --- | --- |
| MVC + `server.compression` (gzip, `text/event-stream`) | 210.7 | 204.5 / 205.5 | 1 / 2 |
| WebFlux + `server.compression` | 211.4 | 201.8 / 207.3 | 2 / 4 |
| nginx 기본 → MVC | 216.6 | 203.8 / 206.2 | 2 / 6 |
| nginx `proxy_buffering on` + `X-Accel-Buffering` 무시 → MVC | 218.6 | 204.3 / 206.0 | 2 / 5 |
| nginx gzip → MVC | 215.5 | 204.5 / 206.7 | 3 / 4 |
| nginx 기본 → WebFlux | 217.2 | 203.5 / 206.2 | 2 / 4 |
| nginx 버퍼링 강제 → WebFlux | 216.5 | 204.5 / 217.6 | 6 / 16 |
| nginx gzip → WebFlux | 236.1 | 204.4 / 213.6 | 7 / 16 |

`tuned`는 나중에 따로 측정했다. 같은 시점의 `tuned` 단독 값과 함께 비교해야 한다. 이때는 서버 4개와 nginx 컨테이너가 동시에 떠 있어서 lag가 앞의 표보다 전반적으로 높다.

| 구성 (2차 측정) | TTFE p50 (ms) | 간격 p50 / p95 (ms) | lag p50 / p95 (ms) |
| --- | --- | --- | --- |
| MVC `tuned` 단독 (기준) | 234.6 | 204.4 / 208.8 | 6 / 15 |
| MVC `tuned` + `server.compression` | 231.9 | 205.7 / 217.0 | 11 / 17 |
| nginx 기본 → MVC `tuned` | 241.2 | 206.5 / 213.3 | 11 / 21 |
| nginx 버퍼링 강제 → MVC `tuned` | 241.7 | 205.6 / 211.5 | 10 / 21 |
| nginx gzip → MVC `tuned` | 250.5 | 204.4 / 216.4 | 9 / 20 |

모든 경우 `smoke-test.sh`의 점진 전달 검사(1.1초 안에 토큰 5개)를 통과했다.

Tomcat과 Reactor Netty의 gzip은 flush마다 sync-flush를 해서 이벤트 단위 전달이 유지됐다. nginx 1.27은 `proxy_buffering on`에서도 업스트림 데이터를 받는 대로 빠른 클라이언트에 넘겼다. 버퍼링은 클라이언트가 느릴 때 드러나는데, 이 측정에서는 재현되지 않았다. Backend는 앞단 프록시용으로 `X-Accel-Buffering: no`를 보내고, 두 Gateway 모두 이 헤더를 그대로 전달한다. 설정 파일은 `scripts/nginx/nginx.conf`.

## 테스트 환경

| 항목 | 값 |
| --- | --- |
| OS / HW | macOS 27.0.1, Apple M1 Pro (10 cores), 32 GB |
| JDK / JVM 옵션 | Microsoft OpenJDK 21.0.12.1, 모든 서버 `-Xms512m -Xmx1g`, 그 외 기본값 |
| HTTP | HTTP/1.1 평문, localhost |
| Spring | Boot 3.5.6, Spring Framework 6.2.11, Spring Cloud 2025.0.3 (Gateway 4.3.5) |
| 서버 / 클라이언트 라이브러리 | Tomcat 10.1.46, Reactor Netty 1.2.10, Jetty client 12.0.27 |
| 측정 도구 | `scripts/sse-probe.mjs` (Node 24.19.0), k6 1.3.0 (Docker), nginx 1.27-alpine (Docker) |
| Backend | `chat.stream.log-each-event=false` (이벤트별 로그가 측정에 섞이지 않도록) |
| 리소스 | `ps`의 `%cpu`(코어 1개 = 100%, macOS는 감쇠 평균이라 대략적) / RSS, actuator `jvm.threads.live`, 0.5초 간격 샘플링 |

비교 대상:

| 라벨 | 구성 |
| --- | --- |
| direct | Backend(:8081) 직접 호출 (기준선) |
| mvc | Gateway MVC 기본값: JDK HttpClient, 플랫폼 스레드(Tomcat max 200) |
| mvc-vt | mvc + `spring.threads.virtual.enabled=true` |
| mvc-jetty | `spring.http.client.factory=jetty`, `read-timeout=10m`, `poc.jetty-client.max-connections-per-destination=2048` |
| mvc-jetty-vt (= `tuned`) | mvc-jetty + 가상 스레드. `application-tuned.yml`과 동일 |
| webflux | Gateway WebFlux 기본값 + `connect-timeout=2000`, `response-timeout=10s` |

## 한계

- 단일 머신(클라이언트·Gateway·Backend 동거)에서, 라운드 수가 적은 측정이다. 운영 결정 전에 목표 동시 연결 수로 별도 호스트에서 재측정해야 한다.
- `ps %cpu`는 macOS에서 감쇠 평균이라 순간값이 아니다. 같은 방식으로 측정한 값끼리만 비교해야 한다.
- HTTP/1.1만 측정했다(HTTP/2·TLS 미측정).
- k6 MVC 첫 실행의 연결 실패 원인은 확인하지 못했다.

## 재현 방법

```bash
./gradlew bootJar
java -Xms512m -Xmx1g -jar apps/ai-backend/build/libs/ai-backend-0.0.1-SNAPSHOT.jar --chat.stream.log-each-event=false
java -Xms512m -Xmx1g -jar apps/gateway-mvc/build/libs/gateway-mvc-0.0.1-SNAPSHOT.jar                                   # mvc :8080
SPRING_PROFILES_ACTIVE=tuned java -Xms512m -Xmx1g -jar apps/gateway-mvc/build/libs/gateway-mvc-0.0.1-SNAPSHOT.jar --server.port=8090  # tuned
java -Xms512m -Xmx1g -jar apps/gateway-webflux/build/libs/gateway-webflux-0.0.1-SNAPSHOT.jar                           # webflux :8082

scripts/smoke-test.sh                                                                                  # T01-T03, T11
node scripts/sse-probe.mjs --target http://localhost:8080 --delay 0 --repeat 30 --warmup 5             # T04
node scripts/sse-probe.mjs --target http://localhost:8080 --count 160                                  # T05
node scripts/sse-probe.mjs --target http://localhost:8080 --count 50 --abort-after 3 --repeat 5        # T06
node scripts/sse-probe.mjs --target http://localhost:8080 --fail-mode MID_STREAM                       # T09
node scripts/sse-probe.mjs --target http://localhost:8080 --concurrency 500 --warmup 1 --repeat 3 \
  --pid <gateway pid> --actuator http://localhost:8080                                                 # T10
k6 run -e TARGET=http://localhost:8080 -e VUS=500 scripts/load-test.js                                 # T10 (k6)
docker run --rm -p 8180-8182:8180-8182 -p 8280-8282:8280-8282 \
  -v $PWD/scripts/nginx/nginx.conf:/etc/nginx/nginx.conf:ro nginx:1.27-alpine                          # T12
```

변형 구성은 위 jar에 인자를 붙여 띄운다. 예: `--server.port=8091 --spring.http.client.read-timeout=10s`, `--spring.http.client.factory=simple`, `--server.compression.enabled=true --server.compression.mime-types=text/event-stream --server.compression.min-response-size=0`.
