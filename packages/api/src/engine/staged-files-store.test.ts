/**
 * Coverage for the staged-files staging service: row upsert against a real
 * PGlite app db, inline-vs-blob payload placement, and the parent-sandbox
 * snapshot helper (staged-files design, 2026-08-23).
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { SandboxUnavailableError } from "@valet/engine";
import type { BlobStore, ExecOpts, ExecResult, Sandbox } from "@valet/engine";
import { buildAppDb, buildAppQueryable, applyAppMigrations } from "../lib/drizzle.js";
import { sessionStagedFiles } from "../schema/index.js";
import {
  INLINE_MAX_BYTES,
  loadStagedFiles,
  materializeSkillResources,
  snapshotFromSandbox,
  stageForSession,
} from "./staged-files.js";

class MemoryBlobStore implements BlobStore {
  blobs = new Map<string, Uint8Array>();
  async put(key: string, data: Uint8Array | ReadableStream): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new Error("test store takes bytes");
    this.blobs.set(key, data);
  }
  async get(key: string): Promise<{ data: ReadableStream } | null> {
    const bytes = this.blobs.get(key);
    if (!bytes) return null;
    return {
      data: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    };
  }
  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

const pglite = new PGlite();
const db = buildAppDb(pglite);
const raw = buildAppQueryable(pglite);
let migrated = false;

beforeEach(async () => {
  if (!migrated) {
    await applyAppMigrations(raw);
    migrated = true;
  } else {
    await raw.query("TRUNCATE session_staged_files");
  }
});

afterAll(async () => {
  await raw.close();
});

describe("stageForSession", () => {
  it("stores a small text payload inline, with hash and size recorded", async () => {
    const blobs = new MemoryBlobStore();
    const row = await stageForSession(
      { db, blobs },
      {
        sessionId: "sess-1",
        origin: "share",
        originKey: "parent-1",
        targetPath: ".valet/shared/report.md",
        kind: "file",
        payload: new TextEncoder().encode("hello\n"),
      },
    );
    expect(row.inlineContent).toBe("hello\n");
    expect(row.blobKey).toBeNull();
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(blobs.blobs.size).toBe(0);
    const stored = await loadStagedFiles(db, "sess-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].targetPath).toBe(".valet/shared/report.md");
  });

  it("stores a large payload in the blob store under staged/<session>/<id>", async () => {
    const blobs = new MemoryBlobStore();
    const payload = new Uint8Array(INLINE_MAX_BYTES + 1);
    const row = await stageForSession(
      { db, blobs },
      {
        sessionId: "sess-1",
        origin: "share",
        originKey: "parent-1",
        targetPath: "big.bin",
        kind: "file",
        payload,
      },
    );
    expect(row.inlineContent).toBeNull();
    expect(row.blobKey).toBe(`staged/sess-1/${row.id}/${row.contentHash.slice(0, 16)}`);
    expect(blobs.blobs.get(row.blobKey!)).toEqual(payload);
  });

  it("always uses the blob store for bundles", async () => {
    const blobs = new MemoryBlobStore();
    const row = await stageForSession(
      { db, blobs },
      {
        sessionId: "sess-1",
        origin: "share",
        originKey: "parent-1",
        targetPath: "input/data",
        kind: "bundle",
        payload: new Uint8Array([31, 139, 8]),
      },
    );
    expect(row.inlineContent).toBeNull();
    expect(row.blobKey).not.toBeNull();
  });

  it("re-pushing the same target upserts in place: same row id, new payload", async () => {
    const blobs = new MemoryBlobStore();
    const first = await stageForSession(
      { db, blobs },
      {
        sessionId: "sess-1",
        origin: "share",
        originKey: "parent-1",
        targetPath: "report.md",
        kind: "file",
        payload: new TextEncoder().encode("v1\n"),
      },
    );
    const second = await stageForSession(
      { db, blobs },
      {
        sessionId: "sess-1",
        origin: "share",
        originKey: "parent-1",
        targetPath: "report.md",
        kind: "file",
        payload: new TextEncoder().encode("v2\n"),
      },
    );
    expect(second.id).toBe(first.id);
    expect(second.inlineContent).toBe("v2\n");
    expect(second.contentHash).not.toBe(first.contentHash);
    const rows = await db
      .select()
      .from(sessionStagedFiles)
      .where(eq(sessionStagedFiles.sessionId, "sess-1"));
    expect(rows).toHaveLength(1);
  });

  it("rejects a target path that escapes the workspace", async () => {
    await expect(
      stageForSession(
        { db, blobs: new MemoryBlobStore() },
        {
          sessionId: "sess-1",
          origin: "share",
          originKey: "parent-1",
          targetPath: "../etc/passwd",
          kind: "file",
          payload: new Uint8Array([1]),
        },
      ),
    ).rejects.toThrow(/workspace/i);
  });
});

describe("snapshotFromSandbox", () => {
  function fakeSandbox(opts: {
    files?: Record<string, Uint8Array>;
    dirs?: string[];
    tarBytes?: Uint8Array;
  }): Sandbox & { execCalls: string[] } {
    const execCalls: string[] = [];
    return {
      id: "sb-parent",
      execCalls,
      async readFile() {
        throw new Error("not implemented");
      },
      async readBinary(path: string) {
        if (opts.files?.[path]) return opts.files[path];
        if (opts.tarBytes && path.includes(".tgz")) return opts.tarBytes;
        throw new Error(`ENOENT: ${path}`);
      },
      async writeFile() {},
      async writeBinary() {},
      async readdir() {
        return [];
      },
      async stat(path: string) {
        if (opts.files?.[path]) return { isFile: true, isDirectory: false, size: opts.files[path].byteLength };
        if (opts.dirs?.includes(path)) return { isFile: false, isDirectory: true, size: 0 };
        if (opts.tarBytes && path.includes(".tgz")) {
          return { isFile: true, isDirectory: false, size: opts.tarBytes.byteLength };
        }
        throw new Error(`ENOENT: ${path}`);
      },
      async mkdir() {},
      async rm() {},
      async exec(command: string, _o?: ExecOpts): Promise<ExecResult> {
        execCalls.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
  }

  it("snapshots a file as kind=file with its bytes", async () => {
    const sandbox = fakeSandbox({
      files: { "/workspace/report.md": new TextEncoder().encode("content") },
    });
    const snap = await snapshotFromSandbox(sandbox, "report.md");
    expect(snap.kind).toBe("file");
    expect(new TextDecoder().decode(snap.payload)).toBe("content");
  });

  it("snapshots a directory as kind=bundle via tar through the workspace tmp dir", async () => {
    const sandbox = fakeSandbox({ dirs: ["/workspace/data"], tarBytes: new Uint8Array([31, 139]) });
    const snap = await snapshotFromSandbox(sandbox, "data");
    expect(snap.kind).toBe("bundle");
    expect([...snap.payload]).toEqual([31, 139]);
    const tarCmd = sandbox.execCalls.find((c) => c.startsWith("tar ") || c.includes("tar czf"));
    expect(tarCmd).toContain("-C '/workspace/data'");
  });

  it("names the missing path when it is neither file nor directory", async () => {
    const sandbox = fakeSandbox({});
    await expect(snapshotFromSandbox(sandbox, "missing.txt")).rejects.toThrow(/missing\.txt/);
  });
});

describe("materializeSkillResources", () => {
  function recordingSandbox(): Sandbox & {
    writes: Map<string, Uint8Array>;
    mkdirs: string[];
    execCalls: string[];
  } {
    const writes = new Map<string, Uint8Array>();
    const mkdirs: string[] = [];
    const execCalls: string[] = [];
    return {
      id: "sb-skill",
      writes,
      mkdirs,
      execCalls,
      async readFile() {
        throw new Error("not implemented");
      },
      async readBinary() {
        throw new Error("not implemented");
      },
      async writeFile() {},
      async writeBinary(path: string, data: Uint8Array) {
        writes.set(path, data);
      },
      async readdir() {
        return [];
      },
      async stat() {
        throw new Error("ENOENT");
      },
      async mkdir(path: string) {
        mkdirs.push(path);
      },
      async rm() {},
      async exec(command: string): Promise<ExecResult> {
        execCalls.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
  }

  const skill = {
    name: "pdf-tools",
    resources: [
      { path: "scripts/extract.py", data: new TextEncoder().encode("print('hi')\n") },
      { path: "references/REF.md", data: new TextEncoder().encode("ref\n") },
    ],
  };

  it("writes every resource under the skill root, stages rows, and returns the root", async () => {
    const sandbox = recordingSandbox();
    const root = await materializeSkillResources(
      { db, blobs: new MemoryBlobStore() },
      skill,
      { sessionId: "sess-skill", sandbox },
    );
    expect(root).toBe("/workspace/.valet/skills/pdf-tools");
    expect(sandbox.writes.has("/workspace/.valet/skills/pdf-tools/scripts/extract.py")).toBe(true);
    expect(sandbox.writes.has("/workspace/.valet/skills/pdf-tools/references/REF.md")).toBe(true);
    const rows = await loadStagedFiles(db, "sess-skill");
    expect(rows.map((r) => r.targetPath).sort()).toEqual([
      ".valet/skills/pdf-tools/references/REF.md",
      ".valet/skills/pdf-tools/scripts/extract.py",
    ]);
    expect(rows.every((r) => r.origin === "skill")).toBe(true);
    const chmod = sandbox.execCalls.find((c) => c.includes("chmod"));
    expect(chmod).toContain("/workspace/.valet/skills/pdf-tools/scripts");
  });

  it("write-through still succeeds without a db (no rows, no throw)", async () => {
    const sandbox = recordingSandbox();
    const root = await materializeSkillResources({}, skill, {
      sessionId: "sess-nodb",
      sandbox,
    });
    expect(root).toBe("/workspace/.valet/skills/pdf-tools");
    expect(sandbox.writes.size).toBe(2);
  });

  it("rejects a resource whose path escapes the skill root", async () => {
    const evil = {
      name: "evil",
      resources: [{ path: "../../outside.sh", data: new Uint8Array([1]) }],
    };
    await expect(
      materializeSkillResources({ db }, evil, { sessionId: "sess-evil", sandbox: recordingSandbox() }),
    ).rejects.toThrow(/workspace/i);
  });
});

describe("snapshotFromSandbox guards", () => {
  function sizedSandbox(opts: {
    fileSize?: number;
    dir?: string;
    tarSize?: number;
    statError?: Error;
  }): Sandbox & { reads: string[] } {
    const reads: string[] = [];
    return {
      id: "sb-sized",
      reads,
      async readFile() {
        throw new Error("not implemented");
      },
      async readBinary(path: string) {
        reads.push(path);
        return new Uint8Array([1]);
      },
      async writeFile() {},
      async writeBinary() {},
      async readdir() {
        return [];
      },
      async stat(path: string) {
        if (opts.statError) throw opts.statError;
        if (opts.dir && path === `/workspace/${opts.dir}`) {
          return { isFile: false, isDirectory: true, size: 0 };
        }
        if (path.includes(".tgz")) {
          return { isFile: true, isDirectory: false, size: opts.tarSize ?? 1 };
        }
        if (opts.fileSize !== undefined) {
          return { isFile: true, isDirectory: false, size: opts.fileSize };
        }
        throw new Error(`ENOENT: ${path}`);
      },
      async mkdir() {},
      async rm() {},
      async exec(): Promise<ExecResult> {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
  }

  it("rejects an oversized file BEFORE reading it into memory", async () => {
    const sandbox = sizedSandbox({ fileSize: 1024 });
    await expect(snapshotFromSandbox(sandbox, "big.bin", { maxBytes: 100 })).rejects.toThrow(
      /100/,
    );
    expect(sandbox.reads).toHaveLength(0);
  });

  it("rejects an oversized directory tarball BEFORE reading it into memory", async () => {
    const sandbox = sizedSandbox({ dir: "data", tarSize: 5000 });
    await expect(snapshotFromSandbox(sandbox, "data", { maxBytes: 100 })).rejects.toThrow(/100/);
    expect(sandbox.reads).toHaveLength(0);
  });

  it("rethrows sandbox availability errors instead of reporting 'not found'", async () => {
    const sandbox = sizedSandbox({ statError: new SandboxUnavailableError() });
    await expect(snapshotFromSandbox(sandbox, "report.md")).rejects.toThrow(
      /\[sandbox_unavailable\]/,
    );
  });
});

describe("stageForSession blob consistency", () => {
  it("re-push with new content writes a NEW blob key and deletes the old one", async () => {
    const blobs = new MemoryBlobStore();
    const payload = new Uint8Array(INLINE_MAX_BYTES + 1);
    const first = await stageForSession(
      { db, blobs },
      {
        sessionId: "sess-b",
        origin: "share",
        originKey: "parent-1",
        targetPath: "big.bin",
        kind: "file",
        payload,
      },
    );
    const second = await stageForSession(
      { db, blobs },
      {
        sessionId: "sess-b",
        origin: "share",
        originKey: "parent-1",
        targetPath: "big.bin",
        kind: "file",
        payload: new Uint8Array(INLINE_MAX_BYTES + 2),
      },
    );
    expect(second.blobKey).not.toBe(first.blobKey);
    expect(blobs.blobs.has(second.blobKey!)).toBe(true);
    expect(blobs.blobs.has(first.blobKey!)).toBe(false);
  });
});
