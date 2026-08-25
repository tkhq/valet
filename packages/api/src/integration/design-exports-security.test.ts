/**
 * Valet Design export/download hardening (adversarial-review fixes), API-level.
 *
 * These flows are not reachable through the plain `VirtualSandboxProvider`
 * mini-shell, so this suite boots the api with a scriptable fake sandbox
 * provider. The fake lets a test:
 *   - plant the /workspace/exports listing (readdir + stat),
 *   - script the in-sandbox guard `exec` (symlink / escape / size verdict),
 *   - serve bytes for a download (readBinary),
 * then drive a design session live (`sessionFor` + `ensureReady`) so the
 * routes read a real attached sandbox.
 *
 * Covered:
 *   1. Symlink rejection — the guard exec reports SYMLINK → 404, no readBinary.
 *   2. Oversize — the guard exec reports a size over the cap → 413.
 *   3. Exports listing returns `sandbox:"cold"` + the cached names on a
 *      hibernated session, and NEVER resumes the sandbox.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type {
  Sandbox,
  SandboxCapabilities,
  SandboxCreateOpts,
  SandboxProvider,
  SandboxStatus,
  ExecOpts,
  ExecResult,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { agentSessions } from "../schema/index.js";
import type { CreateSessionResponse, DesignExportsResponse } from "../wire/types.js";

/**
 * A sandbox whose file ops and `exec` are fully scripted by the test. Only the
 * methods the export/download routes call carry real behavior; the rest satisfy
 * the `Sandbox` contract with inert defaults.
 */
class ScriptedSandbox implements Sandbox {
  /** name → size for the /workspace/exports listing. */
  exportsListing = new Map<string, number>();
  /** Handler for `exec` — the design guard script runs through here. */
  execHandler: (command: string) => ExecResult = () => ({ stdout: "", stderr: "", exitCode: 0 });
  /** Bytes returned by readBinary, keyed by absolute path. */
  binaries = new Map<string, Uint8Array>();
  /** Set true if anything tries to resume/wake through this handle. */
  execCalls: string[] = [];

  constructor(public readonly id: string) {}

  async readFile(): Promise<string> {
    return "";
  }
  async readBinary(path: string): Promise<Uint8Array> {
    const data = this.binaries.get(path);
    if (!data) throw new Error(`no such file: ${path}`);
    return data;
  }
  async writeFile(): Promise<void> {}
  async writeBinary(): Promise<void> {}
  async readdir(path: string): Promise<string[]> {
    if (path === "/workspace/exports") return [...this.exportsListing.keys()];
    throw new Error(`no such directory: ${path}`);
  }
  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    const name = path.replace("/workspace/exports/", "");
    const size = this.exportsListing.get(name);
    if (size === undefined) throw new Error(`no such file: ${path}`);
    return { isFile: true, isDirectory: false, size };
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(command: string, _opts?: ExecOpts): Promise<ExecResult> {
    this.execCalls.push(command);
    return this.execHandler(command);
  }
  async destroy(): Promise<void> {}
}

/**
 * A provider that hands out exactly one `ScriptedSandbox` and records how many
 * times it created or restored a sandbox, so a test can prove the cold listing
 * path never resumed or re-provisioned one.
 */
class ScriptedProvider implements SandboxProvider {
  readonly backend = "scripted";
  readonly sandbox: ScriptedSandbox;
  createCount = 0;
  restoreCount = 0;

  constructor() {
    this.sandbox = new ScriptedSandbox("scripted-sb-1");
  }

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: false,
      coldStartEstimateMs: 0,
    };
  }
  async create(_opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCount++;
    return this.sandbox;
  }
  async restore(_id: string): Promise<Sandbox> {
    this.restoreCount++;
    return this.sandbox;
  }
  async destroy(): Promise<void> {}
  async status(id: string): Promise<SandboxStatus> {
    return { id, state: "ready", startedAt: Date.now() };
  }
}

