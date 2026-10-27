# Spring Gateway AI SSE Streaming PoC

AI 채팅 백엔드의 SSE 응답을 Spring Cloud Gateway **Server MVC**와 **Server WebFlux**가 제대로 전달하는지 같은 조건에서 비교하는 Kotlin + Spring Boot 3.5.6 모노레포다. 버튼 하나로 16개 시나리오를 k6로 실행하고, 성공/실패 판정표와 요청별 기록을 화면에서 볼 수 있다. 모든 Kotlin 패키지의 공통 루트는 `io.github.sejoung`이다.

**결론: 기존 MVC Gateway를 유지하고 `tuned` 구성을 적용한다.** MVC 기본 설정은 사용자 중단이 Backend로 전파되지 않고 동시 스트림이 Tomcat 스레드 수에서 막힌다. 두 문제 모두 설정으로 해결됐다. WebFlux로 옮겨서 추가로 얻는 것은 스트림 중간 오류 감지 하나뿐이었다. 근거는 [`docs/results.md`](docs/results.md)(브라우저용 [`docs/results.html`](docs/results.html))에 있다.

## 목차

- [빠르게 시작하기](#빠르게-시작하기)
- [테스트 리포트 화면](#테스트-리포트-화면)
- [시나리오와 판정 기준](#시나리오와-판정-기준)
- [결과 요약](#결과-요약)
- [의사결정 기준](#의사결정-기준)
- [구성](#구성)
- [구현 내용](#구현-내용)
- [개별 실행과 테스트](#개별-실행과-테스트)
- [PoC 범위에서 제외하는 항목](#poc-범위에서-제외하는-항목)
- [구현 이력](#구현-이력)

## 빠르게 시작하기

```bash
docker compose up --build    # 처음 빌드는 몇 분 걸린다. Docker에 메모리 5GB 이상 권장
open http://localhost:5173   # "테스트 리포트" 탭에서 "빠른 실행" 또는 "전체 실행"
docker compose down          # 종료. 실행 기록은 runner-data 볼륨에 남는다 (지우려면 down -v)
```

JDK나 Node 없이 Docker만 있으면 된다. 컨테이너 13개가 뜨고 메모리는 약 4.2GB를 쓴다.

| 서비스 | 주소 | 설명 |
| --- | --- | --- |
| client | http://localhost:5173 | 테스트 리포트와 스트림 체험 화면 |
| test-runner | http://localhost:8070/api | 버튼을 받아 `k6 run`을 실행하고 k6 원시 데이터로 판정한다 |
| ai-backend | http://localhost:8081 | 모의 토큰 스트림 |
| gateway-mvc | http://localhost:8080 | MVC 기본 설정 |
| gateway-mvc-tuned | http://localhost:8090 | MVC `tuned` 프로필 |
| gateway-webflux | http://localhost:8082 | WebFlux |
| pit-* (6개) | 내부 전용 | "설정을 잘못하면 실패하는 항목"을 재현하는 MVC 구성 |
| front-proxy | 내부 전용 | 시나리오 16의 nginx 변형 |

테스트 러너의 구조, k6 파라미터, 원시 데이터 형식, API, 시나리오 추가 방법, 문제 해결은 [`docs/test-runner.md`](docs/test-runner.md)에 있다.

## 테스트 리포트 화면

- **전체 실행**은 판정표 16개 시나리오 × 대상 4개와 설정 함정 6개를 실행한다(약 12분). **빠른 실행**은 핵심 7개 시나리오만 실행한다(1, 2, 7, 8, 9, 10, 14번, 약 1.5분).
- 실행 중에는 진행률과 k6 로그가 실시간으로 나온다. 진행 상황도 SSE로 받는다.
- 끝나면 대상별 성공/실패 개수, **판정표**, 실패한 항목의 이유와 해결 방법, 설정 함정 결과가 나온다.
- 판정표 칸을 누르면 그 건의 상세가 열린다.
  - 판정 기준과 근거
  - 측정값 (첫 토큰, 응답 완료, 토큰 간격, 지연, 중단 후 Backend 결과, Gateway 리소스)
  - 요청별 기록. 행을 누르면 토큰별 타임라인이 나온다
  - "이 건만 다시 실행", k6 원시 데이터 받기, k6 로그 보기
- 실행 기록이 남아서 이전 실행과 비교할 수 있다. `?run=<실행ID>&case=<케이스ID>` 링크로 특정 실행과 상세를 공유할 수 있다.
- "스트림 체험" 탭에서는 브라우저에서 Gateway로 직접 스트림을 요청해 볼 수 있다.

판정표 칸의 뜻은 다음과 같다.

| 표시 | 뜻 |
| --- | --- |
| 성공 / 실패 | 판정 기준을 만족했는지 |
| 기준값 | 비교 기준으로 잰 값 (3번의 Backend 직접). 판정 없음 |
| 측정 불가 | 대상 서비스가 응답하지 않았거나 k6가 비정상 종료했다 |
| 실행 중 / 대기 / 건너뜀 | 진행 상태. 건너뜀은 중지했거나 실행기가 재시작된 경우 |
| — | 해당 없음 (예: Backend 직접의 CORS) |

설정 함정 표는 반대로 읽는다. **실패가 나와야 예상대로**다.

자주 나오는 용어는 다음과 같다.

| 용어 | 뜻 |
| --- | --- |
| 첫 토큰 (TTFE) | 요청을 보낸 뒤 첫 토큰을 받기까지 걸린 시간 |
| 지연 (lag) | 클라이언트 수신 시각 − Backend가 토큰에 기록한 생성 시각. 중간에서 버퍼링하면 커진다 |
| p50 / p95 | 중앙값 / 느린 쪽 5%의 경계값 |
| 워밍업 | JVM을 데우려고 먼저 보내는 요청. 원시 데이터에는 남고 판정에서는 뺀다 |

## 시나리오와 판정 기준

대상은 Backend 직접(기준선), MVC 기본, MVC `tuned`, WebFlux 4개다. 시나리오 5, 6, 14, 15, 16은 Gateway 3개만 대상으로 한다. 각 시나리오의 k6 실행 조건은 [`docs/test-runner.md`](docs/test-runner.md#3-시나리오별-실행-조건)에 있다.

| # | 시나리오 | 판정 기준 | 관련 검증 |
| --- | --- | --- | --- |
| 1 | 정상 응답 | 200, `text/event-stream`, `Cache-Control: no-cache`, 토큰 10개 + done이 순서대로 | T01–T03 |
| 2 | 버퍼링 없음 | 첫 토큰이 응답 완료보다 1초 이상 먼저 도착 (2초 스트림) | T02–T03 |
| 3 | 추가 지연 | 토큰 간격 0ms에서 첫 토큰 p50이 Backend 직접 대비 10ms 이상 늦지 않음 | T04 |
| 4 | 30초 이상 스트림 | 토큰 160개 × 200ms(약 33초) 스트림이 끊기지 않고 done까지 도착 | T05 |
| 5 | 연결 타임아웃 | Backend에 연결할 수 없을 때 3.5초 안에 5xx 응답 (connect-timeout 2초) | 타임아웃 |
| 6 | 첫 토큰 지연 | 첫 토큰이 12초 뒤에 나와도 스트림이 유지되고 done까지 도착 | 타임아웃 |
| 7 | 사용자 중단 | 토큰 3개 수신 후 연결을 끊으면 1초 안에 Backend가 토큰 생성을 멈춤 | T06 |
| 8 | 헤더 전 오류 | Backend가 응답 헤더 전에 500을 내면 클라이언트도 500을 받음 | T09 |
| 9 | 스트림 중간 오류 | Backend가 토큰 5개 후 오류로 끊으면 클라이언트가 연결 오류로 감지 | T09 |
| 10 | 100개 동시 | 전부 완료 + 첫 토큰 p95 0.5초 이내, 최대 1초 이내 | T10 |
| 11 | 500개 동시 | 전부 완료 + 첫 토큰 p95 0.5초 이내, 최대 1초 이내 | T10 |
| 12 | 500개 동시 × 20초 | 20초 스트림 500개가 한꺼번에 연결해도 전부 완료 + 첫 토큰 p95 0.5초, 최대 1초 이내 | T10 |
| 13 | 500 VU 반복 | 500개 동시 × 2회를 3번 반복해서 모든 실행의 완료율 99% 이상 | T10 |
| 14 | CORS | `http://localhost:5173` preflight는 200 + 허용 헤더, 다른 Origin은 403 | T11 |
| 15 | Gateway gzip | Gateway가 gzip으로 압축해도 첫 토큰이 응답 완료보다 1초 이상 먼저 도착 | T12 |
| 16 | 앞단 nginx | nginx 기본·버퍼링 강제·gzip 세 설정 모두 첫 토큰이 응답 완료보다 1초 이상 먼저 도착 | T12 |

"관련 검증"은 처음 계획했던 검증 ID다(T01 Backend 직접, T02·T03 Gateway 경유, T04 최초 이벤트 지연, T05 장시간 스트림, T06 클라이언트 abort, T09 Backend 오류, T10 동시 연결, T11 CORS, T12 압축·버퍼링).

**설정 함정 6개**: 흔히 쓰는 설정으로 바꾸면 실제로 실패하는지 확인한다.

| 구성 | 확인 시나리오 | 실패하는 이유 |
| --- | --- | --- |
| MVC + JDK 클라이언트 + `read-timeout=10s` | 4 | JDK 클라이언트의 read-timeout은 응답 전체 시간 제한이다 |
| MVC + Jetty 클라이언트, read-timeout 미설정 | 4 | Spring의 Jetty 팩토리는 기본 10초를 전체 시간 제한으로 쓴다 |
| MVC tuned + Jetty 커넥션 풀 64 | 10 | 스트림마다 Backend 연결을 하나씩 점유하는데 풀이 64개다 |
| MVC tuned + 플랫폼 스레드 | 11 | Tomcat 스레드 200개 상한이 그대로다 |
| MVC + 가상 스레드만 (JDK 클라이언트 유지) | 7 | 스레드 문제만 풀리고 JDK 클라이언트의 drain은 남는다 |
| MVC + simple 클라이언트 | 7 | simple 클라이언트도 응답을 닫을 때 drain한다 |

## 결과 요약

| 구성 | 성공 | 실패 | 실패한 시나리오 |
| --- | --- | --- | --- |
| MVC 기본 | 12 | 4 | 7 사용자 중단, 9 스트림 중간 오류, 11 500개 동시, 12 500개 동시 × 20초 |
| MVC `tuned` | 15 | 1 | 9 스트림 중간 오류 (클라이언트가 done 이벤트로 판정해 보완) |
| WebFlux | 15 | 1 | 6 첫 토큰 지연 (`response-timeout` 10초 설정값. 늘리면 해결) |
| 설정 함정 | — | 6/6 | 모두 예상대로 실패 |

- 위 표는 docker compose 환경의 전체 실행 결과다(실행 `20261027-092557-twb`).
- 호스트에서 스크립트로 잰 결과도 판정은 같다. 다만 MVC 기본의 13번은 호스트에서 5회 중 1회 연결 실패로 "불안정"이었다. 그래서 호스트 기준으로는 성공이 11개다.
- ms 단위 측정값, 원인 분석, Docker 재측정에서 새로 발견한 것(Tomcat 연결 대기열 넘침 등)은 [`docs/results.md`](docs/results.md)에 있다.

## 의사결정 기준

- **MVC 유지**: 스트리밍이 이벤트 단위로 전달되고, 목표 동시 연결 수·지연·취소 처리 기준을 만족하며, 운영 복잡도가 낮을 때.
- **WebFlux 전환**: 같은 조건에서 연결 수가 늘 때 리소스 효율이나 지연이 유의미하게 개선되고, Security와 커스텀 필터 마이그레이션 비용까지 고려해도 이점이 충분할 때.

**판단**: MVC 기본은 유지 조건을 만족하지 못한다(7, 11, 12번 실패). `tuned`는 9번을 빼고 만족하며, 9번은 클라이언트에서 보완된다. WebFlux가 `tuned`보다 추가로 성공하는 항목은 9번 하나다. 500개 동시까지는 지연과 리소스 차이도 작았다. 따라서 MVC를 유지한다. 재검토 조건은 [`docs/results.md`](docs/results.md#결론과-권장-설정)에 있다.

`tuned` 구성(`apps/gateway-mvc/src/main/resources/application-tuned.yml`)은 다음과 같다.

1. `spring.http.client.factory=jetty`: 기본 JDK 클라이언트는 사용자 중단을 Backend로 전파하지 않는다.
2. `spring.http.client.read-timeout`을 최대 스트림 길이 이상으로 설정(10m): Jetty는 이 값을 전체 시간 제한으로 쓰고, 설정하지 않으면 10초다.
3. Jetty `maxConnectionsPerDestination` 2048 (`poc.jetty-client.max-connections-per-destination`, Jetty 기본값은 64).
4. `spring.threads.virtual.enabled=true`: 스트림당 요청 스레드 1개를 점유하는 구조라 플랫폼 스레드 200개가 상한이 된다.
5. `server.tomcat.accept-count: 1000`: 500개가 한꺼번에 연결하면 기본값 100인 연결 대기열이 넘친다.
6. 클라이언트는 `done` 이벤트로 정상 완료를 판정한다.

> **핵심 원칙:** SSE는 HTTP 전송 형식이고 WebFlux는 서버 처리 모델이다. SSE를 사용한다는 이유만으로 Gateway를 WebFlux로 바꿀 필요는 없다. 두 구현을 같은 조건으로 비교하여 결정한다.

## 구성

### 기술 스택

| 구분 | 선택 |
| --- | --- |
| 서버 | Kotlin 2.1, Java 21, Gradle Kotlin DSL 8.14 |
| Spring Boot | **3.5.6**, 모든 서버 모듈 동일 |
| Spring Cloud | **2025.0.3** (Gateway 4.3.5). Boot 3.5.x 호환 릴리스 트레인 |
| Gateway A | Spring Cloud Gateway Server MVC (Tomcat) |
| Gateway B | Spring Cloud Gateway Server WebFlux (Reactor Netty) |
| AI Backend | Spring WebFlux + Reactor Flux + SSE (LLM 모의 구현) |
| Client | React 19 + TypeScript + Vite |
| 테스트 러너 | Node 24 + k6 v2.3.0 (xk6-sse v0.2.0) |
| 검증 | JUnit 5, Reactor Test, Vitest, node:test, curl |

버전은 `gradle.properties`에서 관리한다. Gateway 4.3.5의 스타터는 Boot 3.5.15에 의존한다. 그래서 Gradle 기본 platform 해석을 쓰면 Boot jar가 3.5.15로 올라간다. 이를 막으려고 `io.spring.dependency-management`로 Boot BOM(3.5.6)을 기준으로 삼고, Cloud BOM은 Spring Cloud 아티팩트만 추가하게 했다. MVC와 WebFlux Gateway 스타터는 **같은 서버 모듈에 섞지 않는다**.

### 모노레포 구조

```text
spring-gateway-streaming-poc/
├── docker-compose.yml          # 전체 구성 한 번에 실행
├── docker/
│   ├── spring.Dockerfile       # Spring 앱 3개 빌드 (target별 이미지)
│   └── nginx/front-proxy.conf  # 앞단 프록시 변형 (시나리오 16)
├── apps/
│   ├── ai-backend/             # io.github.sejoung.ai.backend (:8081)
│   ├── gateway-mvc/            # io.github.sejoung.gateway.mvc (:8080)
│   ├── gateway-webflux/        # io.github.sejoung.gateway.webflux (:8082)
│   ├── client/                 # React (:5173). 테스트 리포트 + 스트림 체험
│   └── test-runner/            # k6 실행기와 API (:8070)
│       ├── k6/sse-case.js      #   케이스 하나 = 이 스크립트 한 번 실행
│       └── src/                #   catalog.mjs(시나리오·판정 기준), judge.mjs(판정), runner.mjs, server.mjs
├── scripts/                    # compose 없이 호스트에서 측정할 때 쓰는 스크립트
│   ├── smoke-test.sh           #   curl 스모크 (T01–T03, T11)
│   ├── sse-probe.mjs           #   TTFE/간격/lag/취소/동시 연결 측정 (Node, 의존성 없음)
│   ├── load-test.js            #   k6 http 기반 동시 연결 부하
│   └── nginx/nginx.conf        #   호스트 측정용 nginx 변형
├── docs/
│   ├── results.md / results.html  # 측정 결과와 결론
│   └── test-runner.md             # 테스트 러너 상세 가이드
└── settings.gradle.kts, build.gradle.kts, gradle.properties, gradlew, gradle/
```

### 요청 흐름

```text
브라우저 (:5173) ──"스트림 체험"──▶ Gateway MVC (:8080) / tuned (:8090) / WebFlux (:8082) ──▶ AI Backend (:8081)
        │
        └─"테스트 리포트"─▶ test-runner (:8070) ──k6──▶ 같은 Gateway들, pit-* , front-proxy ──▶ AI Backend
```

**요청**

```http
POST /api/chat/stream
Content-Type: application/json
Accept: text/event-stream

{"message":"안녕하세요","count":10,"delayMs":200}
```

**응답 예시** (`\n\n`으로 이벤트 구분)

```text
event:token
data:{"index":0,"content":"token-0","emittedAt":1793075706898}

event:token
data:{"index":1,"content":"token-1","emittedAt":1793075707109}

event:done
data:{"total":10,"elapsedMs":2043}

```

- `count`개의 `token` 이벤트와 마지막 `done` 이벤트를 보낸다.
- `emittedAt`은 Backend가 이벤트를 만든 시각(epoch ms)이다. 같은 머신에서 측정하면 수신 시각에서 빼서 이벤트별 지연을 구할 수 있다.
- Spring의 SSE 인코더는 `field:value`처럼 콜론 뒤 공백 없이 쓴다. 공백이 있는 형식과 마찬가지로 SSE 표준이다.
- Gateway는 이벤트를 파싱하거나 다시 직렬화하지 않고 HTTP 응답 스트림을 그대로 프록시한다.

## 구현 내용

### AI Backend

- `POST /api/chat/stream`, `produces = text/event-stream`. 요청 DTO는 `ChatRequest(message, count = 10, delayMs = 200, failMode = NONE)`.
- `Flux.range(0, count).delayElements(delayMs)`로 결정적인 모의 토큰을 만들고 `concatWith`로 `done`을 붙인다.
- 상한: `chat.stream.max-count`(10000), `max-delay-ms`(60000), `max-duration`(10m). 넘으면 400.
- 오류 주입: `"failMode":"BEFORE_HEADERS"`(헤더 전 500), `"MID_STREAM"`(토큰 절반 후 스트림 오류).
- `X-Request-Id` 요청 헤더를 그대로 쓰고(없으면 생성) 응답 헤더로 돌려준다. `Cache-Control: no-cache`, `X-Accel-Buffering: no`를 붙인다.
- 관측: `GET /internal/streams/{requestId}`가 시작·마지막 이벤트·종료 시각과 결과(`COMPLETED`/`CANCELLED`/`FAILED`)를 돌려준다. Gateway는 이 경로를 라우팅하지 않는다. 측정 도구가 Backend에 직접 호출해서 취소 전파를 잰다.

### Gateway

- 두 Gateway 모두 `/api/chat/**`를 Backend로 경로 변경 없이 라우팅한다(`poc.backend-url`). 인증·인가 필터와 응답 본문을 모으는 필터(`ModifyResponseBody` 등)는 쓰지 않는다.
- CORS는 로컬 개발용으로 `/api/chat/**`에만 적용한다(`poc.cors.allowed-origins`). MVC는 `CorsFilter`, WebFlux는 `CorsWebFilter`를 쓴다.
- `testroutes` 프로필(compose에서 사용)은 응답 없는 주소로 가는 `/unreachable/api/chat/**` 라우트를 추가한다. 시나리오 5(연결 타임아웃)용이다.

구현하면서 확인한 동작(자세한 내용은 `docs/results.md`)은 다음과 같다.

| | Gateway MVC | Gateway WebFlux |
| --- | --- | --- |
| 라우트 설정 | `spring.cloud.gateway.server.webmvc.routes` | `spring.cloud.gateway.server.webflux.routes` |
| 연결 타임아웃 | `spring.http.client.connect-timeout: 2s` | `httpclient.connect-timeout: 2000` |
| 응답 타임아웃 | `spring.http.client.read-timeout`. JDK·Jetty 클라이언트에서는 **응답 전체** 시간 제한이라 최대 스트림 길이보다 길어야 한다. Jetty는 설정하지 않으면 10초 | `httpclient.response-timeout: 10s`. **응답 헤더 도착까지**만 적용된다(사실상 첫 토큰 대기 제한) |
| 클라이언트 중단 | 기본 JDK 클라이언트는 `close()`에서 남은 본문을 drain해서 **Backend 취소가 전파되지 않는다**. Jetty 클라이언트는 전파된다 | 즉시 전파 |
| 동시 스트림 | 스트림당 요청 스레드 1개를 점유한다. 플랫폼 스레드에서는 `server.tomcat.threads.max`(200)가 상한이다. 한꺼번에 몰리면 `accept-count`(100)도 넘친다 | 이벤트 루프 |
| 스트림 중간 오류 | 클라이언트에 정상 종료처럼 보인다 | 연결 오류로 전달된다 |

MVC의 기본 프로필은 비교 기준선으로 Gateway 기본값(JDK 클라이언트, 플랫폼 스레드)을 유지한다. 문제를 해결한 구성은 `tuned` 프로필이다([의사결정 기준](#의사결정-기준) 참고).

### Client

- **테스트 리포트**(`src/runner/`): test-runner API로 실행·조회하고, 진행 상황은 `EventSource`로 받는다.
- **스트림 체험**(`src/playground/`): Gateway 선택, 메시지·`count`·`delayMs`, 시작/중단, 실시간 토큰과 이벤트별 수신 시각을 보여준다.
  - 브라우저 기본 `EventSource`는 POST JSON과 임의 요청 헤더를 지원하지 않는다. 그래서 `fetch()` + `ReadableStream` + `TextDecoder`로 받는다.
  - 청크와 이벤트 경계가 어긋날 수 있으므로 버퍼를 누적하고 빈 줄 기준으로 파싱한다(`src/sse.ts`, CRLF 처리 포함).
  - 중단은 `AbortController.abort()`다. `done` 없이 끝난 스트림은 오류로 표시한다.
  - Gateway 주소는 `VITE_MVC_GATEWAY_URL`, `VITE_TUNED_GATEWAY_URL`, `VITE_WEBFLUX_GATEWAY_URL`로 바꿀 수 있다(`.env.example`).

### Test runner

- 시나리오 하나 × 대상 하나를 `k6 run` 한 번으로 실행한다. k6에는 SSE 이벤트를 받을 때마다 시각을 잴 수 있도록 [xk6-sse](https://github.com/phymbert/xk6-sse) 확장을 넣어 빌드했다.
- 요청마다 k6 JSON 출력에 원시 데이터 한 줄(`sse_request_ms`)을 남긴다. 메타데이터에는 요청 ID와 상세(상태, 결과, 토큰별 수신 시각·지연, 중단 시 Backend 기록)가 들어 있다. 판정은 이 원시 데이터만으로 계산한다.
- compose의 세 Gateway는 시나리오 15를 위해 응답 압축을 켜 두었다. 압축은 클라이언트가 `Accept-Encoding: gzip`을 보낼 때만 적용되고, 나머지 시나리오는 `identity`로 요청한다.
- Docker Desktop VM 안에서 측정하므로 ms 수치는 호스트 측정(`docs/results.md`)과 다를 수 있다. 성공/실패 판정은 같게 나오는 것을 확인했다.

상세는 [`docs/test-runner.md`](docs/test-runner.md)에 있다.

## 개별 실행과 테스트

compose 없이 각 서버를 직접 띄우려면 JDK 21과 Node 22 이상이 필요하다.

```bash
# 각각 별도 터미널
./gradlew :apps:ai-backend:bootRun
./gradlew :apps:gateway-mvc:bootRun
./gradlew :apps:gateway-webflux:bootRun
SPRING_PROFILES_ACTIVE=tuned ./gradlew :apps:gateway-mvc:bootRun --args='--server.port=8090'

cd apps/client && npm install && npm run dev
```

Gradle은 `gradle/gradle-daemon-jvm.properties`로 Java 21 데몬을 쓰고, 모듈은 Java 21 toolchain으로 컴파일한다. 이 방식에서는 "스트림 체험" 탭과 `scripts/`의 측정 스크립트를 쓸 수 있다. "테스트 리포트"는 test-runner가 필요하므로 compose로 띄운다([개발 모드](docs/test-runner.md#9-개발-모드)).

테스트:

```bash
./gradlew test                        # Backend(StepVerifier/WebTestClient), Gateway 스트리밍·CORS·취소 통합 테스트
cd apps/client && npm test            # SSE 파서
cd apps/test-runner && npm test       # 판정 로직
scripts/smoke-test.sh                 # 실행 중인 서버 대상 curl 스모크
node scripts/sse-probe.mjs --help     # 호스트 측정 옵션
```

curl로 직접 확인:

```bash
curl -N -sS -X POST http://localhost:8080/api/chat/stream \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"message":"hello","count":10,"delayMs":200}'
# 포트: 8081 Backend 직접, 8080 MVC, 8090 MVC tuned, 8082 WebFlux
```

## PoC 범위에서 제외하는 항목

- Spring Security, JWT 발급·검증, OAuth2 및 인증·인가 테스트
- 실제 LLM API 연동 및 모델별 토큰 생성 성능 비교
- 운영 환경의 인증 필터 마이그레이션
- HTTP/2, TLS

이 프로젝트는 **SSE 프록시의 전달 지연, 연결 유지, 취소 전파 및 리소스 효율**을 비교한다. 실제 서비스에서 WebFlux로 전환하기로 결정하면 Security 설정(`SecurityFilterChain` → `SecurityWebFilterChain`)과 커스텀 필터 호환성은 별도 작업으로 검증한다. CORS는 로컬 React 개발 서버에서 Gateway로 직접 요청하기 위한 설정이며, 인증 테스트와는 무관하다.

## 구현 이력

- [x] Gradle 멀티모듈 초기화: Kotlin, Boot 3.5.6, Java 21, 호환 Spring Cloud BOM
- [x] AI Backend: SSE 토큰/완료 이벤트, 취소 로깅, 오류 주입, 스트림 기록 조회
- [x] MVC·WebFlux Gateway 라우팅, SSE 전달, 로컬 개발용 CORS
- [x] React 스트림 파서, 실시간 표시, 취소 기능
- [x] 연결 취소, 오류, 타임아웃, 압축/버퍼링, 동시 접속 측정 (호스트, `scripts/`)
- [x] `docs/results.md` 작성, MVC 유지 vs WebFlux 전환 결론
- [x] MVC `tuned` 프로필과 Jetty 커넥션 풀 설정
- [x] docker compose 전체 구성 (Gateway 비교 대상 3개, 설정 함정 6개, nginx 앞단)
- [x] k6(xk6-sse) 테스트 러너, 성공/실패 리포트 화면, 건별 상세와 원시 데이터
- [x] docker compose 재측정, Tomcat `accept-count` 보강
