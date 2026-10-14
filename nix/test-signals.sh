#!/usr/bin/env bash
# Checks that signals sent to the packaged `valet` wrapper reach Valet.
# The wrapper is a buildFHSEnv (bubblewrap) launcher. If it did not forward
# SIGTERM, `valet serve` would die without running its graceful shutdown.
#
# Usage: nix/test-signals.sh <path-to-packaged-valet>   (for example ./result/bin/valet)
set -euo pipefail
valet="$(readlink -f "${1:?usage: nix/test-signals.sh <path-to-valet>}")"
work="$(mktemp -d)"
pid=""
trap '[[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true; rm -rf "$work"' EXIT
port=8798
export VALET_LOCAL_AUTH=1 ANTHROPIC_API_KEY=sk-ant-ci-placeholder

wait_healthy() {
  for _ in $(seq 1 90); do
    curl -fsS "http://localhost:$port/api/health" 2>/dev/null | grep -q '"ok":true' && return 0
    kill -0 "$pid" 2>/dev/null || { echo "valet exited before it was healthy" >&2; cat "$work/log"; return 1; }
    sleep 1
  done
  echo "valet did not become healthy in 90s" >&2; cat "$work/log"; return 1
}


echo "== SIGTERM to the wrapper must run the graceful shutdown"
"$valet" serve --port "$port" --data-dir "$work/data" --sandbox local >"$work/log" 2>&1 &
pid=$!
wait_healthy
echo "process tree under the wrapper (pid $pid):"
ps -eo pid,ppid,stat,args --forest | awk -v p="$pid" '$1==p || $2==p || f[$2] {f[$1]=1; print}' | cut -c1-200
for p in $(pgrep -P "$pid") "$pid"; do echo "pid $p: $(grep -E '^(Name|SigCgt)' /proc/$p/status | tr '\n' ' ')"; done
kill -TERM "$pid"
status=0
for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
if kill -0 "$pid" 2>/dev/null; then echo "valet still running 30s after SIGTERM" >&2; exit 1; fi
wait "$pid" || status=$?
pid=""
cat "$work/log"
grep -q "Received SIGTERM, shutting down" "$work/log" \
  || { echo "FAIL: SIGTERM did not reach Valet's shutdown handler" >&2; exit 1; }
[[ "$status" -eq 0 ]] || { echo "FAIL: exit status $status after SIGTERM, expected 0" >&2; exit 1; }
if curl -fsS "http://localhost:$port/api/health" >/dev/null 2>&1; then
  echo "FAIL: server still answers after shutdown (orphaned child)" >&2; exit 1
fi
echo "ok: SIGTERM reached Valet, graceful exit 0, no orphan"

echo "== SIGTERM to the whole process tree at once (systemd KillMode=control-group)"
"$valet" serve --port "$port" --data-dir "$work/data2" --sandbox local >"$work/log2" 2>&1 &
pid=$!
wait_healthy
tree="$pid"
for _ in 1 2 3; do  # wrapper -> bwrap -> valet
  tree="$tree $(for p in $tree; do pgrep -P "$p" || true; done | tr '\n' ' ')"
done
# shellcheck disable=SC2086
kill -TERM $tree
status=0
for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
if kill -0 "$pid" 2>/dev/null; then echo "valet still running 30s after SIGTERM" >&2; exit 1; fi
wait "$pid" || status=$?
pid=""
cat "$work/log2"
grep -q "Received SIGTERM, shutting down" "$work/log2" \
  || { echo "FAIL: group SIGTERM did not reach Valet's shutdown handler" >&2; exit 1; }
[[ "$status" -eq 0 ]] || { echo "FAIL: exit status $status after group SIGTERM, expected 0" >&2; exit 1; }
echo "ok: group SIGTERM ran the graceful shutdown, exit 0"
