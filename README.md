# Spring Gateway AI SSE Streaming PoC

Kotlin + **Spring Boot 3.5.6** 기반 모노레포. AI 채팅 백엔드의 SSE 응답을 Spring Cloud Gateway **Server MVC와 Server WebFlux**가 각각 얼마나 지연 없이 클라이언트로 전달하는지 비교한다. 모든 Kotlin 패키지의 공통 루트는 **`io.github.sejoung`**이다.

> 구현과 측정이 완료되었다. 결과와 결론은 [`docs/results.md`](docs/results.md)에 있다.
>
> **바로 해보기:** `docker compose up --build` → http://localhost:5173 → "빠른 실행" 또는 "전체 실행". 테스트가 k6로 실행되고 성공/실패 판정표가 화면에 나온다. 칸을 누르면 요청별·토큰별 기록과 k6 원시 데이터를 볼 수 있다. 자세한 내용은 [한 번에 실행하기](#한-번에-실행하기-docker-compose).

## 목표

1. 백엔드에서 `Flux<ServerSentEvent<...>>`로 토큰을 일정 간격으로 발행한다.
2. MVC Gateway와 WebFlux Gateway가 응답을 모으지 않고 순차 전달하는지 확인한다.
3. 최초 이벤트 도착 시간(TTFE), 이벤트 간 지연, 동시 연결 수, 취소 전파, 오류/타임아웃을 비교한다.
4. **실측 결과**로 기존 MVC 유지 또는 WebFlux 전환 여부를 결정한다.

## 기술 스택

| 구분 | 선택 |
| --- | --- |
| 서버 | Kotlin, Java 21, Gradle Kotlin DSL |
| Spring Boot | **3.5.6**, 모든 서버 모듈 동일 |
| Spring Cloud | **2025.0.3** (Gateway 4.3.5). Boot 3.5.x 호환 릴리스 트레인 |
| Gateway A | Spring Cloud Gateway Server MVC |
| Gateway B | Spring Cloud Gateway Server WebFlux |
| AI Backend | Spring WebFlux + Reactor Flux + SSE (LLM 모의 구현) |
| Client | React + TypeScript + Vite |
| 검증 | curl, JUnit 5, Reactor Test, k6 등 부하 도구 |

Spring Cloud 버전은 Spring Boot 버전과 별도로 관리한다. Cloud BOM을 적용하고 실제 사용할 버전을 명시적으로 고정한다. MVC와 WebFlux Gateway 스타터를 **같은 서버 모듈에 혼합하지 않는다**.

버전은 `gradle.properties`에서 관리한다. Gateway 4.3.5의 스타터는 Boot 3.5.15에 의존하므로 Gradle 기본 platform 해석을 쓰면 Boot jar가 3.5.15로 올라간다. 그래서 `io.spring.dependency-management`로 Boot BOM(3.5.6)을 기준으로 삼고 Cloud BOM은 Spring Cloud 아티팩트만 추가하도록 했다.

## 모노레포 구조

```text
spring-gateway-streaming-poc/
├── README.md
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties
├── gradlew
├── gradle/wrapper/
├── docker-compose.yml         # 전체 구성 한 번에 실행
├── docker/
│   ├── spring.Dockerfile      # Spring 앱 3개 빌드 (target별 이미지)
│   └── nginx/front-proxy.conf # 앞단 프록시 변형 (시나리오 16)
├── apps/
│   ├── client/                # React, TypeScript, Vite (:5173). 테스트 리포트 + 스트림 체험
│   ├── test-runner/           # k6(xk6-sse) 실행기와 API (:8070). 시나리오·판정 기준은 src/catalog.mjs
│   ├── gateway-mvc/           # io.github.sejoung.gateway.mvc (:8080)
│   ├── gateway-webflux/       # io.github.sejoung.gateway.webflux (:8082)
│   └── ai-backend/            # io.github.sejoung.ai.backend (:8081)
├── scripts/
│   ├── smoke-test.sh          # curl 기반 T01-T03, T11
│   ├── sse-probe.mjs          # TTFE/간격/lag/취소/동시 연결 측정 (Node, 의존성 없음)
│   ├── load-test.js           # k6 동시 연결 부하
│   └── nginx/nginx.conf       # 앞단 프록시 버퍼링/압축 변형 (T12)
└── docs/
    └── results.md
```

