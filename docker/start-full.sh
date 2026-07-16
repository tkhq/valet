#!/usr/bin/env bash
set -euo pipefail
WORK_DIR=/workspace
mkdir -p "$WORK_DIR"
if [ "${VALET_SANDBOX_PROFILE:-headless}" = "full" ]; then
  code-server --bind-addr "127.0.0.1:8765" --auth none \
    --disable-telemetry --disable-update-check --welcome-text "Valet Workspace" "$WORK_DIR" &
  CODE_SERVER_PID=$!
  ttyd -W -i 127.0.0.1 -p 7681 bash -c "cd $WORK_DIR && exec bash -l" &
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
  exec tail -f /dev/null
fi
