#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOOK=$ROOT/.githooks/commit-msg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

printf '%s\n' "fix: omit changelog" > "$TMP/bad"
if "$HOOK" "$TMP/bad" >"$TMP/bad.out" 2>&1; then
  echo "FAIL: hook accepted a fix without changelog metadata" >&2
  exit 1
fi
grep -F 'Add "Changelog: <user impact>" to the commit body or add "[user-visible]" to the subject.' "$TMP/bad.out" >/dev/null

printf '%s\n\n%s\n' "fix: include changelog" "Changelog: Users see the corrected behavior." > "$TMP/good"
"$HOOK" "$TMP/good"

printf '%s\n' "chore: maintain commit hook" > "$TMP/chore"
"$HOOK" "$TMP/chore"

printf '%s\n' "fixup! fix: include changelog" > "$TMP/fixup"
"$HOOK" "$TMP/fixup"
printf '%s\n' "Merge branch 'dev-v2'" > "$TMP/merge"
"$HOOK" "$TMP/merge"

PATH=/missing "$HOOK" "$TMP/bad" >"$TMP/fail-open.out" 2>&1
grep -F "Warning: Node.js 22 is unavailable. Skipping changelog commit validation." "$TMP/fail-open.out" >/dev/null

echo "changelog commit hook tests passed"
