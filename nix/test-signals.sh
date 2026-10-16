#!/usr/bin/env bash
# Checks that signals sent to the packaged `valet` wrapper reach Valet.
# The wrapper is a buildFHSEnv (bubblewrap) launcher. If it did not forward
# SIGTERM, `valet serve` would die without running its graceful shutdown.
#
# Usage: nix/test-signals.sh <packaged-valet> <packaged-probe>
#   for example: nix/test-signals.sh result/bin/valet result-probe/bin/valet
# The probe is the same wrapper around a small program (packages.valet-signal-probe),
# so the INT, QUIT, stdin, exit status and parent-death checks do not depend on
# how Valet itself handles signals.
set -euo pipefail
valet="$(readlink -f "${1:?usage: nix/test-signals.sh <valet> <probe>}")"
probe="$(readlink -f "${2:?usage: nix/test-signals.sh <valet> <probe>}")"
work="$(mktemp -d)"
pid=""
cleanup() {
  [[ -n "$pid" ]] && kill -KILL "$pid" 2>/dev/null || true
  pkill -KILL -f 'sleep 31337' 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
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
# Exit status is not checked here: bwrap died from the same signal, so the
# wrapper reports bwrap's status. Valet's shutdown must still have finished.
if curl -fsS "http://localhost:$port/api/health" >/dev/null 2>&1; then
  echo "FAIL: server still answers after the wrapper exited (orphaned child)" >&2; exit 1
fi
echo "ok: group SIGTERM ran the graceful shutdown and the wrapper waited for it"

echo "== SIGKILL to the wrapper: Valet must still shut down gracefully, and free the port and data dir"
"$valet" serve --port "$port" --data-dir "$work/data3" --sandbox local >"$work/log3" 2>&1 &
pid=$!
wait_healthy
kill -KILL "$pid"
wait "$pid" 2>/dev/null || true
pid=""
for _ in $(seq 1 30); do
  grep -q "Received SIGTERM, shutting down" "$work/log3" && break
  sleep 1
done
grep -q "Received SIGTERM, shutting down" "$work/log3" \
  || { echo "FAIL: wrapper SIGKILL did not give Valet a SIGTERM" >&2; cat "$work/log3"; exit 1; }
for _ in $(seq 1 30); do
  pgrep -f -- "--data-dir $work/data3" >/dev/null 2>&1 || break
  sleep 1
done
if pgrep -f -- "--data-dir $work/data3" >/dev/null 2>&1; then
  echo "FAIL: Valet still running 30s after the wrapper was SIGKILLed" >&2; exit 1
fi
# Same port and same data dir: a leftover process would hold both.
"$valet" serve --port "$port" --data-dir "$work/data3" --sandbox local >"$work/log4" 2>&1 &
pid=$!
wait_healthy
kill -TERM "$pid"; wait "$pid" || true; pid=""
echo "ok: wrapper SIGKILL -> graceful shutdown, port and data dir reusable"

echo "== probe: regular invocation (stdin, arguments, exit status)"
out="$(printf 'hello stdin\n' | "$probe" cat)"
[[ "$out" == "hello stdin" ]] || { echo "FAIL: stdin not passed through: '$out'" >&2; exit 1; }
out="$("$probe" args 'a b' c)"
[[ "$out" == $'[a b]\n[c]' ]] || { echo "FAIL: arguments changed: '$out'" >&2; exit 1; }
st=0; "$probe" exit 7 || st=$?
[[ "$st" -eq 7 ]] || { echo "FAIL: exit status $st, expected 7" >&2; exit 1; }
echo "ok: stdin, arguments and exit status pass through"

# Start the probe in its own session, like a terminal job. The process group
# id equals the wrapper pid, so `kill -SIG -- -pid` is what Ctrl-C and Ctrl-\ do.
start_probe() {
  setsid "$probe" sleep >"$work/probe.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do grep -q probe-ready "$work/probe.log" && return 0; sleep 0.5; done
  echo "probe did not start" >&2; cat "$work/probe.log"; return 1
}

echo "== probe: SIGINT and SIGQUIT must not be ignored (as in a terminal)"
start_probe
ign="$(awk '/SigIgn/ {print $NF}' "$work/probe.log")"
if (( (16#$ign & 0x6) != 0 )); then
  echo "FAIL: SIGINT or SIGQUIT is ignored in the program (SigIgn=$ign)" >&2; exit 1
fi
echo "program SigIgn=$ign (SIGINT and SIGQUIT clear)"
for sig in INT QUIT; do
  [[ -n "$pid" ]] || start_probe
  kill -"$sig" -- "-$pid"
  st=0; wait "$pid" || st=$?
  pid=""
  want=$(( 128 + $(kill -l "$sig") ))
  [[ "$st" -eq "$want" ]] || { echo "FAIL: group SIG$sig gave exit status $st, expected $want" >&2; exit 1; }
  pgrep -f 'sleep 31337' >/dev/null && { echo "FAIL: program survived group SIG$sig" >&2; exit 1; }
  echo "ok: group SIG$sig ended the program (status $st)"
done

echo "== probe: SIGKILL of the wrapper must not leave the program running"
start_probe
kill -KILL "$pid"; wait "$pid" 2>/dev/null || true; pid=""
for _ in $(seq 1 20); do pgrep -f 'sleep 31337' >/dev/null || break; sleep 0.5; done
pgrep -f 'sleep 31337' >/dev/null && { echo "FAIL: program kept running after wrapper SIGKILL" >&2; exit 1; }
echo "ok: no program left after wrapper SIGKILL"

echo "== probe: SIGKILL at random moments during startup (parent-death race)"
for _ in $(seq 1 40); do
  setsid "$probe" sleep >/dev/null 2>&1 &
  p=$!
  sleep "0.$(( RANDOM % 60 ))"
  kill -KILL "$p" 2>/dev/null || true
  wait "$p" 2>/dev/null || true
done
for _ in $(seq 1 30); do pgrep -f 'sleep 31337' >/dev/null || break; sleep 1; done
pgrep -f 'sleep 31337' >/dev/null && { echo "FAIL: program left running after a startup-time SIGKILL" >&2; pgrep -af 'sleep 31337'; exit 1; }
echo "ok: no program left after startup-time SIGKILLs"
