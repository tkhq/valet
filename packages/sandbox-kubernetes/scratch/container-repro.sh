#!/bin/sh
# Container repro for task-9's cancel-path review findings (DEFECT 1 + DEFECT
# 2). Run this INSIDE a container matching docker/Dockerfile.sandbox-k8s
# (node:22-bookworm-slim + procps/coreutils), where /bin/sh is dash — this
# cannot be validated on macOS, whose /bin/sh is not dash.
#
# The command strings embedded below (between the EOF1..EOF6 heredocs) are
# the LITERAL output of jobs.ts's jobKickoffCommand/cancelCommand/pollCommand
# for two jobs ("repro-uncapped" running plain `sleep 30`, "repro-capped"
# running the same under a 1024-byte maxOutputBytes cap) — generated via:
#   pnpm exec tsx scratch/print-commands.ts
# and pasted in verbatim, so this script exercises the REAL generated shell
# protocol, not a hand-written analog of it.
#
#   docker run --rm -v "$(pwd)/../..:/repo" -w /repo/packages/sandbox-kubernetes \
#     valet-sandbox:dev sh scratch/container-repro.sh

set -u
failures=0
pass() { echo "PASS  $1"; }
fail() {
  failures=$((failures + 1))
  echo "FAIL  $1"
}

echo "--- shell identity (must be dash, not a macOS /bin/sh) ---"
readlink -f /bin/sh

rm -rf /tmp/valet-jobs
mkdir -p /tmp/valet-jobs

UNCAPPED_KICKOFF=$(cat <<'EOF1'
mkdir -p '/tmp/valet-jobs' && : > '/tmp/valet-jobs/repro-uncapped.out' && ( setsid sh -c 'echo $$ > '\''/tmp/valet-jobs/repro-uncapped.pid'\''; exec sh -c '\''sleep 30'\''' < /dev/null > '/tmp/valet-jobs/repro-uncapped.out' 2>&1; echo $? > '/tmp/valet-jobs/repro-uncapped.exit' ) & i=0; while [ ! -f '/tmp/valet-jobs/repro-uncapped.pid' ] && [ ! -f '/tmp/valet-jobs/repro-uncapped.exit' ] && [ "$i" -lt 500 ]; do sleep 0.01; i=$((i+1)); done; echo started
EOF1
)

CAPPED_KICKOFF=$(cat <<'EOF2'
mkdir -p '/tmp/valet-jobs' && : > '/tmp/valet-jobs/repro-capped.out' && ( rm -f '/tmp/valet-jobs/repro-capped.fifo'; mkfifo '/tmp/valet-jobs/repro-capped.fifo'; ( head -c 1024 > '/tmp/valet-jobs/repro-capped.out'; cat > /dev/null ) < '/tmp/valet-jobs/repro-capped.fifo' & filterpid=$!; setsid sh -c 'echo $$ > '\''/tmp/valet-jobs/repro-capped.pid'\''; exec sh -c '\''sleep 30'\''' < /dev/null > '/tmp/valet-jobs/repro-capped.fifo' 2>&1; echo $? > '/tmp/valet-jobs/repro-capped.exit'; wait "$filterpid"; rm -f '/tmp/valet-jobs/repro-capped.fifo' ) & i=0; while [ ! -f '/tmp/valet-jobs/repro-capped.pid' ] && [ ! -f '/tmp/valet-jobs/repro-capped.exit' ] && [ "$i" -lt 500 ]; do sleep 0.01; i=$((i+1)); done; echo started
EOF2
)

CANCEL_UNCAPPED=$(cat <<'EOF3'
if [ -f '/tmp/valet-jobs/repro-uncapped.pid' ]; then pid=$(cat '/tmp/valet-jobs/repro-uncapped.pid'); kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi; for i in 1 2 3 4 5 6 7 8 9 10; do [ -f '/tmp/valet-jobs/repro-uncapped.exit' ] && break; sleep 0.3; done
EOF3
)

CANCEL_CAPPED=$(cat <<'EOF4'
if [ -f '/tmp/valet-jobs/repro-capped.pid' ]; then pid=$(cat '/tmp/valet-jobs/repro-capped.pid'); kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi; for i in 1 2 3 4 5 6 7 8 9 10; do [ -f '/tmp/valet-jobs/repro-capped.exit' ] && break; sleep 0.3; done
EOF4
)

POLL_UNCAPPED=$(cat <<'EOF5'
if [ ! -f '/tmp/valet-jobs/repro-uncapped.out' ]; then echo unknown 1>&2; exit 0; fi; tail -c +1 '/tmp/valet-jobs/repro-uncapped.out' | base64 -w0; if [ -f '/tmp/valet-jobs/repro-uncapped.exit' ]; then cat '/tmp/valet-jobs/repro-uncapped.exit' 1>&2; else echo running 1>&2; fi
EOF5
)

POLL_CAPPED=$(cat <<'EOF6'
if [ ! -f '/tmp/valet-jobs/repro-capped.out' ]; then echo unknown 1>&2; exit 0; fi; tail -c +1 '/tmp/valet-jobs/repro-capped.out' | base64 -w0; if [ -f '/tmp/valet-jobs/repro-capped.exit' ]; then cat '/tmp/valet-jobs/repro-capped.exit' 1>&2; else echo running 1>&2; fi
EOF6
)

# ── DEFECT 1: uncapped job's child must actually be reaped on cancel ──────
echo "=== DEFECT 1: uncapped job cancel — process-group reap ==="
sh -c "$UNCAPPED_KICKOFF"
sleep 0.2
pgid1=$(cat /tmp/valet-jobs/repro-uncapped.pid)
echo "recorded pgid=$pgid1"

if ps -eo pid,pgid,args | awk -v p="$pgid1" '$2==p' | grep -q .; then
  pass "process group alive before cancel (sanity check)"
else
  fail "process group alive before cancel (sanity check) — nothing to prove if it was never running"
fi

sh -c "$CANCEL_UNCAPPED"

remaining1=$(ps -eo pid,pgid,args | awk -v p="$pgid1" '$2==p')
if [ -z "$remaining1" ]; then
  pass "DEFECT 1: process group fully reaped after cancelJob (no orphaned sleep child under dash)"
else
  fail "DEFECT 1: orphaned process(es) survive cancelJob: $remaining1"
fi

# ── DEFECT 2: capped job's EXIT must appear promptly on cancel ────────────
echo ""
echo "=== DEFECT 2: capped job cancel — prompt EXIT sentinel ==="
sh -c "$CAPPED_KICKOFF"
sleep 0.2

start_ns=$(date +%s%N)
sh -c "$CANCEL_CAPPED"
end_ns=$(date +%s%N)
elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
echo "cancelCommand elapsed: ${elapsed_ms}ms"

# cancelCommand's own poll-for-EXIT loop is 10 * 300ms = up to 3000ms if
# EXIT never appears (the pre-fix behavior). A prompt write should resolve
# in well under one poll cycle.
if [ "$elapsed_ms" -lt 1000 ]; then
  pass "DEFECT 2: cancelCommand returned promptly (${elapsed_ms}ms, budget was up to 3000ms pre-fix)"
else
  fail "DEFECT 2: cancelCommand took ${elapsed_ms}ms — EXIT sentinel was not written promptly"
fi

poll_out=$(sh -c "$POLL_CAPPED" 2>/tmp/poll_capped.stderr)
poll_status=$(cat /tmp/poll_capped.stderr)
echo "poll status marker: $poll_status"
case "$poll_status" in
  running|unknown) fail "DEFECT 2: capped job not reported done after cancel (marker: $poll_status)" ;;
  *) pass "DEFECT 2: capped job reports a terminal exit code ($poll_status) after cancel" ;;
