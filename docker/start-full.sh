#!/usr/bin/env bash
set -euo pipefail
if [ "${VALET_SANDBOX_DOCKER:-0}" = 1 ] || [ "${VALET_SANDBOX_KUBERNETES:-0}" = 1 ]; then
  /cgroup-bootstrap.sh
  export VALET_CGROUP_BOOTSTRAPPED=1
fi
[ "${VALET_SANDBOX_KUBERNETES:-}" != 1 ] || /kubernetes-preflight.sh
if [ -x /start-docker.sh ]; then /start-docker.sh; fi
if [ "${VALET_BROWSER_ENABLED:-0}" = 1 ]; then /browser-preflight.sh; fi
WORK_DIR=/workspace
mkdir -p "$WORK_DIR"
if [ -d /scratch ]; then
  # Sticky root: the workload user cannot replace a root-owned entry.
  chmod 1777 /scratch
  mkdir -p /scratch/tmp /scratch/valet-jobs /scratch/tmp-root
  # Sticky and world-writable: non-privileged execs run as dockerd.
  chmod 1777 /scratch/tmp /scratch/valet-jobs
  chmod 700 /scratch/tmp-root
  # Background process logs live on scratch when it exists (spec B4).
  ln -sfn /scratch/valet-jobs /tmp/valet-jobs
  # A container restart killed every job, but /scratch kept its files. Mark
  # each job with no exit code dead, so a poll does not trust a reused pid.
  # Only jobs older than this start: a kickoff that races the loop keeps
  # its pid. A marker that already exists, or that root cannot write, is
  # left alone, so a planted entry never stops the start.
  stamp=$(mktemp 2>/dev/null) || stamp=
  if [ -n "$stamp" ]; then
    pids=$(find /scratch/valet-jobs -maxdepth 1 -name '*.pid' ! -newer "$stamp")
    rm -f "$stamp"
  else
    pids=$(find /scratch/valet-jobs -maxdepth 1 -name '*.pid')
  fi
  printf '%s\n' "$pids" | while IFS= read -r pidfile; do
    [ -n "$pidfile" ] || continue
    dead="${pidfile%.pid}.dead"
    [ -e "${pidfile%.pid}.exit" ] || [ -e "$dead" ] || [ -L "$dead" ] || : > "$dead" 2>/dev/null || :
  done
fi
# Root services use a root-only temp dir. The workload user keeps
# /scratch/tmp from the container env.
if [ -d /scratch/tmp-root ] && [ ! -L /scratch/tmp-root ] && [ -O /scratch/tmp-root ]; then
  export TMPDIR=/scratch/tmp-root
elif [ "${TMPDIR:-}" = /scratch/tmp ]; then
  unset TMPDIR
fi
if [ "${VALET_SANDBOX_PROFILE:-headless}" = "full" ]; then
  WORKLOAD_COMMAND=()
  if [ "${VALET_BROWSER_ENABLED:-0}" = 1 ]; then
    WORKLOAD_COMMAND=(/usr/bin/env -u VALET_SANDBOX_JWT_SECRET /usr/bin/setpriv --reuid dockerd --regid dockerd --init-groups --no-new-privs /usr/bin/env HOME=/home/dockerd USER=dockerd LOGNAME=dockerd)
    # The workload user cannot write the root temp dir.
    if [ -d /scratch/tmp ]; then WORKLOAD_COMMAND+=(TMPDIR=/scratch/tmp); fi
  fi
  "${WORKLOAD_COMMAND[@]}" code-server --bind-addr "127.0.0.1:8765" --auth none \
    --disable-telemetry --disable-update-check --welcome-text "Valet Workspace" "$WORK_DIR" &
  CODE_SERVER_PID=$!
  "${WORKLOAD_COMMAND[@]}" ttyd -W -i 127.0.0.1 -p 7681 bash -c "cd $WORK_DIR && exec bash -l" &
  TTYD_PID=$!
  node /gateway/dist/bin.js &
  GATEWAY_PID=$!

  # We run as PID 1, so nothing forwards signals to the backgrounded services by
  # default: on graceful pod termination they'd linger until the runtime SIGKILLs
  # the whole cgroup. Forward SIGTERM/SIGINT to all three so they can shut down
  # cleanly, and wait on the gateway (re-waiting if a trap interrupts us) so its
  # exit code becomes ours.
  trap 'kill -TERM "$CODE_SERVER_PID" "$TTYD_PID" "$GATEWAY_PID" 2>/dev/null || true' TERM INT

  set +e
  while true; do
    wait "$GATEWAY_PID"
    GATEWAY_EXIT=$?
    if kill -0 "$GATEWAY_PID" 2>/dev/null; then
      continue
    fi
    break
  done
  set -e
  exit "$GATEWAY_EXIT"
else
  if [ "${VALET_BROWSER_VIEWER:-0}" = 1 ]; then exec node /gateway/dist/bin.js; fi
  exec tail -f /dev/null
fi
