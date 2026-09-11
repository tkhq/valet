#!/usr/bin/env bash
# shellcheck disable=SC2329 # Overrides are called by the sourced helper.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=docker/cgroup-delegation.sh
source "$ROOT/cgroup-delegation.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
USER_NAME=$(id -un); UID_GID=$(id -u):$(id -g)
fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "$2 not found in $1"; }

make_tree() {
  mkdir -p "$1/init"
  printf '%s\n' 'cpuset cpu io memory pids' > "$1/init/cgroup.controllers"
  : > "$1/init/cgroup.procs"; : > "$1/init/cgroup.threads"
  : > "$1/init/cgroup.subtree_control"
  touch "$1"/{cgroup.procs,cpu.max,memory.max,pids.max}
}
install_fake_cgroup() {
  tree=$1
  moves=$TMP/moves; : > "$moves"; enable_log=$TMP/enable; : > "$enable_log"; : > "$TMP/chown"
  cgroup_mkdir() {
    mkdir -p "$1"; : > "$1/cgroup.procs"; : > "$1/cgroup.threads"
    : > "$1/cgroup.subtree_control"; : > "$1/cgroup.controllers"
  }
  cgroup_stat() { [ "$1" = "$tree/init/services" ] && echo 0:0 || echo "$UID_GID"; }
  cgroup_chown() { printf '%s\n' "$*" >> "$TMP/chown"; }
  cgroup_user_can_write() { :; }
  cgroup_pid_exists() { [ -d "/proc/$1" ]; }
  cgroup_move_pid() {
    printf '%s\n' "$2" >> "$moves"
    sed -i "/^$2$/d" "$tree/init/cgroup.procs" "$tree/init/cgroup.threads"
  }
  cgroup_enable() {
    if cgroup_has_members "$tree/init/cgroup.procs" \
      || cgroup_has_members "$tree/init/cgroup.threads"; then
      fail "controllers enabled before /init was empty"
    fi
    printf '%s\n' "$2" >> "$enable_log"
    tr -d '+' <<<"$2" | tr ' ' '\n' | sed '/^$/d' | paste -sd' ' > "$tree/init/cgroup.subtree_control"
    cp "$tree/init/cgroup.subtree_control" "$tree/init/services/cgroup.controllers"
  }
}
run_fails() {
  local name=$1; shift
  if establish_cgroup_topology "$@" 2> "$TMP/$name.err"; then fail "$name was accepted"; fi
}

# Kernfs reports size zero for populated cgroup files. Inspect content instead.
fifo=$TMP/kernfs-members; mkfifo "$fifo"; printf '42\n' > "$fifo" & writer=$!
if [ -s "$fifo" ] || ! cgroup_has_members "$fifo"; then fail "size-zero members were missed"; fi
wait "$writer"

# Move only direct /init processes, then enable all available controllers.
tree=$TMP/success; make_tree "$tree"; printf '1\n10\n20\n' > "$tree/init/cgroup.procs"
printf '1\n10\n20\n' > "$tree/init/cgroup.threads"; printf '999\n' > "$tree/cgroup.procs"
limits_before=$(stat -c '%n %u:%g %s' "$tree/cpu.max" "$tree/memory.max" "$tree/pids.max")
install_fake_cgroup "$tree"; establish_cgroup_topology "$tree" "$USER_NAME"
[ "$(cat "$moves")" = $'1\n10\n20' ] || fail "wrong direct processes moved"
[ "$(cat "$tree/cgroup.procs")" = 999 ] || fail "outer process moved"
contains "$enable_log" '+cpuset +cpu +io +memory +pids'
contains "$tree/init/services/cgroup.controllers" cpu
contains "$tree/init/services/cgroup.controllers" pids
expected="$UID_GID $tree/init $tree/init/cgroup.procs $tree/init/cgroup.threads $tree/init/cgroup.subtree_control"
[ "$(cat "$TMP/chown")" = "$expected" ] || fail "delegation changed unexpected ownership"
[ "$(stat -c '%n %u:%g %s' "$tree/cpu.max" "$tree/memory.max" "$tree/pids.max")" = "$limits_before" ] \
  || fail "outer limits changed"

# A bounded second pass handles one arrival. Persistent arrivals fail closed.
tree=$TMP/race; make_tree "$tree"; echo 1 > "$tree/init/cgroup.procs"; install_fake_cgroup "$tree"
arrival=0; cgroup_move_pid() {
  printf '%s\n' "$2" >> "$moves"; sed -i "/^$2$/d" "$tree/init/cgroup.procs"
  if [ "$arrival" -eq 0 ]; then echo 2 > "$tree/init/cgroup.procs"; arrival=1; fi
}
establish_cgroup_topology "$tree" "$USER_NAME"; [ "$(cat "$moves")" = $'1\n2' ] || fail "arrival not moved"

# An exited PID can make the migration write fail. Rescan without failing.
tree=$TMP/exited; make_tree "$tree"; echo 41 > "$tree/init/cgroup.procs"; install_fake_cgroup "$tree"
cgroup_move_pid() {
  printf '%s\n' "$2" >> "$moves"; sed -i "/^$2$/d" "$tree/init/cgroup.procs"
  if [ "$2" = 41 ]; then echo 42 > "$tree/init/cgroup.procs"; return 1; fi
}
cgroup_pid_exists() { [ "$1" != 41 ]; }
establish_cgroup_topology "$tree" "$USER_NAME"
[ "$(cat "$moves")" = $'41\n42' ] || fail "PID disappearance did not rescan"

