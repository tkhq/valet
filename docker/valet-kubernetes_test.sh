#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
HELPER=$ROOT/valet-kubernetes.mjs
STATE=/home/dockerd/.local/state/valet/kubernetes
LOCK=${STATE}.lock
SCOPE=/sys/fs/cgroup/init/valet-kubernetes
TMP=$(mktemp -d)
fail() { echo "FAIL: $*" >&2; exit 1; }
cleanup() { [ -z "${owner:-}" ] || kill -KILL "$owner" 2>/dev/null || true; [ -z "${holder:-}" ] || kill -KILL "$holder" 2>/dev/null || true; rm -rf "$STATE" "$TMP"; rmdir "$SCOPE" 2>/dev/null || true; rm -f "$LOCK".*.ready; }
trap cleanup EXIT
cleanup

# Both no-op and real stop print stopped state but return success.
out=$(VALET_SANDBOX_EPOCH=test node "$HELPER" stop) || fail "no-op stop failed"
node -e 'const x=JSON.parse(process.argv[1]); if(x.state!=="stopped"||x.schema!==1) process.exit(1)' "$out"
# The production cleanup removes fake cgroup directories bottom-up with rmdir.
FAKE_SCOPE=$TMP/valet-kubernetes
mkdir -p "$FAKE_SCOPE/child"
node --input-type=module -e "import { removeOwnedCgroupDirectories } from '$HELPER'; if (!removeOwnedCgroupDirectories('$FAKE_SCOPE')) process.exit(1)"
[ ! -e "$FAKE_SCOPE" ] || fail "fake cgroup cleanup retained a directory"
mkdir "$FAKE_SCOPE" || fail "the next start cannot recreate its cgroup"
rmdir "$FAKE_SCOPE"

# Exercise production identity, topology, launcher, and startup paths with fake kernel files.
cat > "$TMP/kernel-test.mjs" <<'NODE'
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const helper = await import(process.argv[2]);
const tmp = process.argv[3];
const proc = join(tmp, "proc");
const pid = 4242;
mkdirSync(join(proc, String(pid)), { recursive: true });
mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
writeFileSync(join(proc, String(pid), "stat"), `${pid} (k3s) S ${Array(18).fill("0").join(" ")} 123 0\n`);
writeFileSync(join(proc, String(pid), "status"), "Name:\tk3s\nState:\tS\nUid:\t1500\t1500\t1500\t1500\n");
writeFileSync(join(proc, "sys/kernel/random/boot_id"), "boot-test\n");
writeFileSync(join(proc, String(pid), "cmdline"), Buffer.from(`${helper.K3S_ARGV.join("\0")}\0`));
const record = {
  pid, startTime: "123", bootId: "boot-test", uid: 1500, epoch: "test",
  cgroup: helper.SCOPE,
  argvDigest: createHash("sha256").update(JSON.stringify(helper.K3S_ARGV)).digest("hex"),
};
writeFileSync(join(proc, String(pid), "cgroup"), "0::/init/valet-kubernetes/leaf/k3s_evac\n");
if (!helper.identityValid(record, proc)) throw new Error("evacuated leader identity was rejected");
writeFileSync(join(proc, String(pid), "cgroup"), "0::/init/valet-kubernetes-foreign/leaf\n");
if (helper.identityValid(record, proc)) throw new Error("foreign sibling identity was accepted");

const scope = join(tmp, "scope");
const leaf = helper.createScope(scope);
if (readFileSync(join(scope, "cgroup.subtree_control"), "utf8") !== "+cpuset +cpu +memory +pids\n") throw new Error("scope controllers were not enabled");
if (existsSync(join(scope, "cgroup.procs"))) throw new Error("fake Scope manager was populated");
const marker = join(tmp, "launched");
const launched = spawnSync("/bin/sh", ["-c", helper.launcherScript(leaf), "launcher", "/bin/sh", "-c", `printf ready > ${marker}`]);
if (launched.status !== 0 || readFileSync(marker, "utf8") !== "ready") throw new Error("launcher did not exec from leaf");
if (!/^\d+\n$/.test(readFileSync(join(leaf, "cgroup.procs"), "utf8"))) throw new Error("launcher PID was not written to leaf");
if (helper.startupKernel({ leader: "exited", deadlineExpired: false }) !== "server_exited") throw new Error("leader exit did not fail fast");
if (helper.startupKernel({ leader: "owned", deadlineExpired: true }) !== "startup_timeout") throw new Error("live deadline did not time out");
if (helper.startupKernel({ leader: "foreign", deadlineExpired: false }) !== "ownership_failure") throw new Error("foreign leader was not rejected");
NODE
VALET_SANDBOX_EPOCH=test node "$TMP/kernel-test.mjs" "$HELPER" "$TMP"

# Exercise the real cgroupfs stop path when the runner delegates a writable scope.
if mkdir "$SCOPE" 2>/dev/null; then
  mkdir -p "$STATE"
  printf '%s\n' '{"state":"ready","error":null,"epoch":"test"}' > "$STATE/state.json"
  chmod 700 "$STATE"; chmod 600 "$STATE/state.json"
  out=$(VALET_SANDBOX_EPOCH=test node "$HELPER" stop) || fail "real stop failed"
  node -e 'const x=JSON.parse(process.argv[1]); if(x.state!=="stopped"||x.schema!==1) process.exit(1)' "$out"
  [ ! -e "$SCOPE" ] || fail "stop retained the empty cgroup"
fi

# Killing the lock owner cannot leave the flock holder behind.
node --input-type=module -e "import { withLock } from '$HELPER'; withLock(false, () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000));" & owner=$!
for _ in $(seq 1 100); do compgen -G "$LOCK.$owner.*.ready" >/dev/null && break; sleep 0.02; done
compgen -G "$LOCK.$owner.*.ready" >/dev/null || fail "lock owner did not acquire"
holder=$(pgrep -P "$owner" | head -1) || fail "lock holder was not found"
kill -KILL "$owner"; wait "$owner" 2>/dev/null || true
start=$(date +%s)
set +e; VALET_SANDBOX_EPOCH=test node "$HELPER" status >/dev/null; status=$?; set -e
[ "$status" -eq 3 ] || fail "status could not acquire after owner death: $status"
[ $(( $(date +%s) - start )) -lt 5 ] || fail "orphan holder delayed the next lock"
for _ in $(seq 1 100); do compgen -G "$LOCK.$owner.*.ready" >/dev/null || break; sleep 0.02; done
compgen -G "$LOCK.$owner.*.ready" >/dev/null && fail "orphan lock holder remained"
if [ -r "/proc/$holder/stat" ]; then
  state=$(sed 's/^.*) //' "/proc/$holder/stat" | cut -d ' ' -f 1)
  [ "$state" = Z ] || fail "live orphan holder process remained: $state"
fi

echo "valet-kubernetes command tests passed"
