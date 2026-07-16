#!/usr/bin/env bash
set -euo pipefail
WORK_DIR=/workspace
mkdir -p "$WORK_DIR"
if [ "${VALET_SANDBOX_PROFILE:-headless}" = "full" ]; then
  code-server --bind-addr "127.0.0.1:8765" --auth none \
    --disable-telemetry --disable-update-check --welcome-text "Valet Workspace" "$WORK_DIR" &
  ttyd -W -i 127.0.0.1 -p 7681 bash -c "cd $WORK_DIR && exec bash -l" &
  exec node /gateway/dist/bin.js
else
  exec tail -f /dev/null
fi
