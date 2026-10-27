# 테스트 러너 가이드

`docker compose up` 후 화면에서 버튼으로 실행하는 테스트의 상세 문서다. 빠른 시작과 시나리오 목록은 [README](../README.md#빠르게-시작하기)에 있고, 이 문서는 아래를 다룬다.

1. [구성과 실행 흐름](#1-구성과-실행-흐름)
2. [화면 읽는 법](#2-화면-읽는-법)
3. [시나리오별 실행 조건](#3-시나리오별-실행-조건)
4. [설정 함정 컨테이너](#4-설정-함정-컨테이너)
5. [k6 스크립트 단독 실행과 파라미터](#5-k6-스크립트-단독-실행과-파라미터)
6. [원시 데이터 형식](#6-원시-데이터-형식)
7. [runner API](#7-runner-api)
8. [시나리오 추가·수정](#8-시나리오-추가수정)
9. [개발 모드](#9-개발-모드)
10. [문제 해결](#10-문제-해결)

## 1. 구성과 실행 흐름

```text
브라우저 (:5173)
  └─ client (nginx) ── /runner-api/* ──▶ test-runner (:8070, Node)
                                          │  케이스마다 `k6 run` 실행
                                          ▼
                                         k6 + xk6-sse ──▶ Gateway 또는 Backend
                                          │                 (+ Backend /internal/streams 조회)
                                          └─ --out json ──▶ /data/runs/<실행ID>/<케이스>.<n>.jsonl
```

- **케이스** = 시나리오 하나 × 대상 하나. 케이스 ID는 `s07.mvc`처럼 `<시나리오>.<대상>` 형식이다.
- 케이스 하나는 `k6 run` 한 번이다. 반복(13번)이나 nginx 변형(16번)처럼 **하위 실행**이 있는 케이스는 여러 번 돈다. 하위 실행마다 원시 파일이 하나씩 생긴다(`.0.jsonl`, `.1.jsonl` …).
- 실행 순서:
  1. 4번(30초 스트림)과 6번(첫 토큰 12초)처럼 스트림 1개만 쓰는 긴 케이스를 먼저 **동시에** 돌린다. 이 케이스들은 끊기는지만 보므로 서로 간섭하지 않는다.
  2. 나머지는 하나씩 순서대로 돈다. 동시 연결 측정이 서로 섞이지 않게 하기 위해서다.
  3. 3번(추가 지연)은 Backend 직접 값을 기준으로 비교하므로, 기준 케이스(`s03.direct`)가 항상 먼저 돈다. "이 건만 다시 실행"으로 `s03.mvc`만 골라도 기준 케이스가 함께 실행된다.
- 케이스를 시작할 때 대상의 `/actuator/health`를 확인한다. 응답이 없으면 **최대 90초 기다린다**. 그래도 응답이 없으면 "측정 불가"로 기록한다.
- 동시 연결 케이스(10~13번)는 실행 중에 대상의 actuator를 0.5초마다 조회해서 CPU·메모리·스레드를 기록한다.
- 한 번에 하나의 실행만 돈다. 실행 중에 다른 실행을 요청하면 409를 돌려준다. "중지"를 누르면 진행 중인 k6를 멈추고 남은 케이스는 "건너뜀"으로 남긴다.
- 결과는 `runner-data` 볼륨에 저장된다. `docker compose down`으로는 남고, `down -v`로 지운다.

## 2. 화면 읽는 법

### 판정표 칸

| 표시 | 뜻 |
| --- | --- |
| 성공 | 판정 기준을 만족했다 |
| 실패 | 판정 기준을 만족하지 못했다. "실패한 항목"에 이유와 해결 방법이 나온다 |
| 기준값 | 다른 대상과 비교하기 위한 기준 측정이다(3번의 Backend 직접). 성공/실패가 없다 |
| 측정 불가 | 테스트를 실행하지 못했거나 결과가 비어 있다. 대상 서비스가 죽어 있거나 k6가 비정상 종료한 경우다 |
| 실행 중 / 대기 | 지금 실행 중이거나 순서를 기다리는 중이다 |
| 건너뜀 | 중지했거나 실행기가 재시작되어 실행하지 않았다 |
| — | 해당 없음. 예: Backend 직접에는 CORS·Gateway gzip이 없다 |

"설정을 잘못하면 실패하는 항목" 표는 반대로 읽는다. **실패가 나와야 예상대로**다. 성공이 나오면 "예상과 다름"으로 표시된다.

### 상세 패널 (칸을 누르면 열림)

- **판정 기준 / 판정 근거**: 기준 문장과, 원시 데이터로 계산한 결과 한 줄.
- **왜 / 해결**: 실패했을 때만 나온다. 시나리오와 대상 종류별로 정리한 설명이다(`catalog.mjs`의 `explain`).
- **측정값**: 워밍업을 뺀 요청만으로 계산한 값이다.

| 항목 | 뜻 |
| --- | --- |
| 첫 토큰 | 요청을 보낸 뒤 첫 토큰을 받기까지 걸린 시간 (TTFE) |
| 응답 완료 | 요청을 보낸 뒤 done까지 받기까지 걸린 시간. 정상 완료된 요청만 |
| 토큰 간격 | 같은 요청 안에서 이전 토큰과 다음 토큰의 수신 시각 차이 |
| 지연(lag) | 클라이언트 수신 시각 − Backend가 토큰에 기록한 생성 시각(`emittedAt`). 중간 버퍼링이 있으면 커진다. 같은 머신(같은 Docker VM)이라 시계가 같다 |
| 중단 → Backend 종료 | 클라이언트가 끊은 시각부터 Backend 스트림이 끝난 시각까지. 취소됐는지 끝까지 생성했는지는 요청별 기록의 Backend 열로 구분한다 |
| Gateway 리소스 | 실행 중 actuator 값. CPU는 JVM이 보는 전체 코어 대비 비율, 메모리는 힙+비힙 사용량 |

- **요청별 기록**: 요청 하나가 한 행이다. "문제 있는 요청만"을 켜면 정상 완료나 정상 중단이 아닌 요청만 보인다. Backend가 끝까지 생성한 요청도 문제 있는 요청으로 친다. 행을 누르면 그 요청의 **타임라인**(토큰별 수신 시각·간격·지연, 응답 헤더, 중단과 Backend 결과)이 나온다.
- **k6 원시 데이터 받기**: 그 케이스의 k6 JSON 출력 전체(JSON lines). 형식은 [6장](#6-원시-데이터-형식).
- **k6 로그 보기**: 실행한 `k6 run` 명령과 요청별 한 줄 요약.
- **이 건만 다시 실행**: 그 케이스만 새 실행으로 돌린다(개별 실행).

### 링크 공유

주소창의 `?run=<실행ID>&case=<케이스ID>`로 특정 실행과 열린 상세 패널을 그대로 공유할 수 있다. 예: `http://localhost:5173/?run=20261027-092557-twb&case=s07.mvc`

## 3. 시나리오별 실행 조건

판정 기준 문장은 README의 표와 같다. 여기서는 k6에 넘기는 조건을 적는다. 전체 정의는 `apps/test-runner/src/catalog.mjs`에 있다.

| # | 시나리오 | 대상 | k6 조건 | 빠른 실행 |
| --- | --- | --- | --- | --- |
| 1 | 정상 응답 | 4개 | 토큰 10개 × 200ms, 3회 | 2회 |
| 2 | 버퍼링 없음 | 4개 | 토큰 10개 × 200ms, 워밍업 1회 + 3회 | 워밍업 없이 2회 |
| 3 | 추가 지연 | 4개 (Backend 직접은 기준값) | 토큰 10개 × 0ms, 워밍업 5회 + 30회 | — |
| 4 | 30초 이상 스트림 | 4개 | 토큰 160개 × 200ms, 1회 | — |
| 5 | 연결 타임아웃 | Gateway 3개 | `/unreachable/api/chat/stream`(응답 없는 주소로 가는 라우트), 3회 | — |
| 6 | 첫 토큰 지연 | Gateway 3개 | 토큰 2개 × 12초, 1회 | — |
| 7 | 사용자 중단 | 4개 | 토큰 50개 × 200ms, 3개 받고 끊기, 5회. Backend 기록을 최대 15초 기다림 | 2회 |
| 8 | 헤더 전 오류 | 4개 | `failMode=BEFORE_HEADERS`, 1회 | 1회 |
| 9 | 스트림 중간 오류 | 4개 | `failMode=MID_STREAM`(토큰 5개 후 오류), 1회 | 1회 |
| 10 | 100개 동시 | 4개 | 100 VU × (워밍업 1회 + 3회), 토큰 10개 × 200ms | 워밍업 1회 + 1회 |
| 11 | 500개 동시 | 4개 | 500 VU × (워밍업 1회 + 3회), 토큰 10개 × 200ms | — |
| 12 | 500개 동시 × 20초 | 4개 | 500 VU. 워밍업(토큰 5개 × 100ms) 후 모든 VU가 같은 시각에 출발, 토큰 100개 × 200ms | — |
| 13 | 500 VU 반복 | 4개 | 500 VU × 2회를 하위 실행 3번 | — |
| 14 | CORS | Gateway 3개 | 허용 Origin과 다른 Origin으로 preflight 각 1번 | 1번 |
| 15 | Gateway gzip | Gateway 3개 | gzip 응답인지 먼저 확인한 뒤 토큰 10개 × 200ms, 3회 | — |
| 16 | 앞단 nginx | Gateway 3개 | nginx 기본·버퍼링 강제·gzip 세 하위 실행, 각 2회 | — |

- 대상 4개는 Backend 직접, MVC 기본, MVC tuned, WebFlux다.
- 워밍업 요청은 원시 데이터에는 남지만 판정에서는 뺀다.
- 12번은 처음에 워밍업이 없었다. 막 재시작한 JVM에서는 JIT 워밍업 때문에 WebFlux도 실패해서 워밍업을 넣었다. 동시 출발 시점(`BARRIER_MS`)을 맞추는 이유는 "500개가 한꺼번에 연결"하는 상황을 실제로 만들기 위해서다.
- 15번과 nginx gzip 변형만 `Accept-Encoding: gzip`을 보낸다. 나머지는 `identity`다. compose의 Gateway에는 응답 압축이 켜져 있지만, 요청이 gzip을 원할 때만 압축한다.

## 4. 설정 함정 컨테이너

`docker-compose.yml`의 `pit-*` 서비스다. 모두 같은 MVC 이미지에 설정만 바꿔 띄우고, 외부 포트는 열지 않는다. 메모리를 아끼려고 힙을 384MB로 줄였다.

| 서비스 | 바꾼 설정 | 확인 시나리오 | 실패해야 하는 이유 |
| --- | --- | --- | --- |
| `pit-jdk-rt10s` | `spring.http.client.read-timeout=10s` (JDK 클라이언트) | 4 | JDK 클라이언트의 read-timeout은 응답 전체 시간 제한이다 |
| `pit-jetty-nort` | `spring.http.client.factory=jetty`, read-timeout 미설정 | 4 | Spring의 Jetty 팩토리는 기본 10초를 전체 시간 제한으로 쓴다 |
| `pit-jetty-pool64` | `tuned` + `poc.jetty-client.max-connections-per-destination=64` | 10 | 스트림마다 Backend 연결을 하나씩 점유하는데 풀이 64개다 |
| `pit-jetty-platform` | `tuned` + `spring.threads.virtual.enabled=false` | 11 | Tomcat 플랫폼 스레드 200개 상한이 그대로다 |
| `pit-vt-jdk` | `spring.threads.virtual.enabled=true` (JDK 클라이언트) | 7 | 스레드 문제만 풀리고 JDK 클라이언트의 drain은 남는다 |
| `pit-simple` | `spring.http.client.factory=simple` | 7 | simple 클라이언트도 응답을 닫을 때 drain한다 |

Tomcat `accept-count` 기본값(100) 구성은 처음에 함정으로 넣었다가 뺐다. 재시작 직후에는 매번 실패했지만 JVM이 데워진 뒤에는 통과하기도 해서 재현이 일정하지 않았다. 자세한 내용은 [results.md의 docker compose 재측정](results.md#docker-compose-재측정)에 있다.

## 5. k6 스크립트 단독 실행과 파라미터

화면 없이도 같은 스크립트를 돌릴 수 있다. compose가 떠 있으면 같은 네트워크 안에서 서비스 이름으로 접근한다.

```bash
# MVC 기본에서 사용자 중단 3회 (Backend가 끝까지 생성하는지 확인)
docker compose run --rm --no-deps --entrypoint k6 test-runner run \
  -e BASE_URL=http://gateway-mvc:8080 -e BACKEND_URL=http://ai-backend:8081 \
  -e COUNT=50 -e ABORT_AFTER=3 -e ITERATIONS=3 k6/sse-case.js

# 원시 데이터를 파일로 남기려면 --out json=/data/tmp.jsonl (runner-data 볼륨에 저장됨)
```

| 환경변수 | 기본값 | 설명 |
| --- | --- | --- |
| `KIND` | `stream` | `stream`은 SSE 요청, `cors`는 preflight 검사 |
| `BASE_URL` | `http://localhost:8080` | 대상 주소 |
| `PATH_PREFIX` | (없음) | 경로 앞에 붙일 값. 5번은 `/unreachable` |
| `BACKEND_URL` | `http://localhost:8081` | 중단 후 `/internal/streams/{id}`를 조회할 Backend 주소 |
| `COUNT` / `DELAY_MS` | `10` / `200` | 토큰 수와 간격 |
| `FAIL_MODE` | `NONE` | `BEFORE_HEADERS`, `MID_STREAM` |
| `VUS` / `ITERATIONS` | `1` / `1` | 동시 사용자 수, 사용자당 측정 횟수 |
| `WARMUP` | `0` | 사용자당 워밍업 횟수. 원시 데이터에 `warmup=true`로 남고 판정에서 빠진다 |
| `WARMUP_COUNT` / `WARMUP_DELAY_MS` | `COUNT` / `DELAY_MS` | 워밍업 요청만 다른 스트림 길이로 보내고 싶을 때 |
| `BARRIER_MS` | `0` | 0보다 크면 워밍업 뒤 모든 VU가 시작 후 이 시간이 지난 시각에 동시에 출발한다 |
| `ABORT_AFTER` | `0` | 0보다 크면 토큰을 이만큼 받은 뒤 연결을 끊고 Backend 기록을 조회한다 |
| `CANCEL_WAIT_MS` | `15000` | 중단 후 Backend가 끝나기를 기다리는 최대 시간 |
| `TIMEOUT` | 스트림 길이 × 3 + 30초 | 요청 하나의 최대 시간. 스트림이 멈춰도 실행 전체가 멈추지 않게 한다 |
| `ACCEPT_ENCODING` | `identity` | `auto`면 헤더를 보내지 않아 Go HTTP 클라이언트가 gzip을 협상하고 압축을 풀어 준다 |
| `CHECK_GZIP` | `false` | `true`면 측정 전에 `Accept-Encoding: gzip`으로 한 번 요청해 압축 여부를 기록한다 |
| `ORIGIN` | `http://localhost:5173` | CORS 검사에서 허용되어야 하는 Origin |
| `CASE` / `RUN` | `adhoc` / `cli` | 요청 ID(`<RUN>-<CASE>-<VU>-<회차>`)를 만드는 값 |

k6 바이너리는 `apps/test-runner/Dockerfile`에서 `xk6 build v2.3.0 --with github.com/phymbert/xk6-sse@v0.2.0`으로 빌드한다. xk6-sse v0.2.0은 오류 이벤트 후 스스로 연결을 닫지 않는다. 그래서 스크립트의 `error` 핸들러에서 `client.close()`를 호출한다.

## 6. 원시 데이터 형식

`--out json` 출력은 한 줄에 JSON 하나다. 판정에 쓰는 줄은 다음 두 종류다.

**`sse_request_ms`**: 요청 하나당 한 줄. 값은 요청 전체 시간(ms)이다.

```json
{"metric":"sse_request_ms","type":"Point","data":{"time":"2026-10-27T08:15:45.028Z","value":2087,
 "tags":{"case":"s01.mvc.0","outcome":"complete","warmup":"false"},
 "metadata":{"rid":"twb-s01.mvc.0-1-0","detail":"{...}"}}}
```

`metadata.detail`은 JSON 문자열이고, 필드는 다음과 같다.

| 필드 | 설명 |
| --- | --- |
| `status` | HTTP 상태. 연결 자체가 실패하면 0 |
| `outcome` | `complete`(done까지 정상), `aborted`(스크립트가 끊음), `stream_error`(연결 오류), `no_done`(오류 없이 끝났지만 done 없음), `token_mismatch`, `http_error`, `connect_error` |
| `error` | 연결 오류 메시지 (예: `unexpected EOF`) |
| `headersMs`, `ttfeMs`, `totalMs` | 응답 헤더, 첫 이벤트, 끝까지 걸린 시간 |
| `tokens`, `inOrder`, `sawDone` | 받은 토큰 수, 순서 보존 여부, done 수신 여부 |
| `contentType`, `cacheControl` | 응답 헤더 |
| `events` | `[토큰 index 또는 "done", 수신 시각(ms, 요청 시작 기준), lag(ms)]` 배열 |
| `abortedAtMs` | 끊은 시각 (요청 시작 기준) |
| `backendOutcome` | 끊은 뒤 Backend 기록: `CANCELLED`, `COMPLETED`, `FAILED`, `STILL_RUNNING`(기다리는 동안 안 끝남), `UNKNOWN` |
| `cancelPropagationMs` | Backend 종료 시각 − 끊은 시각 |
| `eventsAfterAbort` | 끊은 뒤 Backend가 더 만든 토큰 수 |

**`case_check`**: 요청이 아닌 검사 결과. `tags.check`가 `gzip`이면 `detail.contentEncoding`, `cors`면 허용/거부 Origin별 응답이 들어 있다.

그 밖의 줄(`sse_ttfe_ms`, `sse_event_lag_ms`, `sse_complete`, k6 기본 지표)은 k6 요약과 외부 분석용이다. 판정에는 쓰지 않는다.

runner는 원시 파일을 읽어 `<케이스>.requests.json`(요청 기록 배열)을 만들고, 화면의 요청별 기록은 이 파일을 쓴다.

## 7. runner API

client 컨테이너에서는 `/runner-api/*`, 직접 접근할 때는 `http://localhost:8070/api/*`다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/catalog` | 대상, 시나리오, 설정 함정, 빠른 실행 목록 |
| GET | `/api/health` | 대상별 기동 여부와 실행 중인 실행 ID |
| GET | `/api/runs` | 실행 기록 목록 (최신순, 대상별 성공/실패 개수 포함) |
| POST | `/api/runs` | 실행 시작. 본문 `{"mode":"full"}`, `{"mode":"quick"}`, `{"mode":"custom","cases":["s07.mvc"]}`. 202 + `{"id"}`, 실행 중이면 409 |
| GET | `/api/runs/{id}` | 실행 전체 (케이스별 판정, 근거, 측정값, 최근 로그) |
| POST | `/api/runs/{id}/stop` | 실행 중지 |
| GET | `/api/runs/{id}/events` | 진행 상황 SSE. 이벤트 종류는 `snapshot`, `case`, `log`, `run`, `end` |
| GET | `/api/runs/{id}/cases/{caseId}/requests` | 요청 기록 목록 (이벤트 배열 제외) |
| GET | `/api/runs/{id}/cases/{caseId}/requests/{rid}` | 요청 하나의 전체 기록 |
| GET | `/api/runs/{id}/cases/{caseId}/log` | 케이스의 k6 로그 (텍스트) |
| GET | `/api/runs/{id}/cases/{caseId}/raw` | 케이스의 k6 원시 데이터 (하위 실행을 이어 붙인 JSON lines) |

```bash
curl -X POST localhost:8070/api/runs -H 'Content-Type: application/json' -d '{"mode":"quick"}'
curl -N localhost:8070/api/runs/<id>/events      # 진행 상황을 터미널에서 보기
```

runner 환경변수: `PORT`(8070), `DATA_DIR`(`/data/runs`), `K6_BIN`(`k6`), `K6_SCRIPT`, 대상 주소 `TARGET_URL_<대상 ID>`. 예: `TARGET_URL_MVC=http://localhost:8080`, `TARGET_URL_PIT_VT_JDK=…`, `TARGET_URL_BACKEND`, `TARGET_URL_FRONT_PROXY`.

## 8. 시나리오 추가·수정

1. `apps/test-runner/src/catalog.mjs`의 `SCENARIOS`에 항목을 추가한다.

   | 필드 | 설명 |
   | --- | --- |
   | `id`, `no`, `tid`, `title` | 식별자, 표의 번호, 관련 검증 ID, 제목 |
   | `criterion` | 화면에 나오는 판정 기준 문장 |
   | `judge` | `judge.mjs`의 판정 함수 이름 |
   | `targets` | 실행할 대상 ID 목록 |
   | `params` | k6 환경변수 ([5장](#5-k6-스크립트-단독-실행과-파라미터)) |
   | `quick` | 빠른 실행일 때 덮어쓸 `params`. 빠른 실행에 넣으려면 `QUICK_SCENARIOS`에도 추가한다 |
   | `explain` | 실패 설명 `{ why, fix }`. 키는 대상 ID 또는 대상 종류(`mvc`, `webflux`, `backend`)이고, 대상 ID가 우선한다 |
   | `baseline` | 비교 기준 대상 (예: `'direct'`) |
   | `group: 'long'` | 다른 긴 케이스와 동시에 돌려도 되는 단일 스트림 케이스 |
   | `resources: true` | 실행 중 actuator 리소스 기록 |
   | `repeat` / `subruns` | 같은 조건 반복 횟수 / 대상별 하위 실행 목록 함수 |
   | `kind: 'cors'` | SSE 대신 preflight 검사 |

2. 판정 방식이 새로우면 `apps/test-runner/src/judge.mjs`의 `judges`에 함수를 추가한다. 함수는 워밍업을 뺀 요청 기록 배열을 받아 `{ verdict: 'pass' | 'fail', reason }`을 돌려준다.
3. `apps/test-runner/test/judge.test.mjs`에 판정 테스트를 추가하고 `cd apps/test-runner && npm test`로 확인한다.
4. `docker compose up -d --build test-runner`로 반영한다. 화면의 판정표는 카탈로그에서 그려지므로 클라이언트를 고칠 필요는 없다.

새 대상(Gateway 구성)은 `TARGETS`에 추가하고 `docker-compose.yml`에 서비스를 추가한다. 설정 함정이면 `pitfall: true`로 두고 `PITFALLS`에 추가한다.

## 9. 개발 모드

runner와 Gateway는 compose로 띄우고, 클라이언트만 Vite 개발 서버로 돌리는 방식이 가장 간단하다. Vite가 `/runner-api`를 `localhost:8070`으로 프록시한다.

```bash
docker compose up -d                 # 5173은 client 컨테이너가 쓰고 있으므로
docker compose stop client           # 개발 서버를 같은 포트로 띄우려면 멈춘다
cd apps/client && npm run dev        # http://localhost:5173
```

- runner 코드를 고친 뒤: `docker compose up -d --build test-runner`
- Gateway 설정을 고친 뒤: `docker compose up -d --build gateway-mvc gateway-mvc-tuned`. pit-* 컨테이너도 같은 이미지를 쓴다.
- 테스트: `./gradlew test`, `cd apps/client && npm test`, `cd apps/test-runner && npm test`

runner를 compose 밖(호스트)에서 돌리려면 xk6-sse가 들어간 k6가 호스트에 있어야 한다(`xk6 build v2.3.0 --with github.com/phymbert/xk6-sse@v0.2.0`). 대상 주소는 `TARGET_URL_*`로 지정한다. 이 방식은 이 PoC에서 확인하지 않았다.

## 10. 문제 해결

| 증상 | 원인과 조치 |
| --- | --- |
| 화면에 "테스트 실행기에 연결할 수 없습니다" | test-runner가 떠 있지 않다. `docker compose ps`, `docker compose logs test-runner` |
| 서비스 상태에 빨간 점, 케이스가 "측정 불가" | 해당 컨테이너가 아직 뜨는 중이거나 죽었다. 막 띄웠다면 30초쯤 기다린다. runner도 케이스마다 최대 90초 기다린다. `docker compose logs <서비스>`로 확인 |
| 16번만 전부 실패하고 HTTP 502 | nginx가 Gateway에 연결하지 못한다. `front-proxy.conf`를 고쳤다면 `docker compose restart front-proxy`. 설정은 Docker DNS를 매번 다시 조회하므로 Gateway 재시작만으로는 생기지 않아야 한다 |
| 컨테이너가 OOM으로 재시작됨 | Docker Desktop 메모리를 5GB 이상으로 늘린다. 전체 구성은 약 4.2GB를 쓴다 |
| `docker compose up`에서 포트 충돌 | 5173, 8070, 8080, 8081, 8082, 8090을 쓴다. 로컬에서 따로 띄운 서버를 내린다 |
| 실행이 오래 끝나지 않음 | 진행 로그로 어떤 케이스인지 본다. 멈춘 스트림은 요청 타임아웃(스트림 길이 × 3 + 30초)이 지나면 실패로 기록된다. 급하면 "중지" |
| 동시 연결 케이스에서 일부만 1초 남짓 늦음 | Tomcat 연결 대기열 넘침일 수 있다. `docker compose exec <서비스> cat /proc/net/netstat`의 `TcpExt` 줄에서 `ListenOverflows`가 늘었는지 본다 |
| 수치가 `docs/results.md`와 다름 | 문서의 수치는 호스트에서 잰 값이고, 화면의 수치는 Docker VM 안에서 잰 값이다. 비교는 성공/실패 판정으로 한다 |
| 실행 기록 지우기 | `docker compose down -v` (볼륨 삭제) 후 다시 `up` |
