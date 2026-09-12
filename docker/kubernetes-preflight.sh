#!/usr/bin/env bash
set -euo pipefail
[ "${VALET_SANDBOX_KUBERNETES:-}" = 1 ] || exit 0
fail() { printf 'Error: %s\n' "$1" >&2; exit 20; }
[ -n "${VALET_SANDBOX_EPOCH:-}" ] || fail "The sandbox epoch is missing. Recreate the sandbox through Valet."
VALET_DOCKER_USERNS=1 /userns-preflight.sh || fail "The outer ID map is incomplete. Set userNamespaces.idsPerPod to 131072, then recreate the sandbox."
[ -c /dev/net/tun ] && [ "$(stat -c '%t:%T' /dev/net/tun)" = "a:c8" ] || fail "TUN 10:200 is missing. Correct the RuntimeClass, then recreate the sandbox."
[ -c /dev/kmsg ] && [ "$(stat -c '%t:%T' /dev/kmsg)" = "1:3" ] || fail "The null kmsg device is missing. Correct the RuntimeClass, then recreate the sandbox."
for tool in /usr/local/bin/k3s /usr/local/bin/kubectl /usr/bin/slirp4netns /usr/bin/tini /usr/bin/flock; do
  [ -x "$tool" ] || fail "$tool is missing. Rebuild the sandbox image from the normative lock."
done
[ "$(dpkg-query -W -f='${Version}' slirp4netns 2>/dev/null)" = "1.2.0-1" ] || fail "The slirp4netns package is not 1.2.0-1. Rebuild the sandbox image."
if touch /sys/.valet-kubernetes-write-test 2>/dev/null; then
  rm -f /sys/.valet-kubernetes-write-test
  fail "The broad /sys mount is writable. Correct the RuntimeClass, then recreate the sandbox."
fi
/cgroup-delegation.sh /sys/fs/cgroup dockerd "cpu cpuset memory pids"
