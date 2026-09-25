#!/bin/bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
browser_uid=${VALET_BROWSER_UID:-1501}
browser_gid=${VALET_BROWSER_GID:-1501}
if [[ ! $browser_uid =~ ^[1-9][0-9]*$ || ! $browser_gid =~ ^[1-9][0-9]*$ ]]; then
  echo 'Browser identity is invalid. Configure a non-root browser UID and GID.' >&2
  exit 78
fi
browser_identity=()
if [[ $(id -u) == 0 ]]; then
  browser_identity=(setpriv --reuid "$browser_uid" --regid "$browser_gid" --clear-groups --no-new-privs)
elif [[ $(id -u) != "$browser_uid" ]]; then
  echo 'The browser client has another process owner. Run the installed client with the configured browser identity.' >&2
  exit 78
fi
exec "${browser_identity[@]}" env -i PATH=/usr/local/bin:/usr/bin:/bin \
  HOME=/var/lib/valet/browser PLAYWRIGHT_BROWSERS_PATH=/opt/valet/playwright \
  VALET_BROWSER_ENABLED="${VALET_BROWSER_ENABLED:-0}" VALET_BROWSER_CONFINE="${VALET_BROWSER_CONFINE:-0}" \
  VALET_SESSION_ID="${VALET_SESSION_ID:-}" VALET_BROWSER_STATE=/var/lib/valet/browser \
  VALET_BROWSER_DEV_PORTS="${VALET_BROWSER_DEV_PORTS:-}" \
  /usr/local/bin/node /opt/valet/browser/dist/client.js "$@"
