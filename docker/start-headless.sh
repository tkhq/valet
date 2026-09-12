#!/usr/bin/env bash
set -u
/start-docker.sh || exit $?
exec tail -f /dev/null
