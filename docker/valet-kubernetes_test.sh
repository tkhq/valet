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
mkdir -m 700 "$TMP"

# Both no-op and real stop print stopped state but return success.
out=$(VALET_SANDBOX_EPOCH=test node "$HELPER" stop) || fail "no-op stop failed"
node -e 'const x=JSON.parse(process.argv[1]); if(x.state!=="stopped"||x.schema!==1) process.exit(1)' "$out"

# A real subordinate-owned directory requires the RootlessKit removal retry.
if command -v rootlesskit >/dev/null 2>&1 \
  && grep -qx 'dockerd:65536:65535' /etc/subuid 2>/dev/null \
  && grep -qx 'dockerd:65536:65535' /etc/subgid 2>/dev/null; then
  mkdir -p "$STATE/data"
  mkdir -m 700 "$TMP/rootlesskit-create-runtime"
  XDG_RUNTIME_DIR="$TMP/rootlesskit-create-runtime" rootlesskit \
    --state-dir="$TMP/rootlesskit-create-state" \
    /bin/sh -c 'mkdir -p "$1/x"; touch "$1/x/f"; chown 65534:65534 "$1/x/f"; chmod 700 "$1/x"; chown 65534:65534 "$1/x"' \
    create-subordinate-tree "$STATE/data"
  subordinate_owner=$(stat -c '%u:%g' "$STATE/data/x")
  [ "$subordinate_owner" != "1500:1500" ] || fail "RootlessKit did not create subordinate-owned state"
  set +e
  node --input-type=module -e "import { rmSync } from 'node:fs'; try { rmSync('$STATE', { recursive: true, force: true }); process.exit(10); } catch (error) { if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error; }"
  direct_status=$?
  set -e
  [ "$direct_status" -eq 0 ] || fail "direct state removal did not fail with EACCES or EPERM: $direct_status"
  VALET_SANDBOX_EPOCH=test node --input-type=module -e "import { removeStateRoot, ROOT } from '$HELPER'; removeStateRoot(ROOT)"
  [ ! -e "$STATE" ] || fail "RootlessKit retry retained subordinate-owned state"
else
  echo "SKIP: RootlessKit subordinate-owned state removal (rootlesskit or subids unavailable)"
