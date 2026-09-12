#!/usr/bin/env bash
set -u
if [ "${VALET_SANDBOX_KUBERNETES:-}" = 1 ]; then /kubernetes-preflight.sh || exit $?; fi
/start-docker.sh || exit $?
exec tail -f /dev/null