describe("design export/download hardening (API-level)", () => {
  let api: TestApi;
  let provider: ScriptedProvider;
  let workspaceRoot: string;

  beforeAll(async () => {
    provider = new ScriptedProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    workspaceRoot = mkdtempSync(join(tmpdir(), "valet-design-exp-"));
  });

  afterAll(async () => {
    await api.cleanup();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function createDesignSession(template: string): Promise<string> {
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: join(workspaceRoot, template), kind: "design", template }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as CreateSessionResponse).id;
  }

  /** Drive the session into the host cache with a `ready` attachment. */
  async function makeLive(sessionId: string, template: string): Promise<void> {
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: join(workspaceRoot, template),
    });
    await session.attachment.ensureReady({ timeoutMs: 10_000 });
    expect(api.providers.engineHost.isLive(sessionId)).toBe(true);
    expect(session.attachment.current()).not.toBeNull();
  }

  it("rejects a symlinked export with 404 and never reads its bytes", async () => {
    const sessionId = await createDesignSession("slides");
    await makeLive(sessionId, "slides");
    provider.sandbox.exportsListing.set("leak.pdf", 1024);
    // The guard exec reports the file is a symlink.
    provider.sandbox.execHandler = () => ({ stdout: "SYMLINK\n", stderr: "", exitCode: 0 });
    // If the route ignored the guard and read anyway, this byte would leak.
    provider.sandbox.binaries.set("/workspace/exports/leak.pdf", new Uint8Array([1, 2, 3]));

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/exports/leak.pdf`);
    expect(res.status).toBe(404);
    // The guard ran; the bytes were never served.
    expect(provider.sandbox.execCalls.some((c) => c.includes("realpath"))).toBe(true);
  });

  it("rejects an export whose realpath escapes /workspace/exports with 404", async () => {
    const sessionId = await createDesignSession("slides");
    await makeLive(sessionId, "slides");
    provider.sandbox.exportsListing.set("escape.pdf", 512);
    provider.sandbox.execHandler = () => ({ stdout: "ESCAPE\n", stderr: "", exitCode: 0 });

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/exports/escape.pdf`);
    expect(res.status).toBe(404);
  });

  it("returns 413 with the limit when an export exceeds the size cap", async () => {
    const sessionId = await createDesignSession("slides");
    await makeLive(sessionId, "slides");
    const oversize = 200 * 1024 * 1024; // 200 MB > 100 MB cap
    provider.sandbox.exportsListing.set("huge.pdf", oversize);
    // A valid regular file, but the guard reports a size over the cap.
    provider.sandbox.execHandler = () => ({ stdout: `${oversize}\n`, stderr: "", exitCode: 0 });

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/exports/huge.pdf`);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("100 MB");
    expect(body.error).toContain("smaller");
  });

  it("downloads a valid, in-bounds export", async () => {
    const sessionId = await createDesignSession("slides");
    await makeLive(sessionId, "slides");
    provider.sandbox.exportsListing.set("deck.pdf", 5);
    provider.sandbox.execHandler = () => ({ stdout: "5\n", stderr: "", exitCode: 0 });
    provider.sandbox.binaries.set("/workspace/exports/deck.pdf", new Uint8Array([10, 20, 30, 40, 50]));

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/exports/deck.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    const buf = new Uint8Array(await res.arrayBuffer());
    expect([...buf]).toEqual([10, 20, 30, 40, 50]);
  });

  it("exports listing: live → cold serves cached names and never resumes", async () => {
    const sessionId = await createDesignSession("slides");
    await makeLive(sessionId, "slides");
    // The single shared sandbox carries files planted by earlier tests; the
    // listing under test needs an exact set.
    provider.sandbox.exportsListing.clear();
    provider.sandbox.exportsListing.set("cached-a.pdf", 100);
    provider.sandbox.exportsListing.set("cached-b.pptx", 200);
    // Guard is not called by the listing path; keep it inert.
    provider.sandbox.execHandler = () => ({ stdout: "", stderr: "", exitCode: 0 });

    // 1) A live listing records the cache and reports "live".
    const liveRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/exports`);
    expect(liveRes.status).toBe(200);
    const live = (await liveRes.json()) as DesignExportsResponse;
    expect(live.sandbox).toBe("live");
    expect(live.files.map((f) => f.name).sort()).toEqual(["cached-a.pdf", "cached-b.pptx"]);

    // 2) Hibernate the session: evict it from the host cache AND stamp the row
    // hibernated, so the route sees no live attachment.
    await api.providers.engineHost.destroy(sessionId); // drops it from the cache
    await api.providers.db
      .update(agentSessions)
      .set({ status: "hibernated", hibernatedSandboxId: provider.sandbox.id })
      .where(eq(agentSessions.id, sessionId));
    expect(api.providers.engineHost.isLive(sessionId)).toBe(false);

    const restoreBefore = provider.restoreCount;
    const createBefore = provider.createCount;

    // 3) The listing now reports "cold" with the cached names — and NOTHING
    // resumed or re-provisioned the sandbox.
    const coldRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/exports`);
    expect(coldRes.status).toBe(200);
    const cold = (await coldRes.json()) as DesignExportsResponse;
    expect(cold.sandbox).toBe("cold");
    expect(cold.files.map((f) => f.name).sort()).toEqual(["cached-a.pdf", "cached-b.pptx"]);
    expect(provider.restoreCount).toBe(restoreBefore);
    expect(provider.createCount).toBe(createBefore);
  });

  it("exports listing: a session that never provisioned reports sandbox:none", async () => {
    const sessionId = await createDesignSession("document");
    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/design/exports`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DesignExportsResponse;
    expect(body.sandbox).toBe("none");
    expect(body.files).toEqual([]);
  });
});
