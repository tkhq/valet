#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=docker/userns-preflight.sh
source "$ROOT/userns-preflight.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# The RootlessKit map is inner 0 -> outer 1500 and inner 1..65535 ->
# outer 65536..131070. No low outer identity other than dockerd is used.
outer_id() {
  [ "$1" -eq 0 ] && { echo 1500; return; }
  echo $((65536 + $1 - 1))
}
for id in 0 999 1000 63536 65532 65534 65535; do
  case "$id" in
    0) expected=1500 ;; 999) expected=66534 ;; 1000) expected=66535 ;;
    63536) expected=129071 ;; 65532) expected=131067 ;;
    65534) expected=131069 ;; 65535) expected=131070 ;;
  esac
  actual=$(outer_id "$id")
  [ "$actual" -eq "$expected" ] || fail "nested ID $id maps to $actual, want $expected"
  [ "$id" -eq 0 ] || [ "$actual" -ge 65536 ] \
    || fail "nested ID $id maps to forbidden outer ID $actual"
done

printf '0 0 65536\n' > "$TMP/old"
printf '0 0 131072\n' > "$TMP/new"
if validate_outer_maps "$TMP/old" "$TMP/old" 2> "$TMP/old.err"; then
  fail '65536-ID outer map was accepted'
fi
grep -Fq 'Kubernetes 1.35' "$TMP/old.err" \
  && grep -Fq 'userNamespaces.idsPerPod: 131072' "$TMP/old.err" \
  || fail 'rollout action missing from failure'
validate_outer_maps "$TMP/new" "$TMP/new"
if validate_outer_maps "$TMP/new" "$TMP/old" 2> "$TMP/gid.err"; then
  fail 'short gid map was accepted'
fi
grep -Fq 'gid map' "$TMP/gid.err" || fail 'gid failure was not named'
VALET_DOCKER_USERNS=0 bash "$ROOT/userns-preflight.sh"
echo 'userns preflight tests passed'