fi

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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
if (helper.leaderState(record, proc) !== "owned") throw new Error("healthy leader was not classified as owned");
if (helper.startRecoveryKernel(record, proc) !== "reuse-owned") throw new Error("start recovery did not reuse a healthy leader");
if (helper.stopGuardKernel(record, proc) !== "allow-cleanup") throw new Error("stop refused a healthy owned leader");
if (helper.epochRecoveryKernel(record, proc) !== "refuse-live") throw new Error("epoch recovery deleted a live owned leader");
// Live PID 992 exposed this exact title prefix: one space-form segment, then zero-fill.
const rewritten = Buffer.concat([Buffer.from("/usr/local/bin/k3s server"), Buffer.alloc(280)]);
if (rewritten.indexOf(0) !== 25 || !rewritten.subarray(25).every((byte) => byte === 0)) throw new Error("observed cmdline bytes drifted");
writeFileSync(join(proc, String(pid), "cmdline"), rewritten);
if (!helper.cmdlineIdentityKernel(rewritten, helper.K3S_ARGV)) throw new Error("rewritten k3s title was rejected");
if (!helper.identityValid(record, proc)) throw new Error("rewritten leader identity was rejected");
if (helper.stopGuardKernel(record, proc) !== "allow-cleanup") throw new Error("stop refused a rewritten live leader");
const rewrittenScope = join(tmp, "rewritten-stop-scope");
mkdirSync(join(rewrittenScope, "child"), { recursive: true });
if (!helper.removeOwnedCgroupDirectories(rewrittenScope) || existsSync(rewrittenScope)) throw new Error("rewritten leader stop recovery did not clean its scope");
const statePath = join(tmp, "rewritten-state.json");
const pidPath = join(tmp, "rewritten-pid.json");
writeFileSync(statePath, JSON.stringify({ state: "ready", error: null, epoch: "test" }));
writeFileSync(pidPath, JSON.stringify(record));
const snapshot = helper.stateSnapshot(proc, { status: statePath, pid: pidPath });
const ready = helper.statusKernel({ persisted: snapshot.stored.state, identity: snapshot.identity, readiness: "ready", errorReason: snapshot.stored.error });
if (ready.exit !== 0 || JSON.parse(ready.stdout).state !== "ready") throw new Error("rewritten leader status was not ready");
for (const cmdline of [Buffer.from("/usr/local/bin/k3s\0"), Buffer.from("/usr/local/bin/k3s server")]) {
  if (!helper.cmdlineIdentityKernel(cmdline, helper.K3S_ARGV)) throw new Error(`valid cmdline was rejected: ${cmdline.toString()}`);
}
for (const cmdline of [
  Buffer.alloc(0), Buffer.alloc(4), Buffer.from("/usr/local/bin/k3s-evil server\0"),
  Buffer.from("/usr/local/bin/k3s2 server\0"), Buffer.from("/usr/bin/k3s server\0"),
  Buffer.from(" /usr/local/bin/k3s server\0"), Buffer.from("\0/usr/local/bin/k3s server"),
  Buffer.from("k3s server\0"), Buffer.from("/usr/bin/sleep 100"),
]) {
  if (helper.cmdlineIdentityKernel(cmdline, helper.K3S_ARGV)) throw new Error(`invalid cmdline was accepted: ${cmdline.toString()}`);
}
writeFileSync(join(proc, String(pid), "cgroup"), "0::/init/valet-kubernetes-foreign/leaf\n");
if (helper.identityValid(record, proc)) throw new Error("foreign sibling identity was accepted");
if (helper.leaderState(record, proc) !== "foreign") throw new Error("live foreign leader was not classified as foreign");
if (helper.startRecoveryKernel(record, proc) !== "refuse-foreign") throw new Error("start recovery accepted a live foreign leader");
if (helper.stopGuardKernel(record, proc) !== "refuse-foreign") throw new Error("stop accepted a live foreign leader");
if (helper.epochRecoveryKernel(record, proc) !== "refuse-live") throw new Error("epoch recovery deleted a live foreign leader");
writeFileSync(join(proc, String(pid), "stat"), `${pid} (k3s) Z ${Array(18).fill("0").join(" ")} 123 0\n`);
writeFileSync(join(proc, String(pid), "status"), "Name:\tk3s\nState:\tZ\nUid:\t1500\t1500\t1500\t1500\n");
writeFileSync(join(proc, String(pid), "cmdline"), "");
if (helper.leaderState(record, proc) !== "exited") throw new Error("zombie leader was not classified as exited");
if (helper.startRecoveryKernel(record, proc) !== "clean-restart") throw new Error("start recovery refused a zombie leader");
if (helper.stopGuardKernel(record, proc) !== "allow-cleanup") throw new Error("stop refused a zombie leader");
if (helper.epochRecoveryKernel(record, proc) !== "clean-root") throw new Error("epoch recovery refused a zombie leader");
if (helper.leaderState(record, join(tmp, "missing-proc")) !== "exited") throw new Error("missing process data was not classified as exited");
writeFileSync(join(proc, String(pid), "stat"), `${pid} (k3s) S ${Array(18).fill("0").join(" ")} 123 0\n`);
writeFileSync(join(proc, String(pid), "status"), "Name:\tk3s\nState:\tS\nUid:\t1500\t1500\t1500\t1500\n");
const transition = () => {
  writeFileSync(join(proc, String(pid), "stat"), `${pid} (k3s) Z ${Array(18).fill("0").join(" ")} 123 0\n`);
  writeFileSync(join(proc, String(pid), "status"), "Name:\tk3s\nState:\tZ\nUid:\t1500\t1500\t1500\t1500\n");
  return false;
};
if (helper.leaderState(record, proc, transition) !== "exited") throw new Error("leader exit during identity validation was classified as foreign");

const events = [];
let settled = helper.settleStartupFailure("ownership_failure", {}, () => { events.push("cleanup"); return true; }, (_op, error) => { events.push(`commit:${error}`); return true; });
if (!settled.committed || settled.cleaned !== null || events.join(",") !== "commit:ownership_failure") throw new Error("ownership failure signaled or did not persist");
events.length = 0;
settled = helper.settleStartupFailure("server_exited", {}, () => { events.push("cleanup"); return true; }, (_op, error) => { events.push(`commit:${error}`); return true; });
if (!settled.committed || !settled.cleaned || events.join(",") !== "cleanup,commit:server_exited") throw new Error("server exit did not clean and persist");

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
if (helper.LEAF_CONTROLLERS.join(" ") !== "cpuset cpu memory pids") throw new Error("required leaf controllers drifted");

