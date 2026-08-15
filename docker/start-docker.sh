#!/usr/bin/env bash
# Launches rootless dockerd as the `dockerd` user. Idempotent: a second
# call while the daemon runs is a no-op. Never fails the caller — a broken
# daemon must not keep the sandbox from starting. If docker commands fail,
# read /var/log/valet/dockerd.log inside the sandbox.
set -u
if [ "${VALET_SANDBOX_DOCKER:-0}" != "1" ]; then exit 0; fi
# XDG_RUNTIME_DIR must be outside /run: rootlesskit's --copy-up=/run makes
# bind-mount paths under /run invisible across the user-namespace boundary,
# which breaks the detached-netns file lookup and the port-driver API socket.
RUNTIME_DIR=/tmp/valet-docker
SOCK="$RUNTIME_DIR/docker.sock"
LOG=/var/log/valet/dockerd.log
mkdir -p "$RUNTIME_DIR" /var/log/valet /home/dockerd/.local/share/docker
chown -R dockerd:dockerd "$RUNTIME_DIR" /home/dockerd/.local/share/docker
touch "$LOG" && chown dockerd:dockerd "$LOG"
if [ -S "$SOCK" ] && su -s /bin/sh dockerd -c "DOCKER_HOST=unix://$SOCK docker version" >/dev/null 2>&1; then
  exit 0
fi
su -s /bin/bash dockerd -c \
  "XDG_RUNTIME_DIR=$RUNTIME_DIR HOME=/home/dockerd PATH=/usr/bin:/usr/sbin:/usr/local/bin \
   nohup dockerd-rootless.sh --storage-driver=fuse-overlayfs >> $LOG 2>&1 &" || true
# Root-run docker CLIs (the agent) reach the daemon at the default path.
ln -sf "$SOCK" /var/run/docker.sock
exit 0
