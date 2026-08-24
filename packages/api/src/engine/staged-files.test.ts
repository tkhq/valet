/**
 * Unit coverage for the staged-files core (staged-files design, 2026-08-23):
 * target-path validation, the staged StepSpecs `computeSpec` emits, and the
 * apply closures `buildPrepSteps` pairs them with.
 *
 * Uses the same recording-fake `Sandbox` pattern as `prep-steps.test.ts`.
 */
import { describe, it, expect } from "vitest";
import type { BlobStore, ExecOpts, ExecResult, Sandbox } from "@valet/engine";
import {
  validateTargetPath,
  type StagedFileSnap,
} from "./staged-files.js";
import { computeSpec } from "./sandbox-spec.js";
import type { ResolveSnapshot } from "./sandbox-spec.js";
import { buildPrepSteps } from "./prep-steps.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const baseSnap: ResolveSnapshot = {
  apiUrl: "https://api.example.com",
  stockImage: "ghcr.io/valet/sandbox:latest",
  repoBake: null,
  baseBakeRef: null,
  repos: [],
  userName: "Alice",
  userEmail: "alice@example.com",
};

function makeStaged(overrides?: Partial<StagedFileSnap>): StagedFileSnap {
  return {
    id: "sf-1",
    origin: "share",
    targetPath: ".valet/shared/report.md",
    kind: "file",
    blobKey: null,
    inlineContent: "hello\n",
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

class MemoryBlobStore implements BlobStore {
  private blobs = new Map<string, Uint8Array>();
  async put(key: string, data: Uint8Array | ReadableStream): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new Error("test store takes bytes");
    this.blobs.set(key, data);
  }
  async get(key: string): Promise<{ data: ReadableStream; contentType?: string } | null> {
    const bytes = this.blobs.get(key);
    if (!bytes) return null;
    return {
      data: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  }
  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

class RecordingSandbox implements Sandbox {
  readonly id = "sb-staged";
  execCalls: string[] = [];
  writes = new Map<string, string>();
  binaryWrites = new Map<string, Uint8Array>();
  mkdirs: string[] = [];
  async readFile(): Promise<string> { throw new Error("not implemented"); }
  async readBinary(): Promise<Uint8Array> { throw new Error("not implemented"); }
  async writeFile(path: string, content: string): Promise<void> {
    this.writes.set(path, content);
  }
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    this.binaryWrites.set(path, data);
  }
  async readdir(): Promise<string[]> { return []; }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    throw new Error("ENOENT");
  }
  async mkdir(path: string): Promise<void> { this.mkdirs.push(path); }
  async rm(): Promise<void> {}
  async exec(command: string, _opts?: ExecOpts): Promise<ExecResult> {
    this.execCalls.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

// ── validateTargetPath ────────────────────────────────────────────────────

describe("validateTargetPath", () => {
  it("normalizes a workspace-relative path", () => {
    expect(validateTargetPath("input/data.csv")).toBe("input/data.csv");
  });

  it("accepts /workspace-absolute paths and strips the prefix", () => {
    expect(validateTargetPath("/workspace/input/data.csv")).toBe("input/data.csv");
  });

  it("rejects absolute paths outside the workspace", () => {
    expect(() => validateTargetPath("/etc/passwd")).toThrow(/workspace/i);
  });

  it("rejects traversal that escapes the workspace", () => {
    expect(() => validateTargetPath("../outside")).toThrow(/workspace/i);
    expect(() => validateTargetPath("a/../../outside")).toThrow(/workspace/i);
    expect(() => validateTargetPath("/workspace/../etc")).toThrow(/workspace/i);
  });

  it("rejects an empty target", () => {
    expect(() => validateTargetPath("")).toThrow(/empty|workspace/i);
    expect(() => validateTargetPath("/workspace")).toThrow(/empty|workspace/i);
  });
});

// ── computeSpec: staged StepSpecs ─────────────────────────────────────────

describe("computeSpec staged-file steps", () => {
  it("emits one staged:<id> step per staged file, after the fixed steps", () => {
    const snap: ResolveSnapshot = {
      ...baseSnap,
      stagedFiles: [makeStaged(), makeStaged({ id: "sf-2", origin: "skill", targetPath: ".valet/skills/pdf/scripts/x.py" })],
    };
    const spec = computeSpec(snap);
    const ids = spec.steps.map((s) => s.id);
    expect(ids).toEqual(["credential-scripts", "git-identity", "staged:sf-1", "staged:sf-2"]);
  });

  it("marks shares critical and skill resources non-critical", () => {
    const snap: ResolveSnapshot = {
      ...baseSnap,
      stagedFiles: [makeStaged(), makeStaged({ id: "sf-2", origin: "skill" })],
    };
    const spec = computeSpec(snap);
    const share = spec.steps.find((s) => s.id === "staged:sf-1");
    const skill = spec.steps.find((s) => s.id === "staged:sf-2");
    expect(share?.critical).toBe(true);
    expect(skill?.critical).toBe(false);
  });

  it("changes the step hash when the payload or target changes", () => {
    const base = computeSpec({ ...baseSnap, stagedFiles: [makeStaged()] });
    const newContent = computeSpec({
      ...baseSnap,
      stagedFiles: [makeStaged({ contentHash: "b".repeat(64) })],
    });
    const newTarget = computeSpec({
      ...baseSnap,
      stagedFiles: [makeStaged({ targetPath: "elsewhere.md" })],
    });
    const hashOf = (spec: ReturnType<typeof computeSpec>) =>
      spec.steps.find((s) => s.id === "staged:sf-1")?.hash;
    expect(hashOf(newContent)).not.toBe(hashOf(base));
    expect(hashOf(newTarget)).not.toBe(hashOf(base));
  });
});

// ── buildPrepSteps: staged apply closures ─────────────────────────────────

describe("buildPrepSteps staged apply", () => {
  it("writes an inline file under /workspace with its parent created", async () => {
    const snap: ResolveSnapshot = { ...baseSnap, stagedFiles: [makeStaged()] };
    const steps = buildPrepSteps(snap, computeSpec(snap).steps, undefined, {
      blobs: new MemoryBlobStore(),
    });
    const sandbox = new RecordingSandbox();
    const staged = steps.find((s) => s.id === "staged:sf-1");
    await staged?.apply(sandbox);
    expect(sandbox.mkdirs).toContain("/workspace/.valet/shared");
    expect(sandbox.writes.get("/workspace/.valet/shared/report.md")).toBe("hello\n");
  });

  it("writes a blob-backed file via writeBinary", async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put("staged/sess/sf-1", new TextEncoder().encode("blob-bytes"));
    const snap: ResolveSnapshot = {
      ...baseSnap,
      stagedFiles: [makeStaged({ inlineContent: null, blobKey: "staged/sess/sf-1" })],
    };
    const steps = buildPrepSteps(snap, computeSpec(snap).steps, undefined, { blobs });
    const sandbox = new RecordingSandbox();
    await steps.find((s) => s.id === "staged:sf-1")?.apply(sandbox);
    const written = sandbox.binaryWrites.get("/workspace/.valet/shared/report.md");
    expect(new TextDecoder().decode(written)).toBe("blob-bytes");
  });

  it("unpacks a bundle: writes the tarball to .valet/tmp, untars into the target, removes the tarball", async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put("staged/sess/sf-9", new Uint8Array([1, 2, 3]));
    const snap: ResolveSnapshot = {
      ...baseSnap,
      stagedFiles: [
        makeStaged({ id: "sf-9", kind: "bundle", inlineContent: null, blobKey: "staged/sess/sf-9", targetPath: "input/data" }),
      ],
    };
    const steps = buildPrepSteps(snap, computeSpec(snap).steps, undefined, { blobs });
    const sandbox = new RecordingSandbox();
    await steps.find((s) => s.id === "staged:sf-9")?.apply(sandbox);
    expect(sandbox.binaryWrites.has("/workspace/.valet/tmp/staged-sf-9.tgz")).toBe(true);
    const cmd = sandbox.execCalls.find((c) => c.includes("tar"));
    expect(cmd).toContain("mkdir -p '/workspace/input/data'");
    expect(cmd).toContain("tar xzf '/workspace/.valet/tmp/staged-sf-9.tgz' -C '/workspace/input/data'");
    expect(cmd).toContain("rm -f '/workspace/.valet/tmp/staged-sf-9.tgz'");
  });

  it("throws when the blob is missing so reconcile reports the step", async () => {
    const snap: ResolveSnapshot = {
      ...baseSnap,
      stagedFiles: [makeStaged({ inlineContent: null, blobKey: "staged/sess/gone" })],
    };
    const steps = buildPrepSteps(snap, computeSpec(snap).steps, undefined, {
      blobs: new MemoryBlobStore(),
    });
    await expect(steps.find((s) => s.id === "staged:sf-1")?.apply(new RecordingSandbox())).rejects.toThrow(
      /staged\/sess\/gone/,
    );
  });
});

describe("staged apply shell safety", () => {
  it("quotes a bundle target containing a single quote so the exec cannot break out", async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put("staged/sess/sf-q", new Uint8Array([1]));
    const snap: ResolveSnapshot = {
      ...baseSnap,
      stagedFiles: [
        makeStaged({
          id: "sf-q",
          kind: "bundle",
          inlineContent: null,
          blobKey: "staged/sess/sf-q",
          targetPath: "input/O'Brien data",
        }),
      ],
    };
    const steps = buildPrepSteps(snap, computeSpec(snap).steps, undefined, { blobs });
    const sandbox = new RecordingSandbox();
    await steps.find((s) => s.id === "staged:sf-q")?.apply(sandbox);
    const cmd = sandbox.execCalls.find((c) => c.includes("tar"));
    // POSIX escape: the apostrophe becomes '\'' so the path never
    // terminates the quoting.
    expect(cmd).toContain("O'\\''Brien");
    expect(cmd).not.toContain("-C '/workspace/input/O'Brien");
  });

  it("re-applies a skill scripts/ file with the executable bit restored", async () => {
    const snap: ResolveSnapshot = {
      ...baseSnap,
      stagedFiles: [
        makeStaged({
          id: "sf-s",
          origin: "skill",
          targetPath: ".valet/skills/pdf/scripts/run.sh",
          inlineContent: "#!/bin/sh\n",
        }),
      ],
    };
    const steps = buildPrepSteps(snap, computeSpec(snap).steps, undefined, {
      blobs: new MemoryBlobStore(),
    });
    const sandbox = new RecordingSandbox();
    await steps.find((s) => s.id === "staged:sf-s")?.apply(sandbox);
    const chmod = sandbox.execCalls.find((c) => c.includes("chmod"));
    expect(chmod).toContain(".valet/skills/pdf/scripts/run.sh");
  });

  it("does not chmod non-script staged files", async () => {
    const snap: ResolveSnapshot = { ...baseSnap, stagedFiles: [makeStaged()] };
    const steps = buildPrepSteps(snap, computeSpec(snap).steps, undefined, {
      blobs: new MemoryBlobStore(),
    });
    const sandbox = new RecordingSandbox();
    await steps.find((s) => s.id === "staged:sf-1")?.apply(sandbox);
    expect(sandbox.execCalls.filter((c) => c.includes("chmod"))).toHaveLength(0);
  });
});
