#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
HELPER=$ROOT/valet-kubernetes.mjs
STATE=/home/dockerd/.local/state/valet/kubernetes
LOCK=${STATE}.lock
SCOPE=/sys/fs/cgroup/init/valet-kubernetes
TMP=$(mktemp -d)
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() { [ -z "${owner:-}" ] || kill -KILL "$owner" 2>/dev/null || true; [ -z "${holder:-}" ] || kill -KILL "$holder" 2>/dev/null || true; rm -rf "$STATE" "$TMP"; rmdir "$SCOPE" 2>/dev/null || true; rm -f "$LOCK".*.ready; }
trap cleanup EXIT
cleanup

# Both no-op and real stop print stopped state but return success.
out=$(VALET_SANDBOX_EPOCH=test node "$HELPER" stop) || fail "no-op stop failed"
node -e 'const x=JSON.parse(process.argv[1]); if(x.state!=="stopped"||x.schema!==1) process.exit(1)' "$out"
# The production cleanup removes fake cgroup directories bottom-up with rmdir.
FAKE_SCOPE=$TMP/valet-kubernetes
mkdir -p "$FAKE_SCOPE/child"
node --input-type=module -e "import { removeOwnedCgroupDirectories } from '$HELPER'; if (!removeOwnedCgroupDirectories('$FAKE_SCOPE')) process.exit(1)"
[ ! -e "$FAKE_SCOPE" ] || fail "fake cgroup cleanup retained a directory"
mkdir "$FAKE_SCOPE" || fail "the next start cannot recreate its cgroup"
rmdir "$FAKE_SCOPE"

# Exercise the real cgroupfs stop path when the runner delegates a writable scope.
if mkdir "$SCOPE" 2>/dev/null; then
  mkdir -p "$STATE"
  printf '%s\n' '{"state":"ready","error":null,"epoch":"test"}' > "$STATE/state.json"
  chmod 700 "$STATE"; chmod 600 "$STATE/state.json"
  out=$(VALET_SANDBOX_EPOCH=test node "$HELPER" stop) || fail "real stop failed"
  node -e 'const x=JSON.parse(process.argv[1]); if(x.state!=="stopped"||x.schema!==1) process.exit(1)' "$out"
  [ ! -e "$SCOPE" ] || fail "stop retained the empty cgroup"
fi

# Killing the lock owner cannot leave the flock holder behind.
node --input-type=module -e "import { withLock } from '$HELPER'; withLock(false, () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000));" & owner=$!
for _ in $(seq 1 100); do compgen -G "$LOCK.$owner.*.ready" >/dev/null && break; sleep 0.02; done
compgen -G "$LOCK.$owner.*.ready" >/dev/null || fail "lock owner did not acquire"
holder=$(pgrep -P "$owner" | head -1) || fail "lock holder was not found"
kill -KILL "$owner"; wait "$owner" 2>/dev/null || true
start=$(date +%s)
set +e; VALET_SANDBOX_EPOCH=test node "$HELPER" status >/dev/null; status=$?; set -e
[ "$status" -eq 3 ] || fail "status could not acquire after owner death: $status"
[ $(( $(date +%s) - start )) -lt 5 ] || fail "orphan holder delayed the next lock"
for _ in $(seq 1 100); do compgen -G "$LOCK.$owner.*.ready" >/dev/null || break; sleep 0.02; done
compgen -G "$LOCK.$owner.*.ready" >/dev/null && fail "orphan lock holder remained"
kill -0 "$holder" 2>/dev/null && fail "orphan holder process remained"

echo "valet-kubernetes command tests passed"
