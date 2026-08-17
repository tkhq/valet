#!/usr/bin/env bash
# Launches rootless dockerd as the `dockerd` user. Idempotent: a second
# call while the daemon runs is a no-op. Never fails the caller — a broken
# daemon must not keep the sandbox from starting. If docker commands fail,
# read /var/log/valet/dockerd.log inside the sandbox.
#
# Invokes rootlesskit DIRECTLY instead of dockerd-rootless.sh: the wrapper
# forces --detach-netns, and its detached-netns setup runs
# `sysctl net.ipv4.ip_forward=1` through /proc/sys — which is read-only when
# the pod's /proc is masked (any cluster that drops `procMount: Unmasked`,
# e.g. EKS <= 1.32 where the ProcMountType gate is off). Without
# --detach-netns rootlesskit configures the netns itself and the daemon
# starts on masked-proc clusters too. See
# docs/specs/2026-08-15-sandbox-docker-design.md, "Kubernetes reality".
set -u
if [ "${VALET_SANDBOX_DOCKER:-0}" != "1" ]; then exit 0; fi
# XDG_RUNTIME_DIR must be outside /run: rootlesskit's --copy-up=/run makes
# bind-mount paths under /run invisible across the user-namespace boundary,
# which breaks the port-driver API socket.
RUNTIME_DIR=/tmp/valet-docker
SOCK="$RUNTIME_DIR/docker.sock"
LOG=/var/log/valet/dockerd.log
DATA_ROOT=/home/dockerd/.local/share/docker
mkdir -p "$RUNTIME_DIR" /var/log/valet "$DATA_ROOT"
chown -R dockerd:dockerd "$RUNTIME_DIR" "$DATA_ROOT"
touch "$LOG"
chown dockerd:dockerd "$LOG"
# Make the workspace writable by the workload user. Non-recursive on
# purpose: at first start the mount is empty or freshly cloned by prep
# running as dockerd; a recursive chown of a large repo would be slow.
chown dockerd:dockerd /workspace 2>/dev/null || true
if [ -S "$SOCK" ] && su -s /bin/sh dockerd -c "DOCKER_HOST=unix://'$SOCK' docker version" >/dev/null 2>&1; then
  exit 0
fi

# Storage driver: probe what this environment supports, best first.
#  - overlay2: native kernel overlayfs inside the rootless user namespace
#    (kernel >= 5.11). Needs the data-root on a non-overlay filesystem —
#    true on kubernetes (emptyDir volume), false on the docker backend
#    (container rootfs IS overlay, mount returns EINVAL).
#  - fuse-overlayfs: needs /dev/fuse to be OPENABLE, not just present. On
#    kubernetes a hostPath char device carries no device-cgroup grant, so
#    open() fails with EPERM; the docker backend's `--device /dev/fuse`
#    grants it.
#  - vfs: always works; slow, no layer sharing. Last resort.
DRIVER=vfs
if su -s /bin/sh dockerd -c "unshare --user --map-root-user --mount /bin/sh -c 'cd $DATA_ROOT && rm -rf .ovlprobe && mkdir -p .ovlprobe/l .ovlprobe/u .ovlprobe/w .ovlprobe/m && mount -t overlay overlay -olowerdir=.ovlprobe/l,upperdir=.ovlprobe/u,workdir=.ovlprobe/w .ovlprobe/m'" >>"$LOG" 2>&1; then
  DRIVER=overlay2
elif su -s /bin/sh dockerd -c 'exec 3<>/dev/fuse' 2>>"$LOG"; then
  DRIVER=fuse-overlayfs
fi
su -s /bin/sh dockerd -c "rm -rf '$DATA_ROOT/.ovlprobe'" 2>/dev/null || true
echo "valet: starting rootless dockerd with storage driver: $DRIVER" >> "$LOG"

su -s /bin/bash dockerd -c \
  "XDG_RUNTIME_DIR='$RUNTIME_DIR' HOME=/home/dockerd PATH=/usr/bin:/usr/sbin:/usr/local/bin \
   nohup rootlesskit \
     --state-dir='$RUNTIME_DIR/rootlesskit' \
     --net=slirp4netns --mtu=65520 \
     --slirp4netns-sandbox=auto --slirp4netns-seccomp=auto \
     --disable-host-loopback --port-driver=builtin \
     --copy-up=/etc --copy-up=/run --propagation=rslave \
     dockerd --storage-driver=$DRIVER --host=unix://'$SOCK' --data-root='$DATA_ROOT' \
     >> '$LOG' 2>&1 &" || true
# Poll until the daemon socket appears (up to ~10s) before creating the symlink.
# If the daemon fails to start, skip the symlink — callers can read $LOG.
for i in $(seq 1 20); do
  [ -S "$SOCK" ] && break
  sleep 0.5
done
if [ -S "$SOCK" ]; then
  ln -sf "$SOCK" /var/run/docker.sock
fi
exit 0
