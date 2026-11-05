import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NESTED_KUBERNETES_IDENTITY } from "../src/index.js";
import {
  archiveKind,
  capabilityKernel,
  cgroupMembershipKernel,
  cmdlineIdentityKernel,
  epochRecoveryKernel,
  K3S_ARGV,
  K3S_ENV,
  LEAF_CONTROLLERS,
  LEAF_CONVERGENCE,
  leaderState,
  leafConvergenceKernel,
  lifecycleKernel,
  mapKernel,
  SCOPE,
  STATE_REMOVAL_TIMEOUT_MS,
  startupKernel,
  startRecoveryKernel,
  statusKernel,
  stopGuardKernel,
  readImportResult,
  removeStateRoot,
  ROOT,
  validateArchive,
} from "../../../docker/valet-kubernetes.mjs";

interface Vector<TInput, TExpected> { id: string; mode?: string; input: TInput; expected: TExpected; covers?: string[] }
interface CmdlineInput { bytes: string }
type CmdlineVectorId = `cmdline-${string}`;
interface LeaderInput { state: "S" | "Z" | "S->Z" | "missing"; cmdline: CmdlineVectorId; cgroup: "owned" | "foreign" }
interface Vectors {
  capabilityVectors: Vector<{ requested: boolean; provider: false | "v1" }, string>[];
  mapVectors: Vector<number[][], boolean>[];
  cgroupVectors: Vector<string, boolean>[];
  cmdlineIdentityVectors: Vector<CmdlineInput, boolean>[];
  startupVectors: Vector<{ leader: string; deadlineExpired: boolean }, string>[];
  leafConvergenceVectors: Vector<{ leaderLocation: "leaf" | "evac" | "other"; leafProcs: string[]; enabled: string[]; required: string[]; evacExists: boolean }, string>[];
  leaderStateVectors: Vector<LeaderInput, string>[];
  startRecoveryVectors: Vector<LeaderInput, string>[];
  stopGuardVectors: Vector<LeaderInput | null, string>[];
  epochRecoveryVectors: Vector<LeaderInput | null, string>[];
  lifecycleVectors: Vector<Record<string, unknown>, Record<string, unknown>>[];
  statusVectors: Vector<Record<string, unknown>, { exit: number; persistedAfter: string; stdout: string }>[];
  acceptanceVectors: { id: string; mode: string; step: string; check: string; expected: string; covers: string[] }[];
  lockDigest: string;
  artifacts: { arch: string; name: string; version: string; url: string; sha256: string }[];
  k3sArgv: string[];
  k3sEnv: Record<string, string>;
  leafControllers: string[];
  leafConvergence: { attempts: number; delayMs: number };
}
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/specs/nested-kubernetes-v1-vectors.json", import.meta.url),
    "utf8",
  ),
) as Vectors;

function cmdlineFixture(input: CmdlineInput): Buffer {
  return Buffer.from(input.bytes, "latin1");
}

function namedCmdline(id: CmdlineVectorId): Buffer {
  const vector = vectors.cmdlineIdentityVectors.find((candidate) => candidate.id === id);
  if (!vector) throw new Error(`missing cmdline vector ${id}`);
  return cmdlineFixture(vector.input);
}

