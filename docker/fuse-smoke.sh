#!/usr/bin/env bash
set -euo pipefail

fail() { printf 'Error: %s\n' "$1" >&2; exit 20; }

[ "${1:-}" = "" ] || [ "$1" = "--check-only" ] \
  || fail "Unknown option: $1. Use --check-only or no option."
[ "$(dpkg-query -W -f='${Version}' fuse3 2>/dev/null)" = "3.14.0-4" ] \
  || fail "The fuse3 package is not 3.14.0-4. Rebuild the sandbox image."
[ "$(dpkg-query -W -f='${Version}' fuse-overlayfs 2>/dev/null)" = "1.10-1" ] \
  || fail "The fuse-overlayfs package is not 1.10-1. Rebuild the sandbox image."
[ -x /usr/bin/fuse-overlayfs ] \
  || fail "The fuse-overlayfs tool is missing. Rebuild the sandbox image."
[ "$(stat -c '%a:%U:%G' /usr/bin/fusermount3 2>/dev/null)" = "755:root:root" ] \
  || fail "The fusermount3 mode is not 0755 root:root. Rebuild the sandbox image."

if [ ! -e /dev/fuse ]; then
  printf 'SKIP: FUSE mount smoke (/dev/fuse is unavailable)\n'
  exit 0
fi
[ -c /dev/fuse ] && [ "$(stat -c '%t:%T' /dev/fuse)" = "a:e5" ] \
  || fail "/dev/fuse is not character device 10:229. Correct the RuntimeClass, then recreate the sandbox."
[ "$(stat -c '%a' /dev/fuse)" = "666" ] \
  || fail "/dev/fuse mode is not 0666. Correct the RuntimeClass, then recreate the sandbox."
[ "${1:-}" = "--check-only" ] && exit 0

root=$(mktemp -d)
cleanup() { rm -rf "$root"; }
trap cleanup EXIT
chown dockerd:dockerd "$root"

set +e
timeout 30 su -s /bin/bash dockerd -c "FUSE_SMOKE_ROOT='$root' unshare --user --map-root-user --mount /bin/bash -s" <<'INNER'
set -euo pipefail
mount --make-rprivate /
mkdir -p "$FUSE_SMOKE_ROOT"/{lower,upper,work,mount}
printf 'fuse-ok\n' > "$FUSE_SMOKE_ROOT/lower/probe"
fuse-overlayfs \
  -o "lowerdir=$FUSE_SMOKE_ROOT/lower,upperdir=$FUSE_SMOKE_ROOT/upper,workdir=$FUSE_SMOKE_ROOT/work" \
  "$FUSE_SMOKE_ROOT/mount" >"$FUSE_SMOKE_ROOT/fuse.log" 2>&1 &
fuse_pid=$!
cleanup_mount() {
  mountpoint -q "$FUSE_SMOKE_ROOT/mount" && umount -l "$FUSE_SMOKE_ROOT/mount" || true
  kill "$fuse_pid" 2>/dev/null || true
  wait "$fuse_pid" 2>/dev/null || true
}
trap cleanup_mount EXIT
for _ in $(seq 1 50); do
  mountpoint -q "$FUSE_SMOKE_ROOT/mount" && break
  kill -0 "$fuse_pid" 2>/dev/null || break
  sleep 0.1
done
if ! mountpoint -q "$FUSE_SMOKE_ROOT/mount"; then
  cat "$FUSE_SMOKE_ROOT/fuse.log" >&2
  exit 1
fi
[ "$(cat "$FUSE_SMOKE_ROOT/mount/probe")" = "fuse-ok" ]
printf 'write-ok\n' > "$FUSE_SMOKE_ROOT/mount/written"
[ "$(cat "$FUSE_SMOKE_ROOT/upper/written")" = "write-ok" ]
umount "$FUSE_SMOKE_ROOT/mount"
wait "$fuse_pid"
trap - EXIT
INNER
smoke_status=$?
set -e
case "$smoke_status" in
  0) ;;
  124) fail "The nested user-namespace FUSE mount timed out after 30 seconds. Check the device and kernel, then retry." ;;
  *) fail "The nested user-namespace FUSE mount failed. Check the RuntimeClass device grant, then recreate the sandbox." ;;
esac

printf 'PASS: FUSE mount smoke (nested user namespace)\n'