각 Spring Boot 메인 클래스는 위 패키지 아래에 두고, Kotlin 파일은 `src/main/kotlin/io/github/sejoung/...`에 배치한다. Gradle `settings.gradle.kts`에서 `:apps:ai-backend`, `:apps:gateway-mvc`, `:apps:gateway-webflux`를 포함한다.

## 요청 흐름

```text
React Client (:5173)
  ├─ POST :8080/api/chat/stream → Gateway MVC ──────┐
  └─ POST :8082/api/chat/stream → Gateway WebFlux ───┤
                                                     ▼
                                           AI Backend (:8081)
                                           Flux → text/event-stream
                                                     │
                                              선택한 Gateway
                                                     ▼
                                               React 화면
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

`count`개의 `token` 이벤트와 마지막 `done` 이벤트를 반환한다. `emittedAt`은 Backend가 이벤트를 만든 시각(epoch ms)이다. 같은 호스트에서 측정하면 수신 시각과 빼서 이벤트별 프록시 지연(lag)을 구할 수 있다. Spring의 SSE 인코더는 `field:value`처럼 콜론 뒤 공백 없이 쓰며, 두 형식 모두 SSE 표준이다. Gateway는 이벤트를 파싱하거나 다시 직렬화하지 않고 HTTP 응답 스트림을 프록시한다.

## 백엔드 구현 기준

- `POST /api/chat/stream`, `produces = MediaType.TEXT_EVENT_STREAM_VALUE`.
- 요청 DTO: `ChatRequest(message: String, count: Int = 10, delayMs: Long = 200)`.
- `Flux.range(0, count).delayElements(Duration.ofMillis(delayMs))`를 기반으로 `ServerSentEvent` 생성.
- `index`, `content`를 포함하고 `concatWith`로 `done` 이벤트 추가.
- `count`/`delayMs` 상한을 설정하여 과도한 요청 방지.
- 요청 ID, 이벤트 생성 시각, `doOnCancel` 로그를 남겨 취소 전파 관측.
- 비교가 가능하도록 실제 LLM 대신 **결정적인 모의 토큰 스트림**부터 구현.
- 상한: `chat.stream.max-count`(10000), `max-delay-ms`(60000), `max-duration`(10m). 넘으면 400.
- 오류 주입(T09): 요청에 `"failMode":"BEFORE_HEADERS"`(헤더 전 500) 또는 `"MID_STREAM"`(토큰 절반 후 스트림 오류).
- 관측: `X-Request-Id` 요청 헤더를 그대로 쓰고(없으면 생성) 응답 헤더로 돌려준다. `GET /internal/streams/{requestId}`가 시작/마지막 이벤트/종료 시각과 결과(`COMPLETED`/`CANCELLED`/`FAILED`)를 돌려준다. 이 경로는 Gateway가 라우팅하지 않으며 측정 스크립트가 Backend에 직접 호출한다.

## Gateway 구현 기준

- 두 Gateway 모두 `/api/chat/**` → `http://localhost:8081`로 라우팅하며 경로는 변경하지 않는다.
- 인증·인가 필터는 추가하지 않고 순수 스트리밍 전달만 검증한다.
- `ModifyResponseBody` 등 전체 응답 본문을 수집·변환하는 필터를 사용하지 않는다.
- `Content-Type: text/event-stream`, `Cache-Control: no-cache` 등 응답 헤더를 확인한다.
- 연결 타임아웃과 스트림 유지 중 응답 타임아웃을 구분하여 설정·검증한다.
- Gateway 자체뿐 아니라 앞단 프록시가 있다면 버퍼링/압축도 점검한다.
- `NettyRoutingFilter`/`NettyWriteResponseFilter`는 **WebFlux Gateway** 내부 구성 요소이며 MVC Gateway와 구현이 다르다.

구현하면서 확인한 동작(자세한 내용은 `docs/results.md`):

| | Gateway MVC | Gateway WebFlux |
| --- | --- | --- |
| 라우트 설정 | `spring.cloud.gateway.server.webmvc.routes` | `spring.cloud.gateway.server.webflux.routes` |
| 연결 타임아웃 | `spring.http.client.connect-timeout: 2s` | `httpclient.connect-timeout: 2000` |
| 응답 타임아웃 | `spring.http.client.read-timeout`. JDK·Jetty client에서는 **응답 전체** 시간 제한이라 스트림 최대 길이보다 길어야 한다. Jetty factory는 미설정 시 10s | `httpclient.response-timeout: 10s`. **응답 헤더 도착까지**만 적용(= 첫 토큰 대기 제한) |
| 클라이언트 abort | 기본 JDK client는 `close()`에서 남은 본문을 drain해서 **Backend 취소가 전파되지 않음**. Jetty client는 전파됨 | 즉시 전파 |
| 동시 스트림 | 스트림당 요청 스레드 1개를 점유한다. 플랫폼 스레드에서는 `server.tomcat.threads.max`가 상한 | 이벤트 루프 |

MVC Gateway에는 위 문제를 해결한 `tuned` 프로필(`application-tuned.yml`: Jetty client, read-timeout 10m, 가상 스레드, Tomcat `accept-count` 1000)과, Jetty 커넥션 풀 크기 설정(`poc.jetty-client.max-connections-per-destination`, Jetty 기본 64)이 있다. 기본 프로필은 비교 기준선으로 Gateway 기본값(JDK client, 플랫폼 스레드)을 유지한다.

## PoC 범위에서 제외하는 항목

- Spring Security, JWT 발급·검증, OAuth2 및 인증·인가 테스트
- 실제 LLM API 연동 및 모델별 토큰 생성 성능 비교
- 운영 환경의 인증 필터 마이그레이션

이 프로젝트는 **SSE 프록시의 전달 지연, 연결 유지, 취소 전파 및 리소스 효율**을 비교한다. 실제 서비스에서 WebFlux로 전환하기로 결정하면 Security 설정(`SecurityFilterChain` → `SecurityWebFilterChain`)과 커스텀 필터 호환성은 별도 작업으로 검증한다.

로컬 React 개발 서버(`http://localhost:5173`)에서 두 Gateway로 직접 요청하므로, 브라우저 테스트를 위한 CORS 설정은 포함한다. CORS는 JWT 인증 테스트와 무관하다. 허용 Origin은 `poc.cors.allowed-origins`이며, MVC는 `CorsFilter`, WebFlux는 `CorsWebFilter`로 `/api/chat/**`에만 적용한다.

## React 클라이언트 요구사항

Gateway 선택(MVC/WebFlux), 메시지, `count`, `delayMs`, 시작/중단 버튼, 실시간 토큰 표시, 이벤트별 수신 시각, 완료/오류 상태를 제공한다.

**브라우저 기본 `EventSource`는 POST JSON 및 임의 요청 헤더를 지원하지 않는다.** 이 PoC는 `fetch()` + `ReadableStream` + `TextDecoder`로 SSE를 수신한다. 네트워크 청크와 SSE 이벤트 경계는 일치하지 않을 수 있으므로 버퍼를 누적하고 빈 줄을 기준으로 `event:`/`data:`를 파싱한다. CRLF도 처리한다. 중단 버튼은 `AbortController.abort()`를 호출한다.

파서는 `apps/client/src/sse.ts`, 테스트는 `sse.test.ts`(모든 청크 분할 지점, CRLF/CR, 여러 줄 data)에 있다. MVC Gateway는 스트림 중간 오류를 정상 종료처럼 전달하므로, 클라이언트는 `done` 이벤트 없이 끝난 스트림을 오류로 표시한다. Gateway URL은 `VITE_MVC_GATEWAY_URL`, `VITE_WEBFLUX_GATEWAY_URL`(`.env.example`)로 바꿀 수 있다.

## 구현 순서

- [x] Gradle 멀티모듈 초기화: Kotlin, Boot 3.5.6, Java 21, 호환 Spring Cloud BOM.
- [x] AI Backend: SSE 토큰/완료 이벤트 및 취소 로깅.
- [x] Backend 직접 호출로 스트리밍 확인.
- [x] MVC Gateway 라우팅 및 SSE 전달 확인.
- [x] WebFlux Gateway 라우팅 및 SSE 전달 확인.
- [x] React 스트림 파서, 실시간 표시, 취소 기능.
- [x] 양쪽 Gateway에 로컬 개발용 CORS 적용(인증 제외).
- [x] 연결 취소, 오류, 타임아웃, 압축/버퍼링 테스트.
- [x] 동시 접속 부하 테스트 및 `docs/results.md` 작성.
- [x] MVC 유지 vs WebFlux 전환 결론 정리.

## 한 번에 실행하기 (docker compose)

```bash
docker compose up --build     # 처음 빌드는 몇 분 걸린다. Docker에 메모리 5GB 이상 권장
open http://localhost:5173    # "테스트 리포트" 탭
docker compose down           # 종료 (실행 기록은 runner-data 볼륨에 남는다. 지우려면 down -v)
```

| 서비스 | 주소 | 설명 |
| --- | --- | --- |
| client | http://localhost:5173 | 테스트 리포트(실행 버튼, 판정표, 건별 상세)와 스트림 체험 화면 |
| test-runner | http://localhost:8070/api | 버튼을 받아 `k6 run`을 실행하고, k6 원시 데이터로 판정한다 |
| ai-backend | http://localhost:8081 | 모의 토큰 스트림 |
| gateway-mvc / gateway-mvc-tuned / gateway-webflux | :8080 / :8090 / :8082 | 비교 대상 |
| pit-* (6개) | 내부 전용 | "설정을 잘못하면 실패하는 항목"을 재현하는 MVC 구성 |
| front-proxy | 내부 전용 | 시나리오 16의 nginx 변형 |

**화면에서 할 수 있는 것**

- **전체 실행**: 판정표 16개 시나리오 × 4개 대상 + 설정 함정 6개, 약 12분. **빠른 실행**: 핵심 7개 시나리오, 약 1.5분.
- 진행 상황과 k6 로그가 실시간으로 나온다. 진행 상황 자체도 SSE로 받는다.
- 판정표 칸을 누르면 판정 기준과 근거, 실패 이유와 해결 방법, 측정값, 요청별 기록, 토큰별 타임라인을 볼 수 있다. 그 건만 다시 실행하거나 k6 원시 데이터(JSON lines)를 받을 수도 있다.
- 실행 기록이 남아서 이전 실행 결과와 비교할 수 있다.

**측정 방식**

- 시나리오 하나 × 대상 하나가 `k6 run` 한 번이다(`apps/test-runner/k6/sse-case.js`). k6에는 SSE 이벤트를 받을 때마다 시각을 잴 수 있도록 [xk6-sse](https://github.com/phymbert/xk6-sse) 확장을 넣어 빌드했다.
- 요청마다 k6 JSON 출력에 원시 데이터 한 줄(`sse_request_ms`)을 남긴다. 메타데이터에 요청 ID와 상세(상태, 결과, 토큰별 수신 시각·지연, 중단 시 Backend 기록)가 들어 있다. 판정은 이 원시 데이터만으로 계산한다(`apps/test-runner/src/judge.mjs`).
- compose의 세 Gateway는 시나리오 15를 위해 응답 압축을 켜 두었다. 압축은 클라이언트가 `Accept-Encoding: gzip`을 보낼 때만 적용되고, 나머지 시나리오는 `identity`로 요청한다.
- Docker Desktop의 VM 안에서 측정하므로 ms 수치는 `docs/results.md`(호스트에서 측정)와 다를 수 있다. 성공/실패 판정은 같은 결과가 나오는 것을 확인했다.

k6 스크립트는 화면 없이 단독으로도 돌릴 수 있다.

```bash
docker compose run --rm --entrypoint k6 test-runner run \
  -e BASE_URL=http://gateway-mvc:8080 -e BACKEND_URL=http://ai-backend:8081 \
  -e COUNT=50 -e ABORT_AFTER=3 -e ITERATIONS=3 k6/sse-case.js
```

## 실행 명령 (개별 실행)

```bash
# 각각 별도 터미널
./gradlew :apps:ai-backend:bootRun
./gradlew :apps:gateway-mvc:bootRun
./gradlew :apps:gateway-webflux:bootRun

cd apps/client && npm install && npm run dev

# MVC Gateway 튜닝 구성 (Jetty client + 가상 스레드)
SPRING_PROFILES_ACTIVE=tuned ./gradlew :apps:gateway-mvc:bootRun --args='--server.port=8090'
```

Gradle은 `gradle/gradle-daemon-jvm.properties`로 Java 21 데몬을 사용하고, 모듈은 Java 21 toolchain으로 컴파일한다.

테스트:

```bash
./gradlew test                    # Backend(StepVerifier/WebTestClient), Gateway 스트리밍·CORS·취소 통합 테스트
cd apps/client && npm test        # SSE 파서
scripts/smoke-test.sh             # 실행 중인 3개 서버 대상 curl 스모크
node scripts/sse-probe.mjs --help # 측정 옵션은 파일 상단 주석 참고
```

백엔드 직접 테스트:

```bash
curl -N -sS -X POST http://localhost:8081/api/chat/stream \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"message":"hello","count":10,"delayMs":200}'
```

MVC Gateway 테스트(포트만 `8082`로 바꾸면 WebFlux Gateway):

```bash
curl -N -sS -X POST http://localhost:8080/api/chat/stream \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"message":"hello","count":10,"delayMs":200}'
```

## 검증 시나리오

| ID | 시나리오 | 기대 결과 |
| --- | --- | --- |
| T01 | Backend 직접 요청 | 토큰 10개 + done 1개, 순서 보존 |
| T02 | MVC Gateway 경유 | 응답 완료 전부터 이벤트가 순차 도착 |
| T03 | WebFlux Gateway 경유 | 응답 완료 전부터 이벤트가 순차 도착 |
| T04 | 최초 이벤트 지연 | Backend 직접 대비 추가 지연 측정 |
| T05 | 30초 이상 스트림 | 예기치 않은 버퍼링/타임아웃 없음 |
| T06 | 클라이언트 Abort | Backend 취소 전파 여부·시간 확인 |
| T09 | Backend 오류(헤더 전/후) | 상태 코드/스트림 오류 처리 구분 |
| T10 | 동시 연결 10/100/500 | 성공률, 지연, CPU, 메모리 기록 |
| T11 | 브라우저 CORS preflight | 로컬 Origin에서 POST 및 Content-Type 허용 |
| T12 | 프록시 압축/버퍼링 | 설정별 이벤트 지연 비교 |

## 결과 기록 (`docs/results.md`)

16개 시나리오를 판정 기준에 따라 성공/실패로 정리했다. 측정 시간과 상세 원인은 [`docs/results.md`](docs/results.md)(브라우저용 [`docs/results.html`](docs/results.html))에 있다.

| 구성 | 성공 | 실패 | 실패한 시나리오 |
| --- | --- | --- | --- |
| MVC 기본 | 11 | 4 (+ 불안정 1) | 사용자 중단 시 Backend 미중단, 스트림 중간 오류 감지, 500개 동시, 500개 동시 × 20초 |
| MVC `tuned` | 15 | 1 | 스트림 중간 오류 감지 (`done` 이벤트로 보완) |
| WebFlux | 15 | 1 | 첫 토큰 12초 지연 시 504 (`response-timeout` 10s 설정값) |

테스트 환경(JDK/JVM 옵션, OS, CPU, 메모리, HTTP 버전, 정확한 Cloud 버전), 반복 횟수, 워밍업, 오류율을 함께 기록한다. 클라이언트 시각만으로 Gateway 내부 지연을 정확히 분리할 수 없으므로 요청 ID와 백엔드 이벤트 생성 로그를 대조한다.

## 의사결정 기준

**결론: 기존 MVC Gateway 유지 + `tuned` 구성(Jetty client, read-timeout ≥ 최대 스트림 길이, Jetty 풀 크기, 가상 스레드, accept-count) 적용.** 근거와 재검토 조건은 `docs/results.md`의 [의사결정](docs/results.md#의사결정) 절에 있다.


**MVC 유지:** 스트리밍이 이벤트 단위로 전달되고 목표 동시 연결 수·지연·취소 처리 기준을 만족하며 운영 복잡도가 낮을 때.

**WebFlux 전환:** 동일 조건에서 연결 수 증가 시 리소스 효율 또는 지연의 유의미한 개선이 측정되고, 추후 예상되는 Security 및 커스텀 필터 마이그레이션 비용까지 고려해도 이점이 충분할 때.

> **핵심 원칙:** SSE는 HTTP 전송 형식이고 WebFlux는 서버 처리 모델이다. SSE를 사용한다는 이유만으로 Gateway를 WebFlux로 바꿀 필요는 없다. 두 구현을 같은 조건으로 비교하여 결정한다.