function leaderFixture(input: LeaderInput) {
  const proc = mkdtempSync(join(tmpdir(), "valet-kubernetes-proc-"));
  const pid = 4242;
  mkdirSync(join(proc, "sys/kernel/random"), { recursive: true });
  writeFileSync(join(proc, "sys/kernel/random/boot_id"), "boot-test\n");
  if (input.state !== "missing") {
    const initialState = input.state === "S->Z" ? "S" : input.state;
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (k3s) ${initialState} ${Array(18).fill("0").join(" ")} 123 0\n`);
    writeFileSync(join(proc, String(pid), "status"), `Name:\tk3s\nState:\t${initialState}\nUid:\t1500\t1500\t1500\t1500\n`);
    writeFileSync(join(proc, String(pid), "cmdline"), namedCmdline(input.cmdline));
    writeFileSync(join(proc, String(pid), "cgroup"), input.cgroup === "owned" ? "0::/init/valet-kubernetes/leaf\n" : "0::/init/foreign\n");
  }
  const record = { pid, startTime: "123", bootId: "boot-test", uid: 1500, epoch: process.env.VALET_SANDBOX_EPOCH ?? "", cgroup: SCOPE, argvDigest: createHash("sha256").update(JSON.stringify(K3S_ARGV)).digest("hex") };
  return { proc, record };
}
function guardFixture(input: LeaderInput | null) {
  return input === null ? { proc: "/missing", record: null } : leaderFixture(input);
}

describe("nested Kubernetes normative vectors", () => {
  it.each(vectors.capabilityVectors)("executes $id", ({ input, expected }) => {
    expect(capabilityKernel(input.requested, input.provider)).toBe(expected);
  });
  it.each(vectors.mapVectors)("executes $id", ({ input, expected }) => {
    expect(mapKernel(input)).toBe(expected);
  });
  it.each(vectors.cgroupVectors)("executes $id", ({ input, expected }) => {
    expect(cgroupMembershipKernel(input)).toBe(expected);
  });
  it.each(vectors.cmdlineIdentityVectors)("executes $id", ({ input, expected }) => {
    expect(cmdlineIdentityKernel(cmdlineFixture(input), K3S_ARGV)).toBe(expected);
  });
  it.each(vectors.startupVectors)("executes $id", ({ input, expected }) => {
    expect(startupKernel(input)).toBe(expected);
  });
  it.each(vectors.leafConvergenceVectors)("executes $id", ({ input, expected }) => {
    expect(leafConvergenceKernel(input)).toBe(expected);
  });
  it.each(vectors.leaderStateVectors)("executes $id at the proc seam", ({ input, expected }) => {
    const { proc, record } = leaderFixture(input);
    const transition = input.state === "S->Z" ? () => {
      writeFileSync(join(proc, String(record.pid), "stat"), `${record.pid} (k3s) Z ${Array(18).fill("0").join(" ")} 123 0\n`);
      return false;
    } : undefined;
    expect(leaderState(record, proc, transition)).toBe(expected);
  });
  it.each(vectors.startRecoveryVectors)("executes $id through the start recovery guard", ({ input, expected }) => {
    const { proc, record } = leaderFixture(input);
    expect(startRecoveryKernel(record, proc)).toBe(expected);
  });
  it.each(vectors.stopGuardVectors)("executes $id through the stop guard", ({ input, expected }) => {
    const { proc, record } = guardFixture(input);
    expect(stopGuardKernel(record, proc)).toBe(expected);
  });
  it.each(vectors.epochRecoveryVectors)("executes $id through the epoch guard", ({ input, expected }) => {
    const { proc, record } = guardFixture(input);
    expect(epochRecoveryKernel(record, proc)).toBe(expected);
  });
  it.each(vectors.lifecycleVectors)("executes $id", ({ input, expected }) => {
    expect(lifecycleKernel(input)).toEqual(expected);
  });
  it.each(vectors.statusVectors)("executes $id", ({ input, expected }) => {
    expect(statusKernel(input)).toEqual(expected);
  });

  it("binds the production capability identity to the normative lock", () => {
    expect(NESTED_KUBERNETES_IDENTITY).toBe(`nested-kubernetes:v1:${vectors.lockDigest}`);
  });

  it("uses the normative process contract", () => {
    expect(K3S_ARGV).toEqual(vectors.k3sArgv);
    expect(K3S_ENV).toEqual(vectors.k3sEnv);
    expect(LEAF_CONTROLLERS).toEqual(["cpuset", "cpu", "memory", "pids"]);
    expect(LEAF_CONTROLLERS).toEqual(vectors.leafControllers);
    expect(LEAF_CONVERGENCE).toEqual(vectors.leafConvergence);
  });

  it("requires unique, non-vacuous safety kernel vectors", () => {
    const groups = [vectors.capabilityVectors, vectors.mapVectors, vectors.cgroupVectors, vectors.cmdlineIdentityVectors, vectors.startupVectors, vectors.leafConvergenceVectors, vectors.leaderStateVectors, vectors.startRecoveryVectors, vectors.stopGuardVectors, vectors.epochRecoveryVectors, vectors.lifecycleVectors, vectors.statusVectors, vectors.acceptanceVectors];
    const all = groups.flat();
    expect(new Set(all.map(({ id }) => id)).size).toBe(all.length);
    for (const vector of all) {
      expect(vector.id.length).toBeGreaterThan(0);
      expect(vector.covers?.length).toBeGreaterThan(0);
      expect(vector.expected).not.toBeUndefined();
    }
    const design = readFileSync(
      new URL("../../../docs/specs/2026-09-12-nested-kubernetes-design.md", import.meta.url),
      "utf8",
    );
    const required = new Set([...design.matchAll(/\[K(\d+)\]/g)].map((match) => Number(match[1])));
    const covered = new Set<number>();
    for (const vector of all) for (const range of vector.covers ?? []) {
      for (const part of range.split(",")) {
        const match = /^K(\d+)(?:-K?(\d+))?$/.exec(part.trim());
        expect(match, `unknown coverage token: ${part}`).not.toBeNull();
        if (!match) continue;
        const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
        expect(last).toBeGreaterThanOrEqual(first);
        for (let clause = first; clause <= last; clause += 1) covered.add(clause);
      }
    }
    expect([...covered].filter((clause) => !required.has(clause))).toEqual([]);
    expect([...required].filter((clause) => !covered.has(clause))).toEqual([]);

    const lifecycleById = new Map(vectors.lifecycleVectors.map((vector) => [vector.id, vector]));
    for (const id of ["life-live-owner-no-theft", "life-start-commit-after-stop"]) {
      expect(lifecycleById.get(id)?.mode).toBe("kernel");
    }
    expect(lifecycleById.get("life-live-owner-no-theft")?.covers).toContain("K136");
    expect(lifecycleById.get("life-start-commit-after-stop")?.covers).toContain("K138-K139");
  });

  it("installs every locked artifact with its URL and checksum", () => {
    const dockerfile = readFileSync(
      new URL("../../../docker/Dockerfile.sandbox-k8s", import.meta.url),
      "utf8",
    );
    for (const artifact of vectors.artifacts) {
      expect(dockerfile).toContain(artifact.url);
      expect(dockerfile).toContain(artifact.sha256);
      expect(dockerfile).toContain(artifact.version);
    }
    expect(dockerfile).not.toMatch(/curl[^\n]*rootlesskit/i);
  });
});

describe("state root removal", () => {
  it("allows the namespaced remover to use the operation budget", () => {
    expect(STATE_REMOVAL_TIMEOUT_MS).toBe(600_000);
    const helper = readFileSync(new URL("../../../docker/valet-kubernetes.mjs", import.meta.url), "utf8");
    expect(helper).toContain("timeout: STATE_REMOVAL_TIMEOUT_MS");
  });

  it("retries access failures in the subordinate-mapped user namespace", () => {
    let present = true;
    let namespacedTarget = "";
    removeStateRoot(ROOT, {
      remove: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      exists: () => present,
      removeInUserNamespace: (target: string) => { namespacedTarget = target; present = false; return 0; },
    });
    expect(namespacedTarget).toBe(ROOT);
  });

  it("retries every direct removal error", () => {
    let present = true;
    removeStateRoot(ROOT, {
      remove: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
      exists: () => present,
      removeInUserNamespace: () => { present = false; return 0; },
    });
    expect(present).toBe(false);
  });

  it("fails closed when direct and namespaced removal both fail", () => {
    let failure: unknown;
    try {
      removeStateRoot(ROOT, {
        remove: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
        exists: () => true,
        removeInUserNamespace: () => 1,
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "state_removal_failed", exitCode: 22 });
  });

  it("reports an interrupted namespaced removal as retryable", () => {
    let failure: unknown;
    try {
      removeStateRoot(ROOT, {
        remove: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
        exists: () => true,
        removeInUserNamespace: () => spawnSync("/bin/sh", ["-c", "sleep 1"], { timeout: 20 }),
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "state_removal_failed", exitCode: 22 });
    expect(String(failure)).toContain("Retry stop");
    expect(String(failure)).not.toContain("Recreate the sandbox");
  });

  it("ignores temporary cleanup failure after Root is absent", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "valet-kubernetes-cleanup-"));
    let present = true;
    expect(() => removeStateRoot(ROOT, {
      remove: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
      exists: () => present,
      makeTemporaryRoot: () => temporaryRoot,
      removeInUserNamespace: () => { present = false; return 0; },
      removeTemporaryRoot: () => { throw new Error("cleanup failed"); },
    })).not.toThrow();
    expect(present).toBe(false);
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it("refuses every removal target except the exact state root", () => {
    expect(() => removeStateRoot(ROOT + "/data")).toThrow("state removal path is unsafe");
  });
});

function tarHeader(name: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  for (const [offset, value, width] of [[100, "0000644\0", 8], [108, "0000000\0", 8], [116, "0000000\0", 8], [124, "00000000000\0", 12], [136, "00000000000\0", 12]] as const) header.write(value, offset, width, "ascii");
  header.fill(0x20, 148, 156); header.write("0", 156, 1, "ascii"); header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

describe("archive validation", () => {
  it("inspects a many-entry archive without buffering its full listing", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-tar-"));
    const archive = join(dir, "many.tar");
    const headers = Array.from({ length: 12_000 }, (_, index) => tarHeader(`entry-${String(index).padStart(5, "0")}-${"x".repeat(70)}`));
    writeFileSync(archive, Buffer.concat([...headers, tarHeader("manifest.json"), Buffer.alloc(1024)]));
    expect(archiveKind(archive)).toEqual({ kind: "docker" });
  });

  it("rejects traversal even when an archive also has a valid marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-unsafe-tar-"));
    const archive = join(dir, "unsafe.tar");
    writeFileSync(archive, Buffer.concat([tarHeader("../escape"), tarHeader("manifest.json"), Buffer.alloc(1024)]));
    expect(archiveKind(archive)).toEqual({ error: "Use a safe OCI-layout or Docker-save tar archive." });
  });

  it("governs missing and invalid import result files", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-result-"));
    const result = join(dir, "result");
    expect(readImportResult(result)).toEqual({ error: "The image import did not record a result. Check free workspace storage and server.log, then retry." });
    writeFileSync(result, "\n");
    expect(readImportResult(result)).toEqual({ error: "The image import result is invalid. Check server.log, then retry." });
    writeFileSync(result, "not-a-code\n");
    expect(readImportResult(result)).toEqual({ error: "The image import result is invalid. Check server.log, then retry." });
    writeFileSync(result, "0\n");
    expect(readImportResult(result)).toEqual({ code: 0 });
  });

  it("accepts a regular absolute archive and rejects links", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-"));
    const archive = join(dir, "image.tar");
    const link = join(dir, "link.tar");
    writeFileSync(archive, "archive");
    symlinkSync(archive, link);
    expect(validateArchive(archive, 100)).toBeNull();
    expect(validateArchive(link, 100)).toContain("regular archive");
    expect(validateArchive("relative.tar", 100)).toContain("absolute");
    expect(validateArchive(archive, 1)).toContain("Free workspace storage");
  });
});