esac

# Also verify the capped job's process group was reaped, same as DEFECT 1.
pgid2=$(cat /tmp/valet-jobs/repro-capped.pid 2>/dev/null || echo "")
if [ -n "$pgid2" ]; then
  remaining2=$(ps -eo pid,pgid,args | awk -v p="$pgid2" '$2==p')
  if [ -z "$remaining2" ]; then
    pass "DEFECT 1 (capped variant): process group fully reaped after cancelJob"
  else
    fail "DEFECT 1 (capped variant): orphaned process(es) survive cancelJob: $remaining2"
  fi
fi

# ── Sanity: capped job's output still flows through the fifo correctly on
# NORMAL completion (not cancel) — proves the mkfifo-ordering fix didn't
# break the happy path while fixing the race. ─────────────────────────────
echo ""
echo "=== Sanity: capped job normal completion (output actually flows through the fifo) ==="
rm -rf /tmp/valet-jobs
mkdir -p /tmp/valet-jobs
NORMAL_CAPPED_KICKOFF=$(printf '%s' "$CAPPED_KICKOFF" | sed "s/sleep 30/echo hello-world/")
sh -c "$NORMAL_CAPPED_KICKOFF"
sleep 0.5
out_content=$(cat /tmp/valet-jobs/repro-capped.out 2>/dev/null || echo "<missing>")
exit_content=$(cat /tmp/valet-jobs/repro-capped.exit 2>/dev/null || echo "<missing>")
echo "out=[$out_content] exit=[$exit_content]"
if [ "$out_content" = "hello-world" ] && [ "$exit_content" = "0" ]; then
  pass "capped job's normal-completion output/exit code both correct through the fifo"
else
  fail "capped job's normal-completion output/exit code wrong (out=[$out_content] exit=[$exit_content])"
fi

rm -rf /tmp/valet-jobs

echo ""
if [ "$failures" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "$failures CHECK(S) FAILED"
  exit 1
fi
