#!/usr/bin/env bash
# Boots a compiled `valet` binary self-contained and checks /api/health and the
# embedded web SPA. Usage: scripts/smoke-binary.sh <path-to-binary>
set -euo pipefail
BIN="$1"
DATA_DIR="$(mktemp -d)"
PORT=8799
"$BIN" --version
VALET_LOCAL_AUTH=1 ANTHROPIC_API_KEY=sk-ant-ci-placeholder \
  "$BIN" serve --port "$PORT" --data-dir "$DATA_DIR" --sandbox local &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:$PORT/api/health" | grep -q '"ok":true'; then
    echo "binary booted self-contained and served /api/health"
    # SPA served from the embedded (extracted) web dir, not a 404.
    curl -fsS "http://localhost:$PORT/" | grep -q '<div id="root"' && echo "web SPA served"
    exit 0
  fi
  sleep 1
done
echo "binary did not become healthy within 60s" >&2
exit 1