tree=$TMP/live-failure; make_tree "$tree"; echo 43 > "$tree/init/cgroup.procs"; install_fake_cgroup "$tree"
cgroup_move_pid() { return 1; }; cgroup_pid_exists() { return 0; }
run_fails live-move "$tree" "$USER_NAME"; contains "$TMP/live-move.err" 'Cannot move live process 43'

tree=$TMP/busy; make_tree "$tree"; echo 1 > "$tree/init/cgroup.procs"; install_fake_cgroup "$tree"
cgroup_move_pid() { echo 1 > "$tree/init/cgroup.procs"; }
run_fails busy "$tree" "$USER_NAME"; contains "$TMP/busy.err" 'Processes keep entering /init'
! cgroup_has_members "$enable_log" || fail "controllers enabled for a busy manager"

# Existing empty services is idempotent. Foreign and unsafe paths fail closed.
tree=$TMP/idempotent; make_tree "$tree"; install_fake_cgroup "$tree"
establish_cgroup_topology "$tree" "$USER_NAME"; establish_cgroup_topology "$tree" "$USER_NAME"
mkdir "$tree/init/foreign"; run_fails foreign "$tree" "$USER_NAME"
rm -rf "$tree/init/foreign" "$tree/init/services"; ln -s /tmp "$tree/init/services"
run_fails symlink "$tree" "$USER_NAME"
if bash "$ROOT/cgroup-delegation.sh" "$TMP/not-cgroup" "$USER_NAME" 2> "$TMP/injection.err"; then
  fail "path injection was accepted"
fi
contains "$TMP/injection.err" 'Refusing the unexpected cgroup root'

# Required controllers and inherited state fail closed.
for item in cpu pids; do
  tree=$TMP/no-$item; make_tree "$tree"; sed -i "s/ $item//" "$tree/init/cgroup.controllers"
  install_fake_cgroup "$tree"; run_fails "$item" "$tree" "$USER_NAME"
  contains "$TMP/$item.err" "The $item cgroup controller is unavailable"
done
tree=$TMP/no-inherit; make_tree "$tree"; install_fake_cgroup "$tree"
cgroup_enable() { printf 'cpu pids\n' > "$tree/init/cgroup.subtree_control"; : > "$tree/init/services/cgroup.controllers"; }
run_fails inherit "$tree" "$USER_NAME"; contains "$TMP/inherit.err" 'did not inherit cpu'
tree=$TMP/ebusy; make_tree "$tree"; install_fake_cgroup "$tree"
cgroup_enable() { return 1; }; run_fails ebusy "$tree" "$USER_NAME"
contains "$TMP/ebusy.err" 'Cannot enable controllers below /init'
tree=$TMP/owner; make_tree "$tree"; install_fake_cgroup "$tree"
cgroup_stat() { echo 1500:1500; }; run_fails owner "$tree" "$USER_NAME"
contains "$TMP/owner.err" 'services is not owned by mapped root'
for item in cgroup.procs cgroup.threads cgroup.subtree_control; do
  tree=$TMP/no-${item//./-}; make_tree "$tree"; rm "$tree/init/$item"; install_fake_cgroup "$tree"
  run_fails "$item" "$tree" "$USER_NAME"
  contains "$TMP/$item.err" "required cgroup file /init/$item is missing"
done

# Delegation failures remain fail-closed and actionable.
tree=$TMP/delegation; make_tree "$tree"; install_fake_cgroup "$tree"
cgroup_chown() { return 1; }; run_fails chown "$tree" "$USER_NAME"
contains "$TMP/chown.err" 'Cannot delegate /sys/fs/cgroup/init'
install_fake_cgroup "$tree"; bad_owner="$tree/init/cgroup.threads"; cgroup_stat() {
  if [ "$1" = "$tree/init/services" ]; then echo 0:0; elif [ "$1" = "$bad_owner" ]; then echo 999:999; else echo "$UID_GID"; fi
}
run_fails ownership "$tree" "$USER_NAME"
contains "$TMP/ownership.err" 'ownership check failed for /init/cgroup.threads'
install_fake_cgroup "$tree"; cgroup_user_can_write() { return 1; }
run_fails writable "$tree" "$USER_NAME"; contains "$TMP/writable.err" "is not writable by $USER_NAME"

# The disabled gate and local rootless branch do not call the helper.
VALET_SANDBOX_DOCKER=0 bash "$ROOT/start-docker.sh"
contains "$ROOT/Dockerfile.sandbox-k8s" 'COPY docker/cgroup-delegation.sh /cgroup-delegation.sh'
sed '/^# ── Rootless dockerd/,$c\exit 0' "$ROOT/start-docker.sh" > "$TMP/gate.sh"
! grep -q '^+ /cgroup-delegation.sh' <(VALET_SANDBOX_DOCKER=1 VALET_DOCKER_USERNS=0 bash -x "$TMP/gate.sh" 2>&1) \
  || fail "local rootless Docker called cgroup topology setup"

# Both profiles propagate setup failure.
fail_docker=$TMP/fail-docker; printf '#!/bin/sh\nexit 42\n' > "$fail_docker"; chmod +x "$fail_docker"
for profile in headless full; do
  sed -e "s|/start-docker.sh|$fail_docker|g" -e "s|WORK_DIR=/workspace|WORK_DIR=$TMP/workspace|" \
    "$ROOT/start-$profile.sh" > "$TMP/start-$profile.sh"
  set +e; bash "$TMP/start-$profile.sh"; status=$?; set -e
  expected=1; [ "$profile" = full ] && expected=42
  [ "$status" -eq "$expected" ] || fail "$profile returned $status instead of $expected"
done
for error in "$TMP"/*.err; do contains "$error" 'valet-docker RuntimeClass'; done
echo "cgroup delegation tests passed"
