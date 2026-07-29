import { describe, it, expect } from "vitest";
import { capturePatch, patchBlobKey, MAX_PATCH_BYTES } from "../src/patch-capture.js";
import { InMemoryBlobStore } from "../src/index.js";
import type { ExecResult, Sandbox } from "../src/index.js";

/** Minimal exec-only sandbox stub: everything else throws if touched. */
function stubSandbox(handler: (command: string) => ExecResult | Promise<ExecResult>): Sandbox {
  const unused = () => {
    throw new Error("not used by patch capture");
  };
  return {
    id: "sb-1",
    readFile: unused,
    readBinary: unused,
    writeFile: unused,
    writeBinary: unused,
    readdir: unused,
    stat: unused,
    mkdir: unused,
    rm: unused,
    exec: async (command: string) => handler(command),
  };
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "boom"): ExecResult => ({ stdout: "", stderr, exitCode: 1 });

const startRef = {
  repoUrl: "https://github.com/tkhq/valet.git",
  branch: "dev-v2",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  capturedAt: 1,
};

function ctx(overrides: Partial<Parameters<typeof capturePatch>[0]> = {}) {
  return {
    sessionId: "s1",
    queueItemId: "q1",
    blobs: new InMemoryBlobStore(),
    startRef,
    sandbox: stubSandbox(() => ok()),
    attachmentState: "ready",
    ...overrides,
  };
}

async function readBlob(blobs: InMemoryBlobStore, key: string): Promise<string> {
  const blob = await blobs.get(key);
  if (!blob) throw new Error(`missing blob ${key}`);
  const chunks: Uint8Array[] = [];
  const reader = blob.data.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("patch capture (engine traces, change 3)", () => {
  it("skips without a blob store", async () => {
    const result = await capturePatch(ctx({ blobs: undefined }));
    expect(result).toEqual({ status: "skipped", reason: "no_blob_store" });
  });

  it("skips without a start-ref", async () => {
    const result = await capturePatch(ctx({ startRef: undefined }));
    expect(result).toEqual({ status: "skipped", reason: "no_start_ref" });
  });

  it("skips when the sandbox isn't ready, naming the attachment state", async () => {
    const result = await capturePatch(ctx({ sandbox: null, attachmentState: "suspended" }));
    expect(result).toEqual({ status: "skipped", reason: "sandbox_suspended" });
  });

  it("skips a non-git workspace", async () => {
    const sandbox = stubSandbox((cmd) => (cmd.includes("rev-parse") ? fail("not a repo") : ok()));
    const result = await capturePatch(ctx({ sandbox }));
    expect(result).toEqual({ status: "skipped", reason: "not_a_git_workspace" });
  });

  it("captures: exact command sequence, diff against the start SHA, index restored", async () => {
    const commands: string[] = [];
    const sandbox = stubSandbox((cmd) => {
      commands.push(cmd);
      if (cmd.startsWith("git diff")) return ok("diff --git a/f b/f\n+new line\n");
      return ok("true");
    });
    const blobs = new InMemoryBlobStore();
    const result = await capturePatch(ctx({ sandbox, blobs }));
    expect(result.status).toBe("captured");
    expect(result.blobKey).toBe(patchBlobKey("s1", "q1"));
    expect(result.truncated).toBeUndefined();
    // The full shell sequence: probe, intent-to-add, diff, reset — in order.
    expect(commands).toEqual([
      "git rev-parse --is-inside-work-tree",
      "git add -N .",
      `git diff '${startRef.commitSha}'`,
      "git reset -q",
    ]);
    expect(await readBlob(blobs, result.blobKey as string)).toContain("+new line");
  });

  it("empty diff still captures (zero-change submissions are a real signal)", async () => {
    const sandbox = stubSandbox((cmd) => (cmd.startsWith("git diff") ? ok("") : ok("true")));
    const blobs = new InMemoryBlobStore();
    const result = await capturePatch(ctx({ sandbox, blobs }));
    expect(result.status).toBe("captured");
    expect(result.bytes).toBe(0);
    expect(await readBlob(blobs, result.blobKey as string)).toBe("");
  });

  it("truncates oversize patches head-only with the trailing marker", async () => {
    const big = "x".repeat(MAX_PATCH_BYTES + 5000);
    const sandbox = stubSandbox((cmd) => (cmd.startsWith("git diff") ? ok(big) : ok("true")));
    const blobs = new InMemoryBlobStore();
    const result = await capturePatch(ctx({ sandbox, blobs }));
    expect(result.status).toBe("captured");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(MAX_PATCH_BYTES);
    const stored = await readBlob(blobs, result.blobKey as string);
    expect(stored).toMatch(/\[TRUNCATED: original patch was \d+ bytes; only the first 2 MiB stored\]\n$/);
  });

  it("a throwing sandbox exec yields failed, never throws", async () => {
    const sandbox = stubSandbox(() => {
      throw new Error("container gone");
    });
    const result = await capturePatch(ctx({ sandbox }));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("sandbox_exec");
    expect(result.reason).toContain("container gone");
  });

  it("a rejecting blob put yields failed, never throws", async () => {
    const blobs = new InMemoryBlobStore();
    blobs.put = async () => {
      throw new Error("quota exceeded");
    };
    const sandbox = stubSandbox((cmd) => (cmd.startsWith("git diff") ? ok("d") : ok("true")));
    const result = await capturePatch(ctx({ sandbox, blobs }));
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("blob_put: quota exceeded");
  });

  it("re-capture overwrites the same deterministic key", async () => {
    const blobs = new InMemoryBlobStore();
    const mk = (text: string) =>
      stubSandbox((cmd) => (cmd.startsWith("git diff") ? ok(text) : ok("true")));
    await capturePatch(ctx({ sandbox: mk("first"), blobs }));
    const second = await capturePatch(ctx({ sandbox: mk("second"), blobs }));
    expect(await readBlob(blobs, second.blobKey as string)).toBe("second");
  });
});
