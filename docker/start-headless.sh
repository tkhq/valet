#!/usr/bin/env bash
set -u
if ! /start-docker.sh; then exit 1; fi
exec tail -f /dev/null
