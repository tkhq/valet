#!/bin/bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ ${VALET_BROWSER_ENABLED:-0} == 1 ]] || exit 0
rm -f /run/valet-browser-ready
if [[ ${VALET_BROWSER_CONFINE:-0} != 1 ]]; then
  echo 'Browser confinement is not configured. Install the reviewed provider seccomp profile.' >&2
  exit 78
fi
browser_uid=${VALET_BROWSER_UID:-1501}
browser_gid=${VALET_BROWSER_GID:-1501}
if [[ ! $browser_uid =~ ^[1-9][0-9]*$ || ! $browser_gid =~ ^[1-9][0-9]*$ || $browser_uid == 1500 ]]; then
  echo 'Browser identity is invalid. Configure a non-root browser UID and GID.' >&2
  exit 78
fi
for browser_path in /usr/bin/bwrap /usr/bin/flock /usr/local/bin/valet-browser-client /opt/valet/browser/dist/main.js; do
  if [[ ! -f $browser_path ]]; then
    echo "Browser runtime file is missing: $browser_path. Rebuild this sandbox image." >&2
    exit 78
  fi
done
install -d -m 0700 -o "$browser_uid" -g "$browser_gid" /var/lib/valet /var/lib/valet/browser
install -d -m 0755 -o dockerd -g dockerd /home/dockerd /workspace
# The workload owns the working directory. Private browser state uses another UID.
chown -R -h dockerd:dockerd /workspace
browser_extra=()
[[ $(uname -m) != x86_64 ]] || browser_extra=(--symlink usr/lib64 /lib64)
if ! setpriv --reuid "$browser_uid" --regid "$browser_gid" --clear-groups --no-new-privs \
  bwrap --unshare-all --ro-bind /usr /usr --symlink usr/lib /lib "${browser_extra[@]}" \
  --dev /dev --tmpfs /tmp --clearenv --chdir /tmp /usr/local/bin/node -e 'if(process.getuid()===0)process.exit(1)'; then
  echo 'Browser namespaces are unavailable. Install the reviewed seccomp profile and enable unprivileged user namespaces on this node.' >&2
  exit 78
fi
touch /run/valet-browser-ready
