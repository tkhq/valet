/**
 * Coverage for the staged-files staging service: row upsert against a real
 * PGlite app db, inline-vs-blob payload placement, and the parent-sandbox
 * snapshot helper (staged-files design, 2026-08-23).
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { BlobStore, ExecOpts, ExecResult, Sandbox } from "@valet/engine";
import { buildAppDb, buildAppQueryable, applyAppMigrations } from "../lib/drizzle.js";
import { sessionStagedFiles } from "../schema/index.js";
import {
  INLINE_MAX_BYTES,
  loadStagedFiles,
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
    expect(row.blobKey).toBe(`staged/sess-1/${row.id}`);
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
