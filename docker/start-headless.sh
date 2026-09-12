#!/usr/bin/env bash
set -u
[ "${VALET_SANDBOX_KUBERNETES:-}" != 1 ] || /kubernetes-preflight.sh
/start-docker.sh || exit $?
exec tail -f /dev/null
