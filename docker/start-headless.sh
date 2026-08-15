#!/usr/bin/env bash
set -u
/start-docker.sh || true
exec tail -f /dev/null
