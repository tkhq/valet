/**
 * Valet Security guardrail 4 (finding location verification): the pure sandbox
 * read `verifyFileInSandbox` and the host method `readSandboxFileMeta`.
 *
 * `verifyFileInSandbox` is the injection-safe existence + line-count read: it
 * calls `Sandbox.stat`/`readFile` with a workspace-relative path (never a shell
 * argv). These tests drive it with a real `VirtualSandbox` (an in-memory FS) and
 * with a fake sandbox that throws a non-ENOENT error, to prove the fail-open
 * split: a CONFIRMED-absent file fails closed, a transport error re-throws so
 * the caller fails open.
 *
 * `readSandboxFileMeta` returns `null` (indeterminate → fail open) for a session
 * that is not live in this host's cache — the "sandbox not ready / no session"
 * case. No ANTHROPIC_API_KEY and no model turn: nothing is built here.
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryCredentialStore,
  InMemoryEventStream,
  InMemorySessionStore,
  VirtualSandbox,
  type ExecOpts,
  type ExecResult,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { EngineHost, verifyFileInSandbox } from "./host.js";

/** A sandbox whose reads always throw a NON-ENOENT error — the indeterminate
 * (transport) case. Only `stat`/`readFile` matter here; the rest delegate to a
 * real VirtualSandbox so the shape is complete without any cast. */
class ThrowingReadSandbox implements Sandbox {
  readonly id = "throwing";
  private inner = new VirtualSandbox("throwing-inner");
  async readFile(): Promise<string> {
    throw new Error("EIO: simulated transport failure");
  }
  async readBinary(): Promise<Uint8Array> {
    throw new Error("EIO: simulated transport failure");
  }
  async writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    return this.inner.writeBinary(path, data);
  }
  async readdir(path: string): Promise<string[]> {
    return this.inner.readdir(path);
  }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    throw new Error("EIO: simulated transport failure");
  }
  async mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path);
  }
  async rm(path: string, opts?: { recursive?: boolean }): Promise<void> {
    return this.inner.rm(path, opts);
  }
  async exec(command: string, opts?: ExecOpts): Promise<ExecResult> {
    return this.inner.exec(command, opts);
  }
}

/** A non-isolated provider (like virtual/local): `readSandboxFileMeta` gates on
 * isolation, so this proves the fail-open path for a live-but-non-isolated
 * session too. */
class NonIsolatedProvider implements SandboxProvider {
  readonly backend = "test-noniso";
  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      coldStartEstimateMs: 0,
    };
  }
  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    return new VirtualSandbox("noniso-1");
  }
  async restore(id: string): Promise<Sandbox> {
    return new VirtualSandbox(id);
  }
  async destroy(): Promise<void> {}
  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready" };
  }
}

describe("verifyFileInSandbox (guardrail 4 pure read)", () => {
  it("reports a real file as existing with its exact line count", async () => {
    const sb = new VirtualSandbox("vfs-1");
    // Clone root is `repo`; the finding cites `src/a.ts`.
    await sb.writeFile("repo/src/a.ts", "line1\nline2\nline3\n");
    const meta = await verifyFileInSandbox(sb, "repo", "src/a.ts");
    expect(meta).toEqual({ exists: true, lines: 3 });
  });

  it("counts a final line with no trailing newline", async () => {
    const sb = new VirtualSandbox("vfs-2");
    await sb.writeFile("repo/one.ts", "only one line");
    expect(await verifyFileInSandbox(sb, "repo", "one.ts")).toEqual({ exists: true, lines: 1 });
  });

  it("reports a confirmed-absent file (fail closed)", async () => {
    const sb = new VirtualSandbox("vfs-3");
    await sb.writeFile("repo/present.ts", "x\n");
    const meta = await verifyFileInSandbox(sb, "repo", "missing.ts");
    expect(meta).toEqual({ exists: false, lines: 0 });
  });

  it("treats a directory as absent", async () => {
    const sb = new VirtualSandbox("vfs-4");
    await sb.mkdir("repo/src");
    expect(await verifyFileInSandbox(sb, "repo", "src")).toEqual({ exists: false, lines: 0 });
  });

  it("refuses a path that escapes the clone root (absent)", async () => {
    const sb = new VirtualSandbox("vfs-5");
    await sb.writeFile("secret.ts", "x\n");
    // `../secret.ts` from clone root `repo` escapes the tree.
    expect(await verifyFileInSandbox(sb, "repo", "../secret.ts")).toEqual({ exists: false, lines: 0 });
  });

  it("resolves against the workspace root when the clone root is '.'", async () => {
    const sb = new VirtualSandbox("vfs-6");
    await sb.writeFile("top.ts", "a\nb\n");
    expect(await verifyFileInSandbox(sb, ".", "top.ts")).toEqual({ exists: true, lines: 2 });
    expect(await verifyFileInSandbox(sb, null, "top.ts")).toEqual({ exists: true, lines: 2 });
  });

  it("re-throws a NON-ENOENT read error so the caller can fail open", async () => {
    const sb = new ThrowingReadSandbox();
    await expect(verifyFileInSandbox(sb, "repo", "src/a.ts")).rejects.toThrow(/transport failure/);
  });
});

describe("EngineHost.readSandboxFileMeta (guardrail 4 host seam)", () => {
  it("returns null (fail open) for a session that is not live in the cache", async () => {
    const host = new EngineHost({
      engineStore: new InMemorySessionStore(),
      sandboxProvider: new NonIsolatedProvider(),
      eventStream: new InMemoryEventStream(),
      engineCredentials: new InMemoryCredentialStore(),
    });
    // Never built → not in cache → indeterminate.
    expect(await host.readSandboxFileMeta("never-built", "src/a.ts")).toBeNull();
  });
});
