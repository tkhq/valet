#!/usr/bin/env node
import {
  closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statfsSync, statSync, fstatSync,
  unlinkSync, writeFileSync, chmodSync, rmdirSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

export const ROOT = "/home/dockerd/.local/state/valet/kubernetes";
export const LOCK = `${ROOT}.lock`;
export const SCOPE = "/sys/fs/cgroup/init/valet-kubernetes";
export const KUBECONFIG = `${ROOT}/kubeconfig.yaml`;
export const MINIMUM_FREE_BYTES = 2147483648;
export const K3S_ENV = {
  HOME: "/home/dockerd", USER: "dockerd", PATH: "/usr/local/bin:/usr/bin:/bin",
  XDG_RUNTIME_DIR: `${ROOT}/run`, XDG_CONFIG_HOME: `${ROOT}/config`, K3S_DATA_DIR: `${ROOT}/data`,
  K3S_ROOTLESS_CIDR: "10.41.0.0/16", K3S_ROOTLESS_MTU: "65520", K3S_ROOTLESS_ENABLE_IPV6: "false",
  K3S_ROOTLESS_PORT_DRIVER: "builtin", K3S_ROOTLESS_DISABLE_HOST_LOOPBACK: "true",
};
export const K3S_ARGV = [
  "/usr/local/bin/k3s", "server", "--rootless", "--prefer-bundled-bin", "--snapshotter=native",
  "--data-dir", `${ROOT}/data`, "--write-kubeconfig", KUBECONFIG, "--write-kubeconfig-mode", "600",
  "--disable", "traefik", "--disable", "servicelb", "--disable", "metrics-server",
];
const STATUS_PATH = join(ROOT, "state.json");
const PID_PATH = join(ROOT, "server.pid.json");
const OP_PATH = join(ROOT, "operation.json");
const LOG_PATH = join(ROOT, "server.log");
const EPOCH = process.env.VALET_SANDBOX_EPOCH ?? "";
const USAGE = "Usage: valet-kubernetes {start|status|stop|diagnose} | valet-kubernetes import ARCHIVE...";

export function capabilityKernel(requested, provider) {
  if (!requested) return "ignore";
  return provider === "v1" ? "allow" : "reject:unsupported_provider";
}

export function mapKernel(rows) {
  if (!Array.isArray(rows)) return false;
  const limit = 4294967295;
  const inner = [];
  const outer = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || row.some((v) => !Number.isSafeInteger(v) || v < 0)) return false;
    const [start, mapped, count] = row;
    if (count === 0 || start + count > limit || mapped + count > limit) return false;
    outer.push([mapped, mapped + count]);
    if (start <= 65535 && start + count > 0) inner.push([start, Math.min(start + count, 65536)]);
  }
  outer.sort((a, b) => a[0] - b[0]);
  if (outer.some((r, i) => i > 0 && r[0] < outer[i - 1][1])) return false;
  inner.sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const range of inner) {
    if (range[0] !== end) return false;
    end = range[1];
  }
  return end === 65536;
}

export function lifecycleKernel(input) {
  const { state, command, identity, active, owner, operationId, actualOperationId, cancelRequested } = input;
  if (["commit-start", "commit-import", "commit-stop"].includes(command)) {
    if (operationId !== actualOperationId || owner !== "valid" || cancelRequested) {
      return { action: "abandon-result", exit: 4, next: state };
    }
    return command === "commit-stop"
      ? { action: "commit-stopped", exit: 0, next: "stopped" }
      : { action: "commit-ready", exit: 0, next: "ready" };
  }
  if (command === "recover") {
    if (active === null) return { action: "none", exit: 0, next: state };
    if (owner === "valid") return { action: "wait-owner", exit: 24, next: state };
    if (active === "start") return identity === "valid"
      ? { action: "adopt-start", exit: 0, next: "starting" }
      : { action: "clean-restart", exit: 0, next: "starting" };
    if (active === "stop") return { action: "resume-stop", exit: 0, next: "stopping" };
    if (active === "import") return identity === "valid"
      ? { action: "release-import", exit: 0, next: "ready" }
      : { action: "release-import-error", exit: 0, next: "error" };
  }
  if (identity === "foreign") return { action: "refuse-foreign", exit: 21, next: state };
  if (command === "start") {
    if (state === "stopped" || state === "error") return { action: "claim-start", exit: 0, next: "starting" };
    if (state === "starting" && active === "start") return { action: "join-start", exit: 0, next: "starting" };
    if (state === "stopping") return { action: "report-stopping", exit: 4, next: "stopping" };
    if (state === "ready") return { action: "recheck", exit: 0, next: "ready" };
  }
  if (command === "stop") {
    if (state === "stopped") return { action: "none", exit: 0, next: "stopped" };
    if (active === "start") return { action: "cancel-start", exit: 0, next: "stopping" };
    if (active === "import") return { action: "cancel-import", exit: 0, next: "stopping" };
    return { action: "claim-stop", exit: 0, next: "stopping" };
  }
  if (command === "import") {
    if (state === "ready" && active === null) return { action: "claim-import", exit: 0, next: "ready" };
    if (state === "ready" && active === "import" && owner === "valid") return { action: "wait-owner", exit: 24, next: "ready" };
    return { action: "report-nonready", exit: 4, next: state };
  }
  return { action: "report-nonready", exit: 4, next: state };
}

