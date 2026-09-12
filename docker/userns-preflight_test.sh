#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=docker/userns-preflight.sh
source "$ROOT/userns-preflight.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
write_map() { printf '%s\n' "$2" > "$TMP/$1"; }
rejects() {
  if validate_outer_maps "$TMP/$1" "$TMP/$2" 2> "$TMP/$1-$2.err"; then
    fail "$1/$2 was accepted"
  fi
}

# Require one zero-based outer container-ID segment with all 131072 IDs.
# This includes RootlessKit's required parent IDs 65536 through 131070.
write_map old '0 0 65536'
write_map boundary '0 100000 131071'
write_map valid '0 100000 131072'
write_map wider '0 42 262144'
write_map split $'0 100000 65536\n65536 165536 65536'
write_map gap $'0 100000 65536\n65537 165537 65536'
write_map shifted '60000 160000 131072'
write_map malformed 'zero 100000 131072'
for map in old boundary split gap shifted malformed; do rejects "$map" "$map"; done
validate_outer_maps "$TMP/valid" "$TMP/valid"
validate_outer_maps "$TMP/wider" "$TMP/wider"
rejects valid old
grep -Fq 'gid map' "$TMP/valid-old.err" || fail 'gid failure was not named'
grep -Fq 'Kubernetes 1.35' "$TMP/old-old.err" \
  && grep -Fq 'userNamespaces.idsPerPod: 131072' "$TMP/old-old.err" \
  || fail 'rollout action missing from failure'

# Run the start script itself with a production parser wrapper. A short map
# must stop before the first cgroup or daemon setup side effect.
cat > "$TMP/preflight" <<EOF
#!/usr/bin/env bash
source "$ROOT/userns-preflight.sh"
validate_outer_maps "$TMP/old" "$TMP/old"
EOF
chmod +x "$TMP/preflight"
printf '#!/usr/bin/env bash\ntouch %q\n' "$TMP/cgroup-hit" > "$TMP/cgroup"
printf '#!/usr/bin/env bash\ntouch %q\n' "$TMP/dockerd-hit" > "$TMP/dockerd"
chmod +x "$TMP/cgroup" "$TMP/dockerd"
sed -e "s|/userns-preflight.sh|$TMP/preflight|" \
  -e "s|/cgroup-delegation.sh|$TMP/cgroup|" \
  -e "s|RUNTIME_DIR=/tmp/valet-docker|RUNTIME_DIR=$TMP/runtime|" \
  "$ROOT/start-docker.sh" > "$TMP/start-docker.sh"
chmod +x "$TMP/start-docker.sh"
if PATH="$TMP:$PATH" VALET_SANDBOX_DOCKER=1 VALET_DOCKER_USERNS=1 bash "$TMP/start-docker.sh" \
  > "$TMP/start.out" 2> "$TMP/start.err"; then
  fail 'start-docker accepted a short outer map'
fi
grep -Fq 'Kubernetes 1.35' "$TMP/start.err" || fail 'start-docker lost the preflight error'
[ ! -e "$TMP/runtime" ] && [ ! -e "$TMP/cgroup-hit" ] && [ ! -e "$TMP/dockerd-hit" ] \
  || fail 'start-docker reached cgroup or daemon setup'

[ "$(grep -Fc 'echo "dockerd:65536:65535" >> /etc/subuid' "$ROOT/Dockerfile.sandbox-k8s")" -eq 1 ] \
  && [ "$(grep -Fc 'echo "dockerd:65536:65535" >> /etc/subgid' "$ROOT/Dockerfile.sandbox-k8s")" -eq 1 ] \
  || fail 'Dockerfile does not declare one exact subordinate ID range'
VALET_DOCKER_USERNS=0 bash "$ROOT/userns-preflight.sh"
echo 'userns preflight tests passed'
