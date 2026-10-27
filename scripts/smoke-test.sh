#!/usr/bin/env bash
# Smoke test for T01-T03 and T11 with curl only.
#
#   scripts/smoke-test.sh                       # backend :8081, MVC :8080, WebFlux :8082
#   scripts/smoke-test.sh http://localhost:8090 # any other target(s)
#
# For every target: status, SSE headers, 10 tokens + done in order, and incremental delivery
# (a buffering proxy would deliver nothing before the 2s stream completes). Gateways also get a CORS preflight check.
set -uo pipefail

BACKEND=${BACKEND:-http://localhost:8081}
ORIGIN=${ORIGIN:-http://localhost:5173}
if [ $# -gt 0 ]; then targets=("$@"); else targets=("$BACKEND" http://localhost:8080 http://localhost:8082); fi

failures=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; failures=$((failures + 1)); }

stream() { # url body [extra curl args...]
  local url=$1 body=$2; shift 2
  curl -sS -N -X POST "$url/api/chat/stream" \
    -H 'Content-Type: application/json' -H 'Accept: text/event-stream' -d "$body" "$@"
}

for target in "${targets[@]}"; do
  echo "== $target"
  tmp=$(mktemp -d)

  stream "$target" '{"message":"hello","count":10,"delayMs":200}' -D "$tmp/headers" -o "$tmp/body" || true

  grep -qE '^HTTP/[0-9.]+ 200' "$tmp/headers" && pass "status 200" || fail "status 200 ($(head -1 "$tmp/headers"))"
  grep -qi '^content-type: text/event-stream' "$tmp/headers" && pass "Content-Type text/event-stream" || fail "Content-Type text/event-stream"
  grep -qi '^cache-control: no-cache' "$tmp/headers" && pass "Cache-Control no-cache" || fail "Cache-Control no-cache"

  tokens=$(grep -cE '^event: ?token' "$tmp/body")
  [ "$tokens" -eq 10 ] && pass "10 token events" || fail "10 token events (got $tokens)"
  grep -qE '^event: ?done' "$tmp/body" && pass "done event" || fail "done event"
  order=$(grep -oE '"index":[0-9]+' "$tmp/body" | cut -d: -f2 | tr '\n' ' ')
  [ "$order" = "0 1 2 3 4 5 6 7 8 9 " ] && pass "tokens in order" || fail "tokens in order (got: $order)"

  # 10 x 200ms stream cut off after 1.1s: an unbuffered proxy has delivered ~5 tokens by then.
  early=$(stream "$target" '{"message":"hello","count":10,"delayMs":200}' --max-time 1.1 2>/dev/null | grep -cE '^event: ?token')
  [ "$early" -ge 3 ] && pass "incremental delivery ($early tokens within 1.1s)" || fail "incremental delivery ($early tokens within 1.1s)"

  if [ "$target" != "$BACKEND" ]; then
    preflight=$(curl -sS -i -X OPTIONS "$target/api/chat/stream" -H "Origin: $ORIGIN" \
      -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,x-request-id')
    grep -qi "^access-control-allow-origin: $ORIGIN" <<<"$preflight" && pass "CORS preflight for $ORIGIN" || fail "CORS preflight for $ORIGIN"
  fi

  rm -rf "$tmp"
done

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
