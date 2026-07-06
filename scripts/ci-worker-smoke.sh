#!/usr/bin/env bash
# CI smoke test: boot the REAL worker under `wrangler dev` and run the direct
# API smoke suite (tests/smoke/api.test.ts) against it. Unlike the unit tests
# (vitest + better-sqlite3 shim), this exercises real D1 semantics, migrations,
# Durable Objects, middleware and routing end-to-end — no cloud, no secrets.
#
# Self-contained after `pnpm install` on a clean checkout (modeled on
# scripts/otel-e2e.sh). Two things wrangler does NOT do for a pnpm monorepo,
# handled below:
#   (a) Build workspace deps: the worker bundle imports @valet/shared +
#       @valet/sdk from their compiled dist/ (plugin packages are bundled from
#       source by esbuild, so they need no pre-build).
#   (b) Substitute config placeholders: wrangler.toml uses ${CF_WORKER_NAME}/
#       ${D1_DATABASE_NAME}/... and wrangler has no native ${VAR}
#       interpolation, so we sed them into a throwaway wrangler.smoke.toml.
#
# wrangler 4 is pulled via npx (repo pins 3.x, which lacks local support for
# workflows waitForEvent; the team runs 4.x locally — see workers-sdk#8775).
# All state lives in a throwaway --persist-to dir so back-to-back runs are
# hermetic and the developer's .wrangler/state is never touched.
#
# Env overrides: PORT (default 8794), API_TOKEN (default matches the seed).
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

WORKER=packages/worker
PORT="${PORT:-8794}"
API_TOKEN="${API_TOKEN:-test-api-token-12345}"   # matches scripts/seed-test-data.sql
WRANGLER_VERSION=4.107.0
SMOKE_CONFIG=wrangler.smoke.toml                 # relative to $WORKER
STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/valet-worker-smoke.XXXXXX")"
WLOG="$STATE_DIR/wrangler-dev.log"
export WRANGLER_SEND_METRICS=false

wrangler() { npx --yes "wrangler@$WRANGLER_VERSION" "$@"; }

# Kill a PID and all its descendants (npx -> wrangler -> workerd). PID-scoped
# on purpose: other wrangler instances may run concurrently, so never pkill
# by name.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  if [ -n "${WPID:-}" ]; then
    kill_tree "$WPID"
    wait "$WPID" 2>/dev/null || true
  fi
  # wrangler can leave a detached workerd bound to our port. Anything still
  # listening there was started by us (we verified the port was free below),
  # so a port-scoped kill only ever hits our own leftovers.
  local leftover
  leftover=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [ -n "$leftover" ]; then kill -9 $leftover 2>/dev/null || true; fi
  rm -f "$WORKER/$SMOKE_CONFIG"
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

# Refuse to steal the port from someone else — we only ever kill processes we
# started, so the port must be free before we begin.
if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "ERROR: port $PORT is already in use; set PORT=<free port> and retry" >&2
  exit 1
fi

echo "── generating plugin registries ──"
(cd "$WORKER" && bun scripts/generate-plugin-registry.ts)

echo "── building worker deps (@valet/shared, @valet/sdk) ──"
# Clear stale tsc incremental state first: a leftover *.tsbuildinfo whose
# dist/ was removed makes incremental tsc emit NOTHING (see otel-e2e.sh).
rm -f packages/shared/tsconfig.tsbuildinfo packages/sdk/tsconfig.tsbuildinfo
pnpm --filter @valet/shared run build
pnpm --filter @valet/sdk run build

echo "── writing throwaway $SMOKE_CONFIG ──"
sed -e 's/\${CF_WORKER_NAME}/valet-dev/g' -e 's/\${R2_BUCKET_NAME}/valet-storage/g' \
    -e 's/\${D1_DATABASE_NAME}/valet-db/g' -e 's/\${D1_DATABASE_ID}/00000000-0000-0000-0000-000000000000/g' \
    -e 's/\${[A-Z_]*}//g' "$WORKER/wrangler.toml" > "$WORKER/$SMOKE_CONFIG"

echo "── applying D1 migrations (local) ──"
(cd "$WORKER" && wrangler d1 migrations apply valet-db --local \
  --config "$SMOKE_CONFIG" --persist-to "$STATE_DIR")

echo "── seeding test data (API token '$API_TOKEN') ──"
(cd "$WORKER" && wrangler d1 execute valet-db --local \
  --file=scripts/seed-test-data.sql \
  --config "$SMOKE_CONFIG" --persist-to "$STATE_DIR")

echo "── booting worker on :$PORT ──"
(cd "$WORKER" && wrangler dev --config "$SMOKE_CONFIG" \
  --port "$PORT" --ip 127.0.0.1 --persist-to "$STATE_DIR") > "$WLOG" 2>&1 &
WPID=$!

echo "── waiting for /health (60s timeout) ──"
ready=0
for _ in $(seq 1 60); do
  if ! kill -0 "$WPID" 2>/dev/null; then break; fi   # wrangler died — fail fast
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/health" || true)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "ERROR: worker did not become healthy on :$PORT — last 50 lines of wrangler dev log:" >&2
  tail -n 50 "$WLOG" >&2
  exit 1
fi
echo "  ✓ worker healthy"

echo "── running API smoke suite (tests/smoke/api.test.ts) ──"
# Scoped to api.test.ts only: the agent-*.test.ts files dispatch prompts to a
# live agent and need a real Modal backend, which CI does not have.
if ! WORKER_URL="http://127.0.0.1:$PORT" API_TOKEN="$API_TOKEN" \
    pnpm vitest run --config tests/smoke/vitest.config.ts api.test.ts; then
  echo "smoke suite FAILED — last 50 lines of wrangler dev log:" >&2
  tail -n 50 "$WLOG" >&2
  exit 1
fi

echo ""
echo "worker-smoke: PASS"