const pollProc = join(tmp, "poll-proc");
const pollLeaf = join(tmp, "poll-leaf");
mkdirSync(join(pollProc, String(pid)), { recursive: true });
const pollRecord = { pid };
const pollOp = { id: "poll", deadline: 1000, owner: {} };
let pollCalls = 0; let readinessCalls = 0;
const pollConverge = (leafPath, evacPath, controllers, options) => {
  pollCalls += 1;
  if (evacPath !== join(leafPath, "k3s_evac") || controllers.join(" ") !== "cpuset cpu memory pids" || options.protectedPid !== pid) throw new Error("startup convergence arguments drifted");
  return true;
};
const pollIo = {
  readOperation: () => ({ ...pollOp, cancelRequested: false }),
  ownerValid: () => true,
  readRecord: () => pollRecord,
  leaderState: () => "owned",
  now: () => 0,
  readiness: () => { readinessCalls += 1; return false; },
  convergeStartupLeaf: (input) => helper.convergeStartupLeaf({ ...input, leaf: pollLeaf, converge: pollConverge }),
};
writeFileSync(join(pollProc, String(pid), "cgroup"), "0::/init/valet-kubernetes/leaf\n");
let poll = helper.startupPollIteration({ op: pollOp, launchExited: false, leafControllersConverged: false, procRoot: pollProc }, pollIo);
if (poll.action !== "continue" || poll.delayMs !== 10 || poll.leafControllersConverged || pollCalls !== 0 || readinessCalls !== 0) throw new Error("startup poll did not wait for RootlessKit evacuation");
writeFileSync(join(pollProc, String(pid), "cgroup"), "0::/init/valet-kubernetes/leaf/k3s_evac\n");
poll = helper.startupPollIteration({ op: pollOp, launchExited: false, leafControllersConverged: false, procRoot: pollProc }, pollIo);
if (poll.action !== "continue" || !poll.leafControllersConverged || pollCalls !== 1 || readinessCalls !== 1) throw new Error("startup poll did not converge after RootlessKit evacuation");

