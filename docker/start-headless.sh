#!/usr/bin/env bash
set -u
if [ "${VALET_SANDBOX_DOCKER:-0}" = 1 ] || [ "${VALET_SANDBOX_KUBERNETES:-0}" = 1 ]; then
  /cgroup-bootstrap.sh || exit $?
  export VALET_CGROUP_BOOTSTRAPPED=1
fi
if [ "${VALET_SANDBOX_KUBERNETES:-}" = 1 ]; then /kubernetes-preflight.sh || exit $?; fi
/start-docker.sh || exit $?
exec tail -f /dev/null
