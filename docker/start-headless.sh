#!/usr/bin/env bash
set -u
if [ "${VALET_SANDBOX_DOCKER:-0}" = 1 ] || [ "${VALET_SANDBOX_KUBERNETES:-0}" = 1 ]; then
  /cgroup-bootstrap.sh || exit $?
  export VALET_CGROUP_BOOTSTRAPPED=1
fi
if [ "${VALET_SANDBOX_KUBERNETES:-}" = 1 ]; then /kubernetes-preflight.sh || exit $?; fi
/start-docker.sh || exit $?
if [ "${VALET_BROWSER_ENABLED:-0}" = 1 ]; then /browser-preflight.sh || exit $?; fi
if [ -d /scratch ]; then
  mkdir -p /scratch/tmp /scratch/valet-jobs
  # Sticky and world-writable: non-privileged execs run as dockerd.
  chmod 1777 /scratch/tmp /scratch/valet-jobs
  # Background process logs live on scratch when it exists (spec B4).
  ln -sfn /scratch/valet-jobs /tmp/valet-jobs
  # A container restart killed every job, but /scratch kept its files. Mark
  # each job with no exit code dead, so a poll does not trust a reused pid.
  for pidfile in /scratch/valet-jobs/*.pid; do
    [ -e "$pidfile" ] || continue
    [ -e "${pidfile%.pid}.exit" ] || : > "${pidfile%.pid}.dead"
  done
fi
if [ "${VALET_BROWSER_VIEWER:-0}" = 1 ]; then exec node /gateway/dist/bin.js; fi
exec tail -f /dev/null
