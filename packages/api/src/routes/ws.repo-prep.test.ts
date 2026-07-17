/**
 * Regression: repo prep must survive whichever route touches a session FIRST.
 *
 * `EngineHost.sessionFor` builds the engine session ONCE per cache lifetime,
 * on the first touch for a given id — and only that first `meta` decides
 * whether `prepareSandbox` (the repo clone hook) gets wired. In the default
 * web flow the browser opens the WS event stream BEFORE it POSTs the first
 * prompt, so the WS route is the first touch. Before the centralization fix,
 * `ws.ts` passed a meta WITHOUT `repos`, so the session cached a prep-less
 * attachment and repo-bound sessions NEVER cloned — the later repos-carrying
 * `/messages` call was a no-op cache hit.
 *
 * This test reproduces that exact ordering: create a repo-bound session, touch
 * it FIRST through the real WS route, then drive the sandbox to `ready` (what
 * the first prompt turn does) and assert the recording provider observed the
 * `git clone`. Fails against the pre-fix `ws.ts` (no clone), passes after.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExecResult,
  Sandbox,
  SandboxCapabilities,
  SandboxProvider,
  SandboxStatus,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { captureInitFrame } from "../integration/_test-utils.js";
import type { CreateSessionResponse } from "../wire/types.js";

/** Records every `exec` it runs and reports "nothing exists yet" for
 * `stat`/`readdir` so workspace-prep takes the fresh-clone path (rather than
 * the existing-clone fetch/checkout branch). Every exec succeeds. */
class CloneRecordingSandbox implements Sandbox {
  constructor(
    readonly id: string,
    private readonly execs: string[],
  ) {}
  async readFile(): Promise<string> {
    return "";
  }
  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async writeFile(): Promise<void> {}
  async writeBinary(): Promise<void> {}
  async readdir(): Promise<string[]> {
    throw new Error("ENOENT"); // clone target doesn't exist yet
  }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    throw new Error("ENOENT"); // no `.git` present → not an existing clone
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(command: string): Promise<ExecResult> {
    this.execs.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

class CloneRecordingProvider implements SandboxProvider {
  readonly backend = "clone-recording-test";
  readonly execs: string[] = [];
  private sandboxes = new Map<string, CloneRecordingSandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: false,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      coldStartEstimateMs: 0,
    };
  }
  async create(): Promise<Sandbox> {
    const id = `rec-${this.nextId++}`;
    const sb = new CloneRecordingSandbox(id, this.execs);
    this.sandboxes.set(id, sb);
    return sb;
  }
  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`recording sandbox not found: ${id}`);
    return sb;
  }
  async destroy(id: string): Promise<void> {
    this.sandboxes.delete(id);
  }
  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready", startedAt: Date.now() } : { id, state: "released" };
  }
}

describe("WS-first-touch repo prep", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("wires prepareSandbox even when the WS route is the first touch, so a repo-bound session still clones", async () => {
    const provider = new CloneRecordingProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const workspace = await mkdtemp(join(tmpdir(), "valet-ws-repo-prep-"));

    // Create a repo-bound session.
    const res = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace,
        repo: { fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" },
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as CreateSessionResponse;

    // FIRST touch through the real WS route (mirrors the browser opening the
    // event stream before it POSTs any prompt). This is the call that builds
    // and caches the engine session.
    await captureInitFrame({ wsUrl: api.wsUrl, sessionId: id });

    // Drive the (already-built, cached) session's sandbox to ready — exactly
    // what the first prompt turn does. The cache hit means the meta here is
    // ignored; provisioning runs the `prepareSandbox` hook wired at build time.
    const session = await api.providers.engineHost.sessionFor(id, {
      userId: "local-user",
      orgId: "local-org",
      workspace,
    });
    await session.attachment.ensureReady({ timeoutMs: 10_000 });

    // The clone ran → prepareSandbox was wired at build time despite the WS
    // route being the first touch.
    expect(
      provider.execs.some((c) => c.startsWith("git clone 'https://github.com/acme/widgets.git'")),
    ).toBe(true);
  });
});