const required = helper.LEAF_CONTROLLERS;
function fakeCgroup(name, leafPids, evacPids = [], injectRace = false, dying = new Set()) {
  const fakeLeaf = join(tmp, name, "leaf");
  const fakeEvac = join(fakeLeaf, "k3s_evac");
  mkdirSync(fakeLeaf, { recursive: true });
  writeFileSync(join(fakeLeaf, "cgroup.procs"), leafPids.map(String).join("\n") + (leafPids.length ? "\n" : ""));
  writeFileSync(join(fakeLeaf, "cgroup.subtree_control"), "cpu\n");
  if (evacPids.length) {
    mkdirSync(fakeEvac);
    writeFileSync(join(fakeEvac, "cgroup.procs"), evacPids.map(String).join("\n") + "\n");
  }
  const writes = []; let enableCalls = 0;
  const io = {
    read: (path) => readFileSync(path, "utf8"),
    exists: existsSync,
    mkdir: (path) => { writes.push(path); mkdirSync(path); writeFileSync(join(path, "cgroup.procs"), ""); },
    movePid: (source, target, movedPid) => {
      writes.push(target);
      const left = readFileSync(source, "utf8").trim().split(/\s+/).filter((value) => value && value !== movedPid);
      writeFileSync(source, left.join("\n") + (left.length ? "\n" : ""));
      if (dying.has(movedPid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      appendFileSync(target, `${movedPid}\n`);
    },
    enable: (path, controllers) => {
      writes.push(path); enableCalls += 1;
      if (injectRace && enableCalls === 1) appendFileSync(join(fakeLeaf, "cgroup.procs"), "1159\n");
      if (readFileSync(join(fakeLeaf, "cgroup.procs"), "utf8").trim()) {
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      }
      writeFileSync(path, `${controllers.join(" ")}\n`);
    },
    sleep: (ms) => { if (ms !== 100) throw new Error("invalid convergence retry delay"); },
  };
  return { fakeLeaf, fakeEvac, io, writes, enableCalls: () => enableCalls };
}

const missingEvac = fakeCgroup("missing-evac", [1144]);
if (!helper.convergeLeaf(missingEvac.fakeLeaf, missingEvac.fakeEvac, required, missingEvac.io)) throw new Error("missing evacuation cgroup did not converge");
if (readFileSync(join(missingEvac.fakeLeaf, "cgroup.procs"), "utf8") !== "") throw new Error("leaf straggler was retained");
if (readFileSync(join(missingEvac.fakeEvac, "cgroup.procs"), "utf8") !== "1144\n") throw new Error("leaf straggler was not evacuated");
if (!required.every((controller) => readFileSync(join(missingEvac.fakeLeaf, "cgroup.subtree_control"), "utf8").split(/\s+/).includes(controller))) throw new Error("leaf controllers did not converge");

const raced = fakeCgroup("existing-evac", [1144], [1015], true);
if (!helper.convergeLeaf(raced.fakeLeaf, raced.fakeEvac, required, raced.io)) throw new Error("concurrent straggler did not converge");
if (raced.enableCalls() !== 2) throw new Error("convergence retry path was not exercised");
const residents = readFileSync(join(raced.fakeEvac, "cgroup.procs"), "utf8").trim().split(/\s+/);
if (residents.join(" ") !== "1015 1144 1159") throw new Error("existing evacuation residents changed");

const protectedLeader = fakeCgroup("protected-leader", [1015, 1144], [1015]);
protectedLeader.io.protectedPid = 1015;
if (helper.convergeLeaf(protectedLeader.fakeLeaf, protectedLeader.fakeEvac, required, protectedLeader.io)) throw new Error("protected leader did not block controller enablement");
if (protectedLeader.enableCalls() !== 0) throw new Error("controller enablement ran with internal processes");
if (readFileSync(join(protectedLeader.fakeEvac, "cgroup.procs"), "utf8").trim().split(/\s+/).join(" ") !== "1015 1144") throw new Error("convergence moved the protected leader");

const dying = fakeCgroup("dying-pid", [999], [], false, new Set(["999"]));
if (!helper.convergeLeaf(dying.fakeLeaf, dying.fakeEvac, required, dying.io)) throw new Error("ESRCH race was not tolerated");
for (const path of [...missingEvac.writes, ...raced.writes, ...protectedLeader.writes, ...dying.writes]) {
  const owner = path.includes("missing-evac") ? missingEvac.fakeLeaf : path.includes("existing-evac") ? raced.fakeLeaf : path.includes("protected-leader") ? protectedLeader.fakeLeaf : dying.fakeLeaf;
  if (path !== join(owner, "cgroup.subtree_control") && path !== join(owner, "k3s_evac") && path !== join(owner, "k3s_evac", "cgroup.procs")) throw new Error(`convergence escaped leaf: ${path}`);
}
if (helper.convergeLeaf(raced.fakeLeaf, join(tmp, "foreign", "k3s_evac"), required, raced.io)) throw new Error("foreign evacuation path was accepted");
writeFileSync(join(proc, String(pid), "stat"), `${pid} (k3s) S ${Array(18).fill("0").join(" ")} 123 0\n`);
writeFileSync(join(proc, String(pid), "status"), "Name:\tk3s\nState:\tS\nUid:\t1500\t1500\t1500\t1500\n");
writeFileSync(join(proc, String(pid), "cmdline"), rewritten);
writeFileSync(join(proc, String(pid), "cgroup"), "0::/init/valet-kubernetes/leaf/k3s_evac\n");
NODE
VALET_SANDBOX_EPOCH=test node "$TMP/kernel-test.mjs" "$HELPER" "$TMP"

# A live rewritten-title leader passes the production stop guard and reaches cleanup.
mkdir -p "$STATE"
printf '%s\n' '{"state":"error","error":"ownership_failure","epoch":"test"}' > "$STATE/state.json"
cp "$TMP/rewritten-pid.json" "$STATE/server.pid.json"
chmod 700 "$STATE"; chmod 600 "$STATE/state.json" "$STATE/server.pid.json"
out=$(VALET_SANDBOX_EPOCH=test node --input-type=module -e "const helper=await import('$HELPER'); let cleaned=false; const code=helper.stop('$TMP/proc', () => { cleaned=true; return true; }); if (!cleaned) throw new Error('stop did not run cleanup'); process.exitCode=code") || fail "rewritten-title stop failed"
node -e 'const x=JSON.parse(process.argv[1]); if(x.state!=="stopped"||x.schema!==1) process.exit(1)' "$out"
[ ! -e "$STATE" ] || fail "rewritten-title stop retained state"

# A double state-removal failure persists its reason and emits no success JSON.
mkdir -p "$STATE"
printf '%s\n' '{"state":"ready","error":null,"epoch":"test"}' > "$STATE/state.json"
chmod 700 "$STATE"; chmod 600 "$STATE/state.json"
set +e
VALET_SANDBOX_EPOCH=test node --input-type=module -e "const helper=await import('$HELPER'); const failed=()=>{ throw Object.assign(new Error('Kubernetes state removal failed (state_removal_failed). Recreate the sandbox, then retry.'), { code: 'state_removal_failed', exitCode: 22 }); }; process.exitCode=helper.stop('/proc', () => true, failed)" >"$TMP/removal-failure.out" 2>"$TMP/removal-failure.err"
removal_status=$?
set -e
[ "$removal_status" -eq 22 ] || fail "double state removal failure exited $removal_status"
[ ! -s "$TMP/removal-failure.out" ] || fail "double state removal failure emitted success JSON"
grep -q 'state_removal_failed' "$TMP/removal-failure.err" || fail "double state removal failure omitted its token"
node -e 'const x=require(process.argv[1]); if(x.state!=="error"||x.error!=="state_removal_failed"||x.epoch!==null) process.exit(1)' "$STATE/state.json"
rm -rf "$STATE"

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
