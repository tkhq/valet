#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
SOURCE=$ROOT/fuse-smoke.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
mkdir -p "$TMP/bin" "$TMP/dev" "$TMP/image/usr/bin" "$TMP/tree"
: > "$TMP/image/usr/bin/fuse-overlayfs"
: > "$TMP/image/usr/bin/fusermount3"
chmod 0755 "$TMP/image/usr/bin/fuse-overlayfs" "$TMP/image/usr/bin/fusermount3"

cat > "$TMP/bin/dpkg-query" <<'SH'
#!/bin/sh
for arg do last=$arg; done
case "$last" in fuse3) echo 3.14.0-4;; fuse-overlayfs) echo 1.10-1;; *) exit 1;; esac
SH
cat > "$TMP/bin/stat" <<'SH'
#!/bin/sh
case "$2:$3" in
  %a:%U:%G:*fusermount3) echo 755:root:root ;;
  %t:%T:*fuse) echo a:e5 ;;
  %a:*fuse) echo 666 ;;
  *) exit 1 ;;
esac
SH
cat > "$TMP/bin/chown" <<'SH'
#!/bin/sh
exit 0
SH
cat > "$TMP/bin/timeout" <<'SH'
#!/bin/sh
[ "$1" = 30 ] || exit 2
printf 'timeout\n' >> "$FUSE_TEST_LOG"
[ "${FUSE_TEST_TIMEOUT:-0}" = 0 ] || exit 124
shift
exec "$@"
SH
cat > "$TMP/bin/su" <<'SH'
#!/bin/bash
inner=$FUSE_TEST_TREE/inner.sh
cat > "$inner"
line() { grep -nF "$1" "$inner" | tail -1 | cut -d: -f1; }
mount_line=$(line 'fuse-overlayfs \')
read_line=$(line 'cat "$FUSE_SMOKE_ROOT/mount/probe"')
write_line=$(line "printf 'write-ok\\n' > \"\$FUSE_SMOKE_ROOT/mount/written\"")
upper_line=$(line 'cat "$FUSE_SMOKE_ROOT/upper/written"')
unmount_line=$(grep -n '^umount "$FUSE_SMOKE_ROOT/mount"$' "$inner" | cut -d: -f1)
wait_line=$(grep -n '^wait "$fuse_pid"$' "$inner" | tail -1 | cut -d: -f1)
[ "$mount_line" -lt "$read_line" ] && [ "$read_line" -lt "$write_line" ] \
  && [ "$write_line" -lt "$upper_line" ] && [ "$upper_line" -lt "$unmount_line" ] \
  && [ "$unmount_line" -lt "$wait_line" ] || exit 3
mkdir -p "$FUSE_TEST_TREE"/{lower,upper,mount}
printf 'fuse-ok\n' > "$FUSE_TEST_TREE/lower/probe"
cp "$FUSE_TEST_TREE/lower/probe" "$FUSE_TEST_TREE/mount/probe"
printf 'mount\n' >> "$FUSE_TEST_LOG"
[ "$(cat "$FUSE_TEST_TREE/mount/probe")" = fuse-ok ]
printf 'read\n' >> "$FUSE_TEST_LOG"
printf 'write-ok\n' > "$FUSE_TEST_TREE/mount/written"
cp "$FUSE_TEST_TREE/mount/written" "$FUSE_TEST_TREE/upper/written"
[ "$(cat "$FUSE_TEST_TREE/upper/written")" = write-ok ]
printf 'write\n' >> "$FUSE_TEST_LOG"
rm -f "$FUSE_TEST_TREE/mount"/*
printf 'unmount\nwait\n' >> "$FUSE_TEST_LOG"
SH
chmod 0755 "$TMP/bin"/*

prepare() {
  local target=$1
  cp "$SOURCE" "$target"
  sed -i \
    -e "s|/usr/bin/fuse-overlayfs|$TMP/image/usr/bin/fuse-overlayfs|g" \
    -e "s|/usr/bin/fusermount3|$TMP/image/usr/bin/fusermount3|g" \
    -e "s|/dev/fuse|$TMP/dev/fuse|g" \
    -e "s|\[ -c $TMP/dev/fuse \]|[ -e $TMP/dev/fuse ]|" \
    "$target"
  chmod 0755 "$target"
}
run_present() {
  local script=$1 output=$TMP/output
  : > "$TMP/log"
  rm -rf "$TMP/tree"; mkdir "$TMP/tree"
  : > "$TMP/dev/fuse"
  PATH="$TMP/bin:$PATH" FUSE_TEST_LOG=$TMP/log FUSE_TEST_TREE=$TMP/tree \
    "$script" > "$output" 2>&1 || return 1
  grep -Fq 'PASS: FUSE mount smoke' "$output" || return 1
  [ "$(cat "$TMP/log")" = $'timeout\nmount\nread\nwrite\nunmount\nwait' ]
}
reject_mutation() {
  if run_present "$1"; then fail "$2 mutation passed"; fi
}

prepare "$TMP/smoke"
rm -f "$TMP/dev/fuse"
PATH="$TMP/bin:$PATH" FUSE_TEST_LOG=$TMP/log FUSE_TEST_TREE=$TMP/tree \
  "$TMP/smoke" > "$TMP/skip.out"
grep -Fq 'SKIP: FUSE mount smoke' "$TMP/skip.out" || fail 'absent device did not skip'
run_present "$TMP/smoke" || fail 'mocked mount path failed'
: > "$TMP/log"
PATH="$TMP/bin:$PATH" FUSE_TEST_LOG=$TMP/log FUSE_TEST_TREE=$TMP/tree \
  "$TMP/smoke" --check-only
[ ! -s "$TMP/log" ] || fail 'check-only mode mounted FUSE'
set +e
PATH="$TMP/bin:$PATH" FUSE_TEST_LOG=$TMP/log FUSE_TEST_TREE=$TMP/tree FUSE_TEST_TIMEOUT=1 \
  "$TMP/smoke" > "$TMP/timeout.out" 2>&1
timeout_status=$?
set -e
[ "$timeout_status" -eq 20 ] || fail "timeout returned $timeout_status"
grep -Fq 'timed out after 30 seconds' "$TMP/timeout.out" || fail 'timeout message is not distinct'

cp "$TMP/smoke" "$TMP/no-unmount"
sed -i '/^umount "$FUSE_SMOKE_ROOT\/mount"$/d' "$TMP/no-unmount"
reject_mutation "$TMP/no-unmount" 'removed unmount'
cp "$TMP/smoke" "$TMP/bad-device"
sed -i 's/"a:e5"/"a:e4"/' "$TMP/bad-device"
reject_mutation "$TMP/bad-device" 'broken device identity'
cp "$TMP/smoke" "$TMP/no-timeout"
sed -i 's/^timeout 30 //' "$TMP/no-timeout"
reject_mutation "$TMP/no-timeout" 'removed timeout'

grep -Fq 'chmod 0755 /usr/bin/fusermount3' "$ROOT/Dockerfile.sandbox-k8s" \
  || fail 'Dockerfile does not remove the fusermount3 setuid bit'
grep -Fq '/usr/local/bin/fuse-smoke --check-only' "$ROOT/kubernetes-preflight.sh" \
  || fail 'Kubernetes preflight runs the mount smoke'
grep -Fq 'if /usr/local/bin/fuse-smoke >>"$LOG" 2>&1; then' "$ROOT/start-docker.sh" \
  || fail 'Docker consumer does not gate fuse-overlayfs on the smoke'
grep -Fq 'using vfs storage' "$ROOT/start-docker.sh" \
  || fail 'Docker consumer does not continue after a failed smoke'
grep -Fq 'bash docker/fuse-smoke_test.sh' "$ROOT/../.github/workflows/ci-checks.yml" \
  || fail 'CI does not run the FUSE smoke tests'

echo 'FUSE smoke tests passed'
