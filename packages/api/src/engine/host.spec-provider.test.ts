/**
 * Verifies that `EngineHost.buildSession` wires the correct `specProvider`
 * (sandbox-reconciliation plan, Task 6) for different session shapes.
 *
 * Tests drive sessions to `ready` via `ensureReady` so the engine calls the
 * specProvider closure and applies steps — recording sandbox providers capture
 * what exec sequences and image refs the closure produced.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  type ExecResult,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, imageSources, bakes, securityEngagements, securityCells } from "../schema/index.js";
import type { RepoBinding } from "../wire/types.js";

const ORG = "local-org";
const USER = "local-user";

// ── Recording sandbox ──────────────────────────────────────────────────────

class RecordingSandbox implements Sandbox {
  constructor(
    readonly id: string,
    readonly execs: string[],
    readonly creates: SandboxCreateOpts[],
  ) {}
  async readFile(): Promise<string> { return ""; }
  async readBinary(): Promise<Uint8Array> { return new Uint8Array(); }
  async writeFile(): Promise<void> {}
  async writeBinary(): Promise<void> {}
  async readdir(): Promise<string[]> { throw new Error("ENOENT"); }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    throw new Error("ENOENT"); // no .git present → fresh-clone path
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(command: string): Promise<ExecResult> {
    this.execs.push(command);
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async destroy(): Promise<void> {}
}

function makeIsolatedProvider(opts: { customImage?: boolean } = {}): SandboxProvider & {
  execs: string[];
  createCalls: SandboxCreateOpts[];
} {
  const execs: string[] = [];
  const createCalls: SandboxCreateOpts[] = [];
  let nextId = 1;
  const sandboxes = new Map<string, RecordingSandbox>();
  return {
    backend: "recording-isolated",
    execs,
    createCalls,
    capabilities(): SandboxCapabilities {
      return {
        snapshot: "none",
        persistentWorkspace: false,
        tunnels: false,
        warmPool: false,
        hibernation: false,
        isolated: true,
        customImage: opts.customImage ?? false,
      };
    },
    async create(o: SandboxCreateOpts): Promise<Sandbox> {
      createCalls.push(o);
      const id = `rec-${nextId++}`;
      const sb = new RecordingSandbox(id, execs, createCalls);
      sandboxes.set(id, sb);
      return sb;
    },
    async restore(id: string): Promise<Sandbox> {
      const sb = sandboxes.get(id);
      if (!sb) throw new Error(`not found: ${id}`);
      return sb;
    },
    async destroy(id: string): Promise<void> { sandboxes.delete(id); },
    async status(id: string): Promise<SandboxStatus> {
      return sandboxes.has(id)
        ? { id, state: "ready", startedAt: Date.now() }
        : { id, state: "released" };
    },
  };
}

function makeNonIsolatedProvider(): SandboxProvider & { execs: string[] } {
  const sandboxes = new Map<string, RecordingSandbox>();
  let nextId = 1;
  const execs: string[] = [];
  return {
    backend: "recording-non-isolated",
    execs,
    capabilities(): SandboxCapabilities {
      return {
        snapshot: "none",
        persistentWorkspace: false,
        tunnels: false,
        warmPool: false,
        hibernation: false,
        isolated: false,
        customImage: false,
      };
    },
    async create(o: SandboxCreateOpts): Promise<Sandbox> {
      const id = `non-iso-${nextId++}`;
      const sb = new RecordingSandbox(id, execs, []);
      sandboxes.set(id, sb);
      return sb;
    },
    async restore(id: string): Promise<Sandbox> {
      const sb = sandboxes.get(id);
      if (!sb) throw new Error(`not found: ${id}`);
      return sb;
    },
    async destroy(id: string): Promise<void> { sandboxes.delete(id); },
    async status(id: string): Promise<SandboxStatus> {
      return sandboxes.has(id)
        ? { id, state: "ready", startedAt: Date.now() }
        : { id, state: "released" };
    },
  };
}

async function insertSession(db: TestApi["providers"]["db"], sessionId: string): Promise<void> {
  const now = Date.now();
  await db.insert(agentSessions).values({
    id: sessionId,
    userId: USER,
    orgId: ORG,
    workspace: `/tmp/${sessionId}`,
    status: "active",
    ownerType: "user",
    ownerId: USER,
    profile: "headless",
    createdAt: now,
    updatedAt: now,
  });
}

const primaryBinding: RepoBinding & { targetDir: string } = {
  host: "github",
  fullName: "acme/widgets",
  cloneUrl: "https://github.com/acme/widgets.git",
  auth: "auto",
  targetDir: "widgets",
};

const secondaryBinding: RepoBinding & { targetDir: string } = {
  host: "github",
  fullName: "acme/gadgets",
  cloneUrl: "https://github.com/acme/gadgets.git",
  auth: "auto",
  targetDir: "gadgets",
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("EngineHost buildSpecProvider", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("unbound session on isolated provider runs credential-scripts and git-identity steps", async () => {
    const provider = makeIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const sessionId = "sp-unbound";
    await insertSession(api.providers.db, sessionId);

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: USER,
      orgId: ORG,
      workspace: `/tmp/${sessionId}`,
      // No repos → credential-only prep
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    // credential-scripts step: installs helper + gh shim, wires git config
    expect(provider.execs.some((c) => c.includes("git-credential-valet"))).toBe(true);
    expect(provider.execs.some((c) => c.includes("credential.useHttpPath"))).toBe(true);
    // git-identity step: sets user.name / user.email
    expect(provider.execs.some((c) => c.includes("user.name"))).toBe(true);
    expect(provider.execs.some((c) => c.includes("user.email"))).toBe(true);
    // no clones — no repo bindings
    expect(provider.execs.some((c) => c.startsWith("git clone"))).toBe(false);
  });

  it("repo session appends clone steps in position order", async () => {
    const provider = makeIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const sessionId = "sp-repos";
    await insertSession(api.providers.db, sessionId);

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: USER,
      orgId: ORG,
      workspace: `/tmp/${sessionId}`,
      repos: [primaryBinding, secondaryBinding],
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    // credential-scripts and git-identity steps ran first
    expect(provider.execs.some((c) => c.includes("git-credential-valet"))).toBe(true);
    expect(provider.execs.some((c) => c.includes("user.name"))).toBe(true);

    // clone steps ran, in position order: widgets then gadgets
    const clones = provider.execs.filter((c) => c.startsWith("git clone"));
    expect(clones.length).toBe(2);
    expect(clones[0]).toContain("acme/widgets.git");
    expect(clones[1]).toContain("acme/gadgets.git");
  });

  it("non-isolated provider returns no specProvider (no prep runs)", async () => {
    const provider = makeNonIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const sessionId = "sp-non-iso";
    await insertSession(api.providers.db, sessionId);

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: USER,
      orgId: ORG,
      workspace: `/tmp/${sessionId}`,
      // No repos: credential-only path that must skip when not isolated
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    // The sandbox came up successfully despite no spec-provider.
    expect(session.attachment.state).toBe("ready");

    // No git config or credential-install commands ran — the non-isolated
    // path skips all prep (buildSpecProvider returns undefined when
    // capabilities().isolated !== true).
    expect(provider.execs.some((c) => c.includes("git-credential-valet"))).toBe(false);
    expect(provider.execs.some((c) => c.includes("git config"))).toBe(false);
    expect(provider.execs).toHaveLength(0);
  });

  it("security persona cell appends the three scanner-bootstrap steps; a normal session does not", async () => {
    const provider = makeIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });
    const now = Date.now();

    // A normal repo session: no security cell claims it → no scanner steps.
    const normalId = "sp-normal";
    await insertSession(api.providers.db, normalId);
    const normal = await api.providers.engineHost.sessionFor(normalId, {
      userId: USER,
      orgId: ORG,
      workspace: `/tmp/${normalId}`,
      repos: [primaryBinding],
    });
    await normal.attachment.ensureReady({ timeoutMs: 5_000 });
    expect(provider.execs.some((c) => c.includes("sec-preflight"))).toBe(false);
    expect(provider.execs.some((c) => c.includes("gitleaks"))).toBe(false);
    expect(provider.execs.some((c) => c.includes("semgrep"))).toBe(false);

    // A security persona cell claims a second session as its dispatched child.
    const cellChildId = "sp-security-child";
    await insertSession(api.providers.db, cellChildId);
    await api.providers.db.insert(securityEngagements).values({
      id: "sp-eng-1",
      sessionId: "sp-eng-parent",
      status: "running",
      repoFullName: "acme/widgets",
      createdAt: now,
      updatedAt: now,
    });
    await api.providers.db.insert(securityCells).values({
      id: "sp-cell-1",
      engagementId: "sp-eng-1",
      ordinal: 1,
      persona: "code-review",
      goal: "review",
      dir: "01-review",
      status: "running",
      childSessionId: cellChildId,
      createdAt: now,
    });

    const cellSession = await api.providers.engineHost.sessionFor(cellChildId, {
      userId: USER,
      orgId: ORG,
      workspace: `/tmp/${cellChildId}`,
      repos: [primaryBinding],
    });
    await cellSession.attachment.ensureReady({ timeoutMs: 5_000 });

    // The three scanner-bootstrap steps ran on the persona cell sandbox.
    expect(provider.execs.some((c) => c.includes("/usr/local/bin/sec-preflight"))).toBe(true);
    expect(provider.execs.some((c) => c.includes("command -v gitleaks"))).toBe(true);
    expect(provider.execs.some((c) => c.includes("command -v semgrep"))).toBe(true);
  });

  it("repo session on isolated+customImage provider: newer pushed prebuild produces different image ref", async () => {
    const provider = makeIsolatedProvider({ customImage: true });
    api = await bootTestApi({ sandboxProvider: provider, defaultImage: "stock:img" });

    // Seed an image source + pushed bake.
    const now = Date.now();
    await api.providers.db.insert(imageSources).values({
      id: "sp-cfg1",
      orgId: ORG,
      kind: "repo",
      parentId: null,
      name: "acme/widgets",
      externalRef: null,
      pullSecretName: null,
      setupCommands: null,
      repoHost: "github",
      repoFullName: "acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
      schedule: "nightly",
      enabled: true,
      lastBoundAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await api.providers.db.insert(bakes).values({
      id: "sp-pb1",
      sourceId: "sp-cfg1",
      identityHash: "",
      commitSha: "sha1",
      imageRef: "valet-prebuild/acme-widgets:sha1",
      status: "pushed",
      builderBackend: "docker",
      recipe: { recipe: [], setup: [], image: undefined },
      error: null,
      logTail: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });

    const sessionId = "sp-prebuild";
    await insertSession(api.providers.db, sessionId);

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: USER,
      orgId: ORG,
      workspace: `/tmp/${sessionId}`,
      repos: [primaryBinding],
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    // The sandbox was created with the prebuild image, not the stock image.
    expect(provider.createCalls.length).toBeGreaterThan(0);
    expect(provider.createCalls[0].image).toBe("valet-prebuild/acme-widgets:sha1");
  });
});
