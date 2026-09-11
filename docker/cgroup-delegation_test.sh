#!/usr/bin/env bash
# shellcheck disable=SC2329 # Overrides are called indirectly by the sourced helper.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=docker/cgroup-delegation.sh
source "$ROOT/cgroup-delegation.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
USER_NAME=$(id -un); UID_GID=$(id -u):$(id -g)
fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "$2 not found in $1"; }

make_tree() {
  mkdir -p "$1/init/child"
  printf '%s\n' 'cpuset cpu io memory pids' > "$1/init/cgroup.controllers"
  touch "$1"/cgroup.procs "$1"/init/{cgroup.procs,cgroup.threads,cgroup.subtree_control,cpu.max,memory.max,pids.max} "$1/init/child/sentinel"
}
run_fails() {
  local name=$1; shift
  if delegate_cgroup_leaf "$@" 2> "$TMP/$name.err"; then fail "$name was accepted"; fi
}

# Exact non-recursive handoff, unchanged limits, and idempotence.
tree=$TMP/success; make_tree "$tree"; log=$TMP/chown.log; done=false
cgroup_chown() { printf '%s\n' "$*" >> "$log"; done=true; }
cgroup_stat() { $done && printf '%s\n' "$UID_GID"; }
cgroup_user_can_write() { $done; }
before=$(find "$tree" -printf '%P %u:%g %m %s\n' | sort | sha256sum)
delegate_cgroup_leaf "$tree" init "$USER_NAME"
expected="$UID_GID $tree/init $tree/init/cgroup.procs $tree/init/cgroup.threads $tree/init/cgroup.subtree_control"
[ "$(cat "$log")" = "$expected" ] || fail "unexpected or recursive chown"
[ "$before" = "$(find "$tree" -printf '%P %u:%g %m %s\n' | sort | sha256sum)" ] || fail "fake tree changed"
delegate_cgroup_leaf "$tree" init "$USER_NAME"
[ "$(sort -u "$log" | wc -l)" -eq 1 ] && [ "$(wc -l < "$log")" -eq 2 ] || fail "handoff is not idempotent"

# The disabled gate exits successfully. Both profiles propagate setup failure.
VALET_SANDBOX_DOCKER=0 bash "$ROOT/start-docker.sh"
contains "$ROOT/Dockerfile.sandbox-k8s" 'COPY docker/cgroup-delegation.sh /cgroup-delegation.sh'
fail_docker=$TMP/fail-docker; printf '#!/bin/sh\nexit 42\n' > "$fail_docker"; chmod +x "$fail_docker"
for profile in headless full; do
  sed -e "s|/start-docker.sh|$fail_docker|g" -e "s|WORK_DIR=/workspace|WORK_DIR=$TMP/workspace|" \
    "$ROOT/start-$profile.sh" > "$TMP/start-$profile.sh"
  set +e; bash "$TMP/start-$profile.sh"; status=$?; set -e
  expected=1; [ "$profile" = full ] && expected=42
  [ "$status" -eq "$expected" ] || fail "$profile returned $status instead of $expected"
done

# Required controllers and exact delegation objects fail closed.
for item in cpu pids; do
  tree=$TMP/no-$item; make_tree "$tree"
  sed -i "s/ $item//" "$tree/init/cgroup.controllers"
  run_fails "$item" "$tree" init "$USER_NAME"
  contains "$TMP/$item.err" "The $item cgroup controller is unavailable"
done
for item in cgroup.procs cgroup.threads cgroup.subtree_control; do
  tree=$TMP/no-${item//./-}; make_tree "$tree"; rm "$tree/init/$item"
  run_fails "$item" "$tree" init "$USER_NAME"
  contains "$TMP/$item.err" "required cgroup file /init/$item is missing"
done

# Chown, ownership verification, and workload-user writes each fail closed.
tree=$TMP/failures; make_tree "$tree"
cgroup_chown() { return 1; }; run_fails chown "$tree" init "$USER_NAME"
contains "$TMP/chown.err" 'Cannot delegate /sys/fs/cgroup/init'
cgroup_chown() { :; }; cgroup_stat() { printf '0:0\n'; }
run_fails ownership "$tree" init "$USER_NAME"; contains "$TMP/ownership.err" 'ownership check failed for /init'
cgroup_stat() { printf '%s\n' "$UID_GID"; }; cgroup_user_can_write() { return 1; }
run_fails writable "$tree" init "$USER_NAME"; contains "$TMP/writable.err" "is not writable by $USER_NAME"
for error in "$TMP"/*.err; do contains "$error" 'RuntimeClass'; done
echo "cgroup delegation tests passed"