export function statusKernel({ persisted, identity, readiness, errorReason }) {
  let state = persisted;
  let error = null;
  let exit = persisted === "stopped" ? 3 : 4;
  if (persisted === "ready" && identity !== "valid") { state = "error"; error = "identity_invalid"; }
  else if (persisted === "ready" && readiness === "failed") { state = "error"; error = "readiness_failed"; }
  else if (persisted === "ready") exit = 0;
  else if (persisted === "error") error = errorReason ?? "startup_failed";
  return { exit, persistedAfter: persisted, stdout: `${JSON.stringify({ error, kubeconfig: KUBECONFIG, schema: 1, state })}\n` };
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}
function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); closeSync(fd);
  renameSync(temp, path);
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY); fsyncSync(parent); closeSync(parent);
}
function procIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 2).split(" ");
  return {
    pid, startTime: fields[19], bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    uid: Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1]), epoch: EPOCH,
  };
}
function recordLive(record) {
  try {
    const now = procIdentity(record.pid);
    return now.startTime === record.startTime && now.bootId === record.bootId;
  } catch { return false; }
}
function identityValid(record) {
  try {
    const now = procIdentity(record.pid);
    return now.startTime === record.startTime && now.bootId === record.bootId && now.uid === 1500 &&
      record.uid === 1500 && record.epoch === EPOCH && record.cgroup === SCOPE &&
      record.argvDigest === createHash("sha256").update(JSON.stringify(K3S_ARGV)).digest("hex") &&
      readFileSync(`/proc/${record.pid}/cmdline`).equals(Buffer.from(`${K3S_ARGV.join("\0")}\0`)) &&
      readFileSync(`/proc/${record.pid}/cgroup`, "utf8").split("\n").some((line) => line === "0::/init/valet-kubernetes");
  } catch { return false; }
}
function ownerValid(owner) {
  try { const now = procIdentity(owner.pid); return now.startTime === owner.startTime && now.bootId === owner.bootId && now.uid === 1500 && owner.uid === 1500 && owner.epoch === EPOCH; }
  catch { return false; }
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function assertOwnedFile(path, mode) {
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== 1500 || (value.mode & 0o777) !== mode) {
    throw Object.assign(new Error(`${path} has unsafe ownership, type, or mode. Recreate the sandbox before retrying.`), { exitCode: 21 });
  }
}
export function withLock(shared, fn) {
  mkdirSync(dirname(LOCK), { recursive: true, mode: 0o700 });
  const fd = openSync(LOCK, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const ready = `${LOCK}.${process.pid}.${randomUUID()}.ready`;
  let holder;
  try {
    const lockStat = fstatSync(fd);
    if (lockStat.uid !== 1500) throw Object.assign(new Error("The Kubernetes lock has unsafe ownership. Recreate the sandbox before retrying."), { exitCode: 21 });
    chmodSync(LOCK, 0o600); assertOwnedFile(LOCK, 0o600);
    const parent = procIdentity(process.pid);
    const script = String.raw`set -eu; ready=$1; pid=$2; start=$3; boot=$4; uid=$5; trap 'rm -f "$ready"' EXIT; : > "$ready"; same_parent() { [ -r "/proc/$pid/stat" ] && [ "$(awk '{ print $22 }' "/proc/$pid/stat")" = "$start" ] && [ "$(cat /proc/sys/kernel/random/boot_id)" = "$boot" ] && [ "$(sed -n 's/^Uid:[[:space:]]*\([0-9]*\).*/\1/p' "/proc/$pid/status")" = "$uid" ]; }; while same_parent; do sleep 0.1; done`;
    const stdio = Array(fd + 1).fill("ignore"); stdio[fd] = fd;
    holder = spawn("/usr/bin/flock", ["--no-fork", shared ? "-s" : "-x", "-w", "30", `/proc/self/fd/${fd}`, "/bin/sh", "-c", script, "holder", ready, String(parent.pid), parent.startTime, parent.bootId, String(parent.uid)], { stdio });
    const deadline = Date.now() + 31_000;
    while (Date.now() < deadline) {
      if (existsSync(ready)) return fn();
      if (processGone(holder.pid)) break;
      sleep(10);
    }
    throw Object.assign(new Error("The Kubernetes operation lock is busy. Retry the command."), { exitCode: 24 });
  } finally {
    if (holder) { try { process.kill(holder.pid, "SIGTERM"); } catch {} }
    try { unlinkSync(ready); } catch {}
    closeSync(fd);
  }
}
function stateSnapshot() {
  const stored = readJson(STATUS_PATH, { state: "stopped", error: null });
  const pid = readJson(PID_PATH, null);
  return { stored, identity: pid && identityValid(pid) ? "valid" : "dead" };
}
function stateReport(readiness = "unknown", snapshot = stateSnapshot()) {
  return statusKernel({ persisted: snapshot.stored.state, identity: snapshot.identity, readiness, errorReason: snapshot.stored.error });
}
function emit(report) { process.stdout.write(report.stdout); return report.exit; }
function fail(message, exitCode) { process.stderr.write(`Error: ${message}\n`); return exitCode; }
function commandOk(argv, env = process.env, timeout = 30_000) { return spawnSync(argv[0], argv.slice(1), { env, timeout, stdio: "ignore" }).status === 0; }

function checks() {
  const results = {};
  const check = (name, run, action) => { try { results[name] = run() ? { ok: true } : { ok: false, action }; } catch { results[name] = { ok: false, action }; } };
  check("uid", () => process.getuid() === 1500, "Run the Helper as the dockerd user.");
  check("epoch", () => EPOCH.length > 0, "Recreate the sandbox through Valet.");
  check("uidMap", () => mapKernel(readFileSync("/proc/self/uid_map", "utf8").trim().split("\n").map((r) => r.trim().split(/\s+/).map(Number))), "Set userNamespaces.idsPerPod to 131072.");
  check("gidMap", () => mapKernel(readFileSync("/proc/self/gid_map", "utf8").trim().split("\n").map((r) => r.trim().split(/\s+/).map(Number))), "Set userNamespaces.idsPerPod to 131072.");
  check("subuid", () => readFileSync("/etc/subuid", "utf8").split("\n").includes("dockerd:65536:65535"), "Rebuild the sandbox image from the normative lock.");
  check("subgid", () => readFileSync("/etc/subgid", "utf8").split("\n").includes("dockerd:65536:65535"), "Rebuild the sandbox image from the normative lock.");
  check("tun", () => { const s = statSync("/dev/net/tun"); return s.isCharacterDevice() && s.rdev === 2760; }, "Configure TUN 10:200 in the RuntimeClass.");
  check("kmsg", () => { const s = statSync("/dev/kmsg"); return s.isCharacterDevice() && s.rdev === 259; }, "Bind null 1:3 to /dev/kmsg in the RuntimeClass.");
  check("sysReadOnly", () => commandOk(["/bin/sh", "-c", "probe=/sys/.valet-write-test; ! touch \"$probe\" 2>/dev/null || { rm -f \"$probe\"; exit 1; }"]), "Mount the broad /sys path read-only.");
  check("cgroup", () => ["cpu", "cpuset", "memory", "pids"].every((v) => readFileSync("/sys/fs/cgroup/init/cgroup.controllers", "utf8").split(/\s+/).includes(v)), "Delegate cpu, cpuset, memory, and pids below /init.");
  check("slirp4netns", () => { const found = spawnSync("/usr/bin/dpkg-query", ["-W", "-f=${Version}", "slirp4netns"], { encoding: "utf8" }); return realpathSync("/usr/bin/slirp4netns") === "/usr/bin/slirp4netns" && found.status === 0 && found.stdout === "1.2.0-1"; }, "Install Debian Bookworm slirp4netns=1.2.0-1.");
  for (const tool of ["/usr/local/bin/k3s", "/usr/local/bin/kubectl", "/usr/bin/tini", "/usr/bin/flock"]) check(tool.split("/").pop(), () => statSync(tool).isFile(), "Rebuild the sandbox image from the normative lock.");
  return results;
}
function diagnose() {
  withLock(true, () => stateSnapshot());
  const result = checks(); process.stdout.write(`${JSON.stringify({ checks: result, schema: 1 })}\n`);
  return Object.values(result).every((value) => value.ok) ? 0 : 20;
}
function readiness() {
  const env = { ...process.env, KUBECONFIG };
  const node = spawnSync("/usr/local/bin/kubectl", ["get", "nodes", "-o", "jsonpath={.items[*].status.conditions[?(@.type==\"Ready\")].status}"], { env, timeout: 10_000, encoding: "utf8" });
  return node.status === 0 && node.stdout.trim().split(/\s+/).some((value) => value === "True") &&
    commandOk(["/usr/local/bin/kubectl", "-n", "kube-system", "rollout", "status", "deployment/coredns", "--timeout=10s"], env, 15_000);
}
function prepareRoot() {
  if (existsSync(ROOT)) {
    const root = lstatSync(ROOT);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 1500) throw Object.assign(new Error("The Kubernetes state path is unsafe. Recreate the sandbox before retrying."), { exitCode: 21 });
  }
  if (existsSync(ROOT) && readJson(STATUS_PATH, {}).epoch !== EPOCH) {
    const recorded = readJson(PID_PATH, null);
    if (recorded && recordLive(recorded)) throw Object.assign(new Error("The prior server identity is still live. Recreate the sandbox before cleanup."), { exitCode: 21 });
    rmSync(ROOT, { recursive: true, force: true });
  }
  mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  chmodSync(ROOT, 0o700);
  if (statSync(ROOT).uid !== 1500) throw Object.assign(new Error("The Kubernetes state directory has unsafe ownership. Recreate the sandbox before retrying."), { exitCode: 21 });
  for (const dir of ["data", "run", "config"]) { mkdirSync(join(ROOT, dir), { recursive: true, mode: 0o700 }); chmodSync(join(ROOT, dir), 0o700); }
  const storage = statfsSync(ROOT);
  if (storage.bavail * storage.bsize < MINIMUM_FREE_BYTES) throw Object.assign(new Error("The workspace has less than 2 GiB free. Free space, then retry."), { exitCode: 20 });
}
function operation(type) { return { type, id: randomUUID(), cancelRequested: false, deadline: Date.now() + 600_000, epoch: EPOCH, owner: procIdentity(process.pid) }; }
function cleanupStaged(operationId) {
  if (!/^[0-9a-f-]{36}$/i.test(operationId) || !existsSync(ROOT)) return;
  const prefix = `.import-${operationId}-`;
  for (const name of readdirSync(ROOT)) if (name.startsWith(prefix) && (name.endsWith(".tar") || name.endsWith(".tar.result"))) {
    try { unlinkSync(join(ROOT, name)); } catch {}
  }
}
function normalizeKubeconfig() {
  chmodSync(KUBECONFIG, 0o600);
  const env = { ...process.env, KUBECONFIG };
  const result = spawnSync("/usr/local/bin/kubectl", ["config", "current-context"], { env, encoding: "utf8" });
  if (result.status !== 0) return false;
  const context = result.stdout.trim();
  if (context === "default") return commandOk(["/usr/local/bin/kubectl", "config", "rename-context", "default", "valet-kubernetes"], env);
  return context === "valet-kubernetes";
}
function start() {
  const bad = Object.values(checks()).find((value) => !value.ok);
  if (bad) return fail(`${bad.action} Run valet-kubernetes diagnose for details.`, 20);
  let op = null; let join = false; let alreadyRunning = false; let staleImportId = null;
  withLock(false, () => {
    prepareRoot();
    const current = readJson(OP_PATH, null);
    const pid = readJson(PID_PATH, null);
    const stored = readJson(STATUS_PATH, { state: "stopped" });
    if (current?.type === "import" && !ownerValid(current.owner)) staleImportId = current.id;
    if (pid && recordLive(pid) && !identityValid(pid)) throw Object.assign(new Error("The server identity is not owned. Recreate the sandbox before cleanup."), { exitCode: 21 });
    if (current && ownerValid(current.owner)) {
      if (current.type === "start") { op = current; join = true; return; }
      throw Object.assign(new Error("Another Kubernetes operation is active. Retry after it finishes."), { exitCode: 24 });
    }
    if (stored.state === "stopping") throw Object.assign(new Error("Kubernetes is stopping. Retry after stop finishes."), { exitCode: 4 });
    if (pid && identityValid(pid)) {
      if (current) unlinkSync(OP_PATH);
      alreadyRunning = true;
      return;
    }
    if (current) unlinkSync(OP_PATH);
    op = operation("start");
    atomicJson(OP_PATH, op);
    atomicJson(STATUS_PATH, { state: "starting", error: null, epoch: EPOCH });
  });
  if (staleImportId) cleanupStaged(staleImportId);
  if (alreadyRunning) {
    if (!readiness()) return fail("Kubernetes failed its readiness recheck. Run valet-kubernetes diagnose.", 4);
    if (!normalizeKubeconfig()) return fail("The kubeconfig context is invalid. Stop the cluster, then retry.", 22);
    return emit(stateReport("ready"));
  }
  if (!op) return fail("The start Operation is missing. Retry the command.", 1);
  if (join) {
    while (Date.now() < op.deadline) {
      const snapshot = withLock(true, () => stateSnapshot());
      const report = stateReport(snapshot.stored.state === "ready" && readiness() ? "ready" : "unknown", snapshot);
      if (report.exit === 0) return emit(report);
      if (!existsSync(OP_PATH) && snapshot.stored.state !== "starting") return emit(report);
      sleep(1000);
    }
    return fail("The joined start did not become ready. Run valet-kubernetes diagnose.", 22);
  }
  if (existsSync(SCOPE) && !cleanupOwned()) throw Object.assign(new Error("The prior Kubernetes cgroup is unsafe or populated. Recreate the sandbox before retrying."), { exitCode: 21 });
  if (!join) {
    mkdirSync(SCOPE, { mode: 0o700 });
    const log = openSync(LOG_PATH, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600); chmodSync(LOG_PATH, 0o600);
    const env = { ...K3S_ENV, KUBECONFIG, VALET_SANDBOX_KUBERNETES: "1" };
    const launcher = spawn("/bin/sh", ["-c", `printf '%s\n' $$ > ${SCOPE}/cgroup.procs && exec "$@"`, "launcher", ...K3S_ARGV], { detached: true, env, stdio: ["ignore", log, log] });
    launcher.unref(); closeSync(log);
    atomicJson(PID_PATH, { ...procIdentity(launcher.pid), cgroup: SCOPE, argvDigest: createHash("sha256").update(JSON.stringify(K3S_ARGV)).digest("hex"), operationId: op.id });
    const execDeadline = Date.now() + 5_000;
    while (Date.now() < execDeadline && !identityValid(readJson(PID_PATH, null))) {
      if (processGone(launcher.pid)) break;
      sleep(10);
    }
  }
  while (Date.now() < op.deadline) {
    const current = readJson(OP_PATH, null);
    if (!current || current.id !== op.id || current.cancelRequested || !ownerValid(current.owner)) return 4;
    const pid = readJson(PID_PATH, null);
    if (!pid || !identityValid(pid)) break;
    if (readiness()) {
      if (!normalizeKubeconfig()) return fail("The kubeconfig context is invalid. Stop the cluster, then retry.", 22);
      let committed = false;
      withLock(false, () => {
        const claim = readJson(OP_PATH, null);
        if (claim?.id !== op.id || claim.cancelRequested || !ownerValid(claim.owner)) return;
        atomicJson(STATUS_PATH, { state: "ready", error: null, epoch: EPOCH }); unlinkSync(OP_PATH); committed = true;
      });
      return committed ? emit(stateReport("ready")) : 4;
    }
    sleep(1000);
  }
  const cleaned = cleanupOwned();
  let committed = false;
  withLock(false, () => {
    const claim = readJson(OP_PATH, null);
    if (claim?.id !== op.id || claim.cancelRequested || !ownerValid(claim.owner)) return;
    atomicJson(STATUS_PATH, { state: "error", error: cleaned ? "startup_timeout" : "startup_failed", epoch: EPOCH }); unlinkSync(OP_PATH); committed = true;
  });
  if (!committed) return 4;
  return cleaned
    ? fail("Kubernetes startup timed out. Inspect server.log and run valet-kubernetes diagnose.", 22)
    : fail("Kubernetes startup cleanup did not drain its cgroup. Recreate the sandbox before retrying.", 21);
}
function processGone(pid) {
  try { return readFileSync(`/proc/${pid}/status`, "utf8").match(/^State:\s+(.)/m)?.[1] === "Z"; } catch { return true; }
}
function terminate(pid) {
  try { process.kill(-pid, "SIGTERM"); } catch {}
  let until = Date.now() + 10_000;
  while (Date.now() < until) { if (processGone(pid)) return; sleep(100); }
  try { process.kill(-pid, "SIGKILL"); } catch {}
  until = Date.now() + 2_000;
  while (Date.now() < until) { if (processGone(pid)) return; sleep(100); }
}
function ownedCgroups(path, result = []) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 1500) return null;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = ownedCgroups(join(path, entry.name), result);
    if (!nested) return null;
  }
  result.push(path);
  return result;
}
export function removeOwnedCgroupDirectories(scope) {
  const paths = ownedCgroups(scope); if (!paths) return false;
  try { for (const path of paths) rmdirSync(path); return true; } catch { return false; }
}
function cleanupOwned() {
  if (!existsSync(SCOPE)) return true;
  if (!ownedCgroups(SCOPE)) return false;
  const pid = readJson(PID_PATH, null); if (pid && identityValid(pid)) terminate(pid.pid);
  try { writeFileSync(join(SCOPE, "cgroup.kill"), "1\n"); } catch { return false; }
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    try { if (/^populated 0$/m.test(readFileSync(join(SCOPE, "cgroup.events"), "utf8"))) break; } catch { return false; }
    sleep(100);
  }
  try {
    if (!/^populated 0$/m.test(readFileSync(join(SCOPE, "cgroup.events"), "utf8"))) return false;
    return removeOwnedCgroupDirectories(SCOPE);
  } catch { return false; }
}
function stoppedReport() { process.stdout.write(statusKernel({ persisted: "stopped", identity: "dead", readiness: "unknown" }).stdout); return 0; }
function stop() {
  let stopped = false; let unsafe = false; let active = null;
  withLock(false, () => {
    const status = readJson(STATUS_PATH, { state: "stopped" });
    const pid = readJson(PID_PATH, null);
    if (status.state === "stopped" && !pid && !existsSync(ROOT)) { stopped = true; return; }
    if (pid && recordLive(pid) && !identityValid(pid)) { unsafe = true; return; }
    active = readJson(OP_PATH, null);
    if (active && ownerValid(active.owner)) { active.cancelRequested = true; atomicJson(OP_PATH, active); atomicJson(STATUS_PATH, { state: "stopping", error: null, epoch: EPOCH }); }
  });
  if (stopped) return stoppedReport();
  if (unsafe) return fail("The server identity is not owned. Recreate the sandbox before cleanup.", 21);
  if (active?.worker && ownerValid(active.worker)) terminate(active.worker.pid);
  if (active && ownerValid(active.owner)) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && ownerValid(active.owner)) sleep(100);
    if (ownerValid(active.owner)) return fail("The active Kubernetes operation did not stop. Retry the command.", 24);
  }
  let op;
  withLock(false, () => {
    const current = readJson(OP_PATH, null);
    if (current && ownerValid(current.owner)) throw Object.assign(new Error("Another Kubernetes operation became active. Retry stop."), { exitCode: 24 });
    op = operation("stop"); atomicJson(OP_PATH, op); atomicJson(STATUS_PATH, { state: "stopping", error: null, epoch: EPOCH });
  });
  if (!cleanupOwned()) {
    withLock(false, () => {
      const claim = readJson(OP_PATH, null);
      if (claim?.id === op.id && !claim.cancelRequested && ownerValid(claim.owner)) { atomicJson(STATUS_PATH, { state: "error", error: "stop_failed", epoch: EPOCH }); unlinkSync(OP_PATH); }
    });
    return fail("Kubernetes cleanup did not drain its owned cgroup. Retry stop.", 22);
  }
  let committed = false;
  withLock(false, () => {
    const claim = readJson(OP_PATH, null);
    if (claim?.id !== op.id || claim.cancelRequested || !ownerValid(claim.owner)) return;
    rmSync(ROOT, { recursive: true, force: true }); committed = true;
  });
  return committed
    ? stoppedReport()
    : fail("The stop Operation was superseded. Retry the command.", 4);
}
export function validateArchive(path, freeBytes = statfsSync(ROOT).bavail * statfsSync(ROOT).bsize) {
  if (!path.startsWith("/")) return "Use an absolute archive path.";
  try { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) return "Use a regular archive file, not a link or device."; if (s.size > freeBytes) return "Free workspace storage, then retry the import."; return null; }
  catch { return "Select an existing regular OCI-layout or Docker-save tar archive."; }
}
export function archiveKind(path) {
  const inspect = String.raw`{ name=$0; sub(/^\.\//, "", name); count=split(name, part, "/"); if (substr(name, 1, 1)=="/") bad=1; for (i=1; i<=count; i++) if (part[i]=="..") bad=1; if (name=="manifest.json") docker=1; if (name=="oci-layout") layout=1; if (name=="index.json") hasIndex=1 } END { if (bad) print "unsafe"; else if (docker) print "docker"; else if (layout && hasIndex) print "oci"; else print "unknown" }`;
  const listed = spawnSync("/bin/bash", ["-o", "pipefail", "-c", 'exec /bin/tar --list --file "$1" | /usr/bin/awk "$2"', "archive", path, inspect], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  if (listed.error?.code === "ETIMEDOUT") return { error: "Archive inspection timed out. Use a valid OCI-layout or Docker-save tar archive." };
  if (listed.status !== 0 || listed.stdout.trim() === "unsafe") return { error: "Use a safe OCI-layout or Docker-save tar archive." };
  const kind = listed.stdout.trim();
  return kind === "docker" || kind === "oci" ? { kind } : { error: "Use an OCI-layout or Docker-save tar archive." };
}
export function readImportResult(path) {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const code = Number(raw);
    return raw !== "" && Number.isInteger(code) && code >= 0 && code <= 255 ? { code } : { error: "The image import result is invalid. Check server.log, then retry." };
  } catch { return { error: "The image import did not record a result. Check free workspace storage and server.log, then retry." }; }
}
function recoverStaleImport() {
  let stale = null; let recovery = null; let leaderReady = false;
  withLock(false, () => {
    const claim = readJson(OP_PATH, null);
    if (!claim || claim.type !== "import" || ownerValid(claim.owner)) return;
    const pid = readJson(PID_PATH, null);
    leaderReady = Boolean(pid && identityValid(pid) && readJson(STATUS_PATH, {}).state === "ready");
    stale = claim; recovery = operation("import"); atomicJson(OP_PATH, recovery);
  });
  if (!stale) return;
  if (stale.worker && ownerValid(stale.worker)) terminate(stale.worker.pid);
  cleanupStaged(stale.id);
  withLock(false, () => {
    const claim = readJson(OP_PATH, null);
    if (claim?.id !== recovery.id || claim.cancelRequested || !ownerValid(claim.owner)) return;
    atomicJson(STATUS_PATH, { state: leaderReady ? "ready" : "error", error: leaderReady ? null : "import_owner_lost", epoch: EPOCH });
    unlinkSync(OP_PATH);
  });
}
function importArchives(paths) {
  recoverStaleImport();
  const snapshot = withLock(true, () => stateSnapshot());
  if (stateReport(snapshot.stored.state === "ready" && readiness() ? "ready" : "failed", snapshot).exit !== 0) {
    return fail("Kubernetes is not ready. Run valet-kubernetes start, then retry.", 4);
  }
  let op;
  withLock(false, () => {
    const claim = readJson(OP_PATH, null);
    if (claim && ownerValid(claim.owner)) throw Object.assign(new Error("Another Kubernetes operation is active. Retry after it finishes."), { exitCode: 24 });
    const status = readJson(STATUS_PATH, { state: "stopped" });
    const pid = readJson(PID_PATH, null);
    if (status.state !== "ready" || !pid || !identityValid(pid)) throw Object.assign(new Error("Kubernetes is not ready. Run valet-kubernetes start, then retry."), { exitCode: 4 });
    if (claim) unlinkSync(OP_PATH);
    op = operation("import"); atomicJson(OP_PATH, op);
  });
  let failure = null;
  for (const path of paths) {
    const problem = validateArchive(path); if (problem) { failure = { message: problem, exit: 2 }; break; }
    const before = lstatSync(path); const staged = join(ROOT, `.import-${op.id}-${randomUUID()}.tar`);
    const resultPath = `${staged}.result`;
    try {
      copyFileSync(path, staged, constants.COPYFILE_EXCL); chmodSync(staged, 0o600); const after = lstatSync(path);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) { failure = { message: "The archive changed during staging. Stop its writer, then retry.", exit: 2 }; break; }
      const archive = archiveKind(staged);
      if (!archive.kind) { failure = { message: archive.error, exit: 2 }; break; }
      const argv = ["/usr/local/bin/k3s", "ctr", "--address", `${ROOT}/run/k3s/containerd/containerd.sock`, "--namespace", "k8s.io", "images", "import", "--digests", staged];
      const worker = spawn("/bin/sh", ["-c", '"$@"; code=$?; printf "%s\n" "$code" > "$VALET_IMPORT_RESULT"', "import", ...argv], { detached: true, env: { ...process.env, VALET_IMPORT_RESULT: resultPath }, stdio: "inherit" });
      worker.unref();
      op.worker = procIdentity(worker.pid); withLock(false, () => { const claim = readJson(OP_PATH, null); if (claim?.id === op.id) atomicJson(OP_PATH, op); });
      while (!processGone(worker.pid)) {
        const claim = readJson(OP_PATH, null);
        if (!claim || claim.id !== op.id || claim.cancelRequested) { terminate(worker.pid); failure = { message: "The image import was canceled. Retry after stop finishes.", exit: 4 }; break; }
        sleep(100);
      }
      if (failure) break;
      const importResult = readImportResult(resultPath);
      if (importResult.error) { failure = { message: importResult.error, exit: 22 }; break; }
      if (importResult.code !== 0) { failure = { message: "The image import failed. Check the archive and server.log, then retry.", exit: importResult.code }; break; }
    } catch { failure = { message: "The image import could not stage or read its result. Free workspace storage, check server.log, then retry.", exit: 22 }; break;
    } finally { for (const file of [staged, resultPath]) { try { unlinkSync(file); } catch {} } }
  }
  let committed = false;
  withLock(false, () => {
    const claim = readJson(OP_PATH, null);
    if (claim?.id !== op.id || claim.cancelRequested || !ownerValid(claim.owner)) return;
    unlinkSync(OP_PATH); committed = true;
  });
  if (!committed) return fail("The import Operation was superseded. Retry the command.", 4);
  return failure ? fail(failure.message, failure.exit) : emit(stateReport("ready"));
}
function status() {
  const snapshot = withLock(true, () => stateSnapshot());
  const probe = snapshot.stored.state === "ready" ? (readiness() ? "ready" : "failed") : "unknown";
  return emit(stateReport(probe, snapshot));
}

export function main(argv) {
  if (process.getuid() !== 1500) return fail("Run valet-kubernetes as the dockerd user.", 20);
  const [command, ...args] = argv;
  if (!command || (command !== "import" && args.length) || (command === "import" && args.length === 0) || !["start", "status", "stop", "import", "diagnose"].includes(command)) { process.stderr.write(`${USAGE}\n`); return 2; }
  try {
    if (command === "start") return start(); if (command === "status") return status(); if (command === "stop") return stop(); if (command === "diagnose") return diagnose(); return importArchives(args);
  } catch (error) { return fail(error instanceof Error ? error.message : String(error), error?.exitCode ?? 1); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) process.exitCode = main(process.argv.slice(2));
