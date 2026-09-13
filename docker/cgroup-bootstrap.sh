#!/usr/bin/env bash
# Establish the mapped-root cgroup topology before nested runtime checks.
# Local rootless Docker and ordinary sandboxes do not need this topology.
set -u
[ "${VALET_DOCKER_USERNS:-0}" = 1 ] || [ "${VALET_SANDBOX_KUBERNETES:-0}" = 1 ] || exit 0
LOG=/var/log/valet/dockerd.log
mkdir -p /var/log/valet
: >> "$LOG"
bootstrap_fail() {
  printf 'valet: %s\n' "$1" >>"$LOG"
  [ "${VALET_SANDBOX_KUBERNETES:-0}" != 1 ] || printf 'Error: %s\n' "$1" >&2
  exit 1
}

for file in cgroup.controllers cgroup.procs cgroup.subtree_control; do
  [ -f "/sys/fs/cgroup/$file" ] || bootstrap_fail "Cgroup v2 topology is incomplete. Correct the valet-docker RuntimeClass, then recreate the sandbox."
done
# Kubelet sets a per-mount read-only flag. A bind remount can clear that flag
# from inside the pod user namespace without changing the superblock.
mount -o remount,bind,rw /sys/fs/cgroup 2>>"$LOG" \
  || mount -o remount,rw /sys/fs/cgroup 2>>"$LOG" \
  || echo "valet: cgroup2 rw remount failed; nested runtimes will fail on read-only cgroupfs" >>"$LOG"
if ! mkdir -p /sys/fs/cgroup/init 2>>"$LOG"; then
  bootstrap_fail "The pod cgroup is not writable. Correct the valet-docker RuntimeClass, then recreate the sandbox."
fi

# Evacuate the pod cgroup before enabling controllers for /init. Retry because
# a concurrent exec can enter the pod cgroup between migration and delegation.
for _ in $(seq 1 10); do
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>>"$LOG" || true
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
    > /sys/fs/cgroup/cgroup.subtree_control 2>>"$LOG" && break
  sleep 0.1
done
required="cpu pids"
controllers=""
if [ "${VALET_SANDBOX_KUBERNETES:-0}" = 1 ]; then
  required="cpu cpuset memory pids"
  controllers="$required"
fi
enabled=$(tr -d + < /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null) || enabled=""
for controller in $required; do
  case " $enabled " in *" $controller "*) ;; *)
    bootstrap_fail "The $controller cgroup controller is unavailable. Correct the valet-docker RuntimeClass, then recreate the sandbox."
  esac
done

if ! /cgroup-delegation.sh /sys/fs/cgroup dockerd ${controllers:+"$controllers"} 2>>"$LOG"; then
  bootstrap_fail "Cgroup delegation failed. Correct the valet-docker RuntimeClass, then recreate the sandbox."
fi
