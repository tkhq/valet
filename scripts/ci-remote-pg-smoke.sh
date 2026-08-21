#!/usr/bin/env bash
# Smoke-test a `valet serve` launcher against a REMOTE Postgres (the pg.Pool
# path, not embedded PGlite). Proves: healthy boot on a remote DB, app+engine
# migrations actually applied to it, a REST create/list round-trip, and — the
# durability story — a `kill -9` mid-life + reboot with data still in the
# remote DB (nothing was in a local file).
#
# Usage (run from repo root, DATABASE_URL + psql available):
#   DATABASE_URL=postgres://user:pw@host:5432/db scripts/ci-remote-pg-smoke.sh <launcher...>
#   e.g.  scripts/ci-remote-pg-smoke.sh node packages/api/dist/valet-api.mjs
#         scripts/ci-remote-pg-smoke.sh packages/api/dist/valet-linux-x64
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
if [ "$#" -eq 0 ]; then echo "usage: $0 <serve-launcher...>" >&2; exit 2; fi
LAUNCHER=("$@")

PORT="${SMOKE_PORT:-8790}"
BASE="http://localhost:${PORT}"
PID=""

q() { psql "$DATABASE_URL" -tAc "$1" | tr -d '[:space:]'; }

boot() {
  # fix: provide encryption key for CI smoke (api refuses to boot without one)
  env VALET_LOCAL_AUTH=1 ANTHROPIC_API_KEY=sk-ant-ci-placeholder VALET_ENCRYPTION_KEY=ci-smoke-encryption-key-not-secret \
    "${LAUNCHER[@]}" serve --port "$PORT" --data-dir "$(mktemp -d)" \
    --sandbox local --database-url "$DATABASE_URL" &
  PID=$!
}

stop() { [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null || true; }
trap stop EXIT

wait_health() {
  for _ in $(seq 1 60); do
    if curl -fsS "${BASE}/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  echo "FAIL: not healthy within 60s" >&2
  return 1
}

echo "== boot 1 against remote pg =="
boot
wait_health
echo "  healthy"

echo "== migrations applied to the remote DB =="
[ "$(q "select to_regclass('public.agent_sessions')")" = "agent_sessions" ] \
  || { echo "FAIL: app migrations not applied (agent_sessions missing)" >&2; exit 1; }
[ "$(q "select to_regclass('public.engine_entries')")" = "engine_entries" ] \
  || { echo "FAIL: engine migrations not applied (engine_entries missing)" >&2; exit 1; }
echo "  app + engine schema present"

echo "== REST create + list round-trip =="
WS="$(mktemp -d)"
CREATE="$(curl -fsS -X POST "${BASE}/api/sessions" -H 'content-type: application/json' \
  -d "{\"workspace\":\"${WS}\",\"title\":\"pg-smoke\"}")"
SID="$(printf '%s' "$CREATE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).id||"")})')"
[ -n "$SID" ] || { echo "FAIL: no session id from create (got: $CREATE)" >&2; exit 1; }
curl -fsS "${BASE}/api/sessions" | grep -q "$SID" || { echo "FAIL: session not in list" >&2; exit 1; }
[ "$(q "select count(*) from agent_sessions where id='${SID}'")" = "1" ] \
  || { echo "FAIL: session row not persisted in remote DB" >&2; exit 1; }
echo "  created + persisted session ${SID}"

echo "== kill -9 + reboot: data survives in remote DB =="
stop; PID=""; sleep 2
boot
wait_health
curl -fsS "${BASE}/api/sessions" | grep -q "$SID" \
  || { echo "FAIL: session lost after reboot — remote-pg durability broken" >&2; exit 1; }
echo "  session ${SID} survived kill -9 + reboot"

stop
echo "REMOTE-PG SMOKE PASS"
