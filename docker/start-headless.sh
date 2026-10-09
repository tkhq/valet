#!/usr/bin/env bash
set -u
# Taken first, before docker starts: the .dead loop below skips any pid newer than it.
scratch_stamp=$(mktemp 2>/dev/null) || scratch_stamp=
if [ "${VALET_SANDBOX_DOCKER:-0}" = 1 ] || [ "${VALET_SANDBOX_KUBERNETES:-0}" = 1 ]; then
  /cgroup-bootstrap.sh || exit $?
  export VALET_CGROUP_BOOTSTRAPPED=1
fi
if [ "${VALET_SANDBOX_KUBERNETES:-}" = 1 ]; then /kubernetes-preflight.sh || exit $?; fi
/start-docker.sh || exit $?
if [ "${VALET_BROWSER_ENABLED:-0}" = 1 ]; then /browser-preflight.sh || exit $?; fi
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
  # Only jobs older than this script's start: a kickoff that races the
  # loop keeps its pid. A marker that already exists, or that root cannot
  # write, is left alone, so a planted entry never stops the start. The
  # k8s start prefix runs the same loop first and sets the flag.
  if [ "${VALET_SCRATCH_DEAD_MARKED:-}" != 1 ]; then
    for pidfile in /scratch/valet-jobs/*.pid; do
      [ -e "$pidfile" ] || continue
      if [ -n "$scratch_stamp" ] && [ "$pidfile" -nt "$scratch_stamp" ]; then continue; fi
      dead="${pidfile%.pid}.dead"
      [ -e "${pidfile%.pid}.exit" ] || [ -e "$dead" ] || [ -L "$dead" ] || : > "$dead" 2>/dev/null || :
    done
  fi
  [ -z "$scratch_stamp" ] || rm -f "$scratch_stamp"
fi
# Root services use a root-only temp dir. The workload user keeps
# /scratch/tmp from the container env.
if [ -d /scratch/tmp-root ] && [ ! -L /scratch/tmp-root ] && [ -O /scratch/tmp-root ]; then
  export TMPDIR=/scratch/tmp-root
elif [ "${TMPDIR:-}" = /scratch/tmp ]; then
  unset TMPDIR
fi
if [ "${VALET_BROWSER_VIEWER:-0}" = 1 ]; then exec node /gateway/dist/bin.js; fi
exec tail -f /dev/null
