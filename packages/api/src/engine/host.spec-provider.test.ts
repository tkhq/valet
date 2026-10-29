/**
 * Verifies that `EngineHost.buildSession` and `buildWorkflowSession` wire the
 * correct `specProvider` (sandbox-reconciliation plan, Task 6) for different
 * session shapes.
 *
 * Tests drive sessions to `ready` via `ensureReady` so the engine calls the
 * specProvider closure and applies steps — recording sandbox providers capture
 * what exec sequences and image refs the closure produced.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  type ExecResult,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, imageSources, bakes, securityEngagements, securityCells, sessionRepos } from "../schema/index.js";
import type { RepoBinding } from "../wire/types.js";
import type { ImageFallbackEvent } from "../prebuilds/resolve.js";
import { clearRepoPrebuildFlagsCache } from "../bakes/source-service.js";
import { deriveSecretKey } from "../lib/secret-crypto.js";
import { BLOCKING_ITEMS_RULE } from "../services/security-engagements.js";
import { contentsBody, startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";

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

function makeIsolatedProvider(opts: { customImage?: boolean; backend?: string } = {}): SandboxProvider & {
  execs: string[];
  createCalls: SandboxCreateOpts[];
} {
  const execs: string[] = [];
  const createCalls: SandboxCreateOpts[] = [];
  let nextId = 1;
  const sandboxes = new Map<string, RecordingSandbox>();
  return {
    backend: opts.backend ?? "recording-isolated",
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

async function insertSession(
  db: TestApi["providers"]["db"],
  sessionId: string,
  repo?: RepoBinding & { targetDir: string },
): Promise<void> {
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
  if (repo) {
    await db.insert(sessionRepos).values({
      sessionId,
      host: repo.host ?? "github",
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      ref: repo.ref ?? null,
      auth: repo.auth ?? "auto",
      position: 0,
      targetDir: repo.targetDir,
    });
  }
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
  let fixture: GithubFixture | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
    await fixture?.close();
    fixture = undefined;
    clearRepoPrebuildFlagsCache();
    vi.restoreAllMocks();
  });

  it("refreshes authoritative resources and omits an opinion after a read error", async () => {
    clearRepoPrebuildFlagsCache();
    let prebuildYaml = "resources:\n  cpu: 2\n  memory: 4Gi\n";
    fixture = startGithubFixture({
      getContents: (_owner, _repo, path) => {
        if (path !== ".valet/prebuild.yaml") return { status: 404, body: { message: "Not Found" } };
        if (prebuildYaml === "invalid") return contentsBody("resources:\n  cpu: nope\n", "bad-blob");
        return contentsBody(prebuildYaml, "resource-blob");
      },
    });
    const provider = makeIsolatedProvider();
    api = await bootTestApi({
      sandboxProvider: provider,
      githubTokenDeps: {
        key: deriveSecretKey("test-key"),
        apiUrl: fixture.url,
        githubUrl: fixture.url,
      },
    });
    const sessionId = "sp-resource-refresh";
    await insertSession(api.providers.db, sessionId, primaryBinding);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: USER,
      orgId: ORG,
      workspace: `/tmp/${sessionId}`,
      repos: [primaryBinding],
    });
    const specProvider = session.options.specProvider;
    expect(specProvider).toBeDefined();

    const initial = await specProvider!();
    expect(initial.resources).toEqual({ cpu: 2, memory: "4Gi" });

    now += 10 * 60 * 1_000 + 1;
    prebuildYaml = "resources:\n  cpu: 4\n  memory: 8Gi\n";
    const changed = await specProvider!();
    expect(changed.resources).toEqual({ cpu: 4, memory: "8Gi" });
    expect(changed.specHash).not.toBe(initial.specHash);

    now += 10 * 60 * 1_000 + 1;
    prebuildYaml = "invalid";
    const failed = await specProvider!();
    expect(failed.resources).toBeUndefined();
    expect(failed.preserveResourceFields).toEqual(["cpu", "memory", "scratch"]);
  });

  it("reads disabled repository defaults on every invocation while YAML remains cached", async () => {
    clearRepoPrebuildFlagsCache();
    let reads = 0;
    fixture = startGithubFixture({
      getContents: (_owner, _repo, path) => {
        if (path !== ".valet/prebuild.yaml") return { status: 404, body: { message: "Not Found" } };
        reads += 1;
        return contentsBody("resources:\n  memory: 8Gi\n", "resource-memory");
      },
    });
    api = await bootTestApi({
      sandboxProvider: makeIsolatedProvider(),
      githubTokenDeps: { key: deriveSecretKey("test-key"), apiUrl: fixture.url, githubUrl: fixture.url },
    });
    const { db, engineHost } = api.providers;
    await db.insert(imageSources).values({
      id: "saved-defaults", orgId: ORG, kind: "repo", name: "acme/widgets",
      repoHost: "github", repoFullName: "acme/widgets", enabled: false,
      sandboxResources: { cpu: 2, memory: "4Gi" }, createdAt: Date.now(), updatedAt: Date.now(),
    });
    const sessionId = "sp-saved-resources";
    await insertSession(db, sessionId, primaryBinding);
    const session = await engineHost.sessionFor(sessionId, {
      userId: USER, orgId: ORG, workspace: `/tmp/${sessionId}`, repos: [primaryBinding],
    });
    const first = await session.options.specProvider!();
    expect(first.resources).toEqual({ cpu: 2, memory: "8Gi" });
    const cachedReads = reads;
    await db.update(imageSources).set({ sandboxResources: { cpu: 4, memory: "16Gi" } }).where(eq(imageSources.id, "saved-defaults"));
    const changed = await session.options.specProvider!();
    expect(changed.resources).toEqual({ cpu: 4, memory: "8Gi" });
    expect(changed.specHash).not.toBe(first.specHash);
    expect(reads).toBe(cachedReads);
    await db.update(imageSources).set({ sandboxResources: null }).where(eq(imageSources.id, "saved-defaults"));
    expect((await session.options.specProvider!()).resources).toEqual({ memory: "8Gi" });
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
    // A rebuilt persona cell keeps the child rules and the blocking-items
    // override on every turn; a normal session gets neither.
    expect(cellSession.options.systemPrompt).toContain("## Questions");
    expect(cellSession.options.systemPrompt).toContain(BLOCKING_ITEMS_RULE);
    expect(normal.options.systemPrompt).not.toContain("## Questions");
    expect(normal.options.systemPrompt).not.toContain(BLOCKING_ITEMS_RULE);
  });

  it("an incompatible repo bake records agent_sessions.image_fallback, calls the handler once, and clears on a compatible bake", async () => {
    // Same in-memory harness as image-fallback-metrics.test.ts. The counter
    // binds to the global provider on its first use, which is in this test.
    metrics.disable();
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const meterProvider = new MeterProvider({
      readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })],
    });
    metrics.setGlobalMeterProvider(meterProvider);
    const fallbackCount = async (): Promise<number> => {
      await meterProvider.forceFlush();
      const metric = exporter.getMetrics()
        .flatMap((resource) => resource.scopeMetrics)
        .flatMap((scope) => scope.metrics)
        .filter((candidate) => candidate.descriptor.name === "valet.sandbox.image_fallback")
        .at(-1);
      if (!metric || metric.dataPointType !== DataPointType.SUM) throw new Error("expected a counter metric");
      return metric.dataPoints.reduce((sum, point) => sum + point.value, 0);
    };
    try {
      const provider = makeIsolatedProvider({ customImage: true, backend: "kubernetes" });
      api = await bootTestApi({ sandboxProvider: provider, defaultImage: "stock:img" });
      const events: ImageFallbackEvent[] = [];
      api.providers.engineHost.setImageFallbackHandler(async (e) => { events.push(e); });

      const now = Date.now();
      await api.providers.db.insert(imageSources).values({
        id: "fb-cfg1", orgId: ORG, kind: "repo", parentId: null, name: "acme/widgets", externalRef: null, pullSecretName: null,
        setupCommands: null, repoHost: "github", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git",
        schedule: "nightly", enabled: true, lastBoundAt: null, createdAt: now, updatedAt: now,
      });
      const bakeRow = (id: string, createdAt: number, contract: { contractVersion: number | null; contractSource: "label" | "missing" | "override" | null }) => ({
        id, sourceId: "fb-cfg1", identityHash: "", commitSha: "sha1", imageRef: `valet-prebuild/acme-widgets:${id}`, status: "pushed" as const,
        builderBackend: "kubernetes", recipe: { recipe: [], setup: [], image: undefined }, error: null, logTail: null,
        startedAt: createdAt, finishedAt: createdAt, createdAt, ...contract,
      });
      await api.providers.db.insert(bakes).values(bakeRow("pb-bad", now, { contractVersion: 0, contractSource: "missing" }));

      const sessionId = "fb-session";
      await insertSession(api.providers.db, sessionId);
      const meta = { userId: USER, orgId: ORG, workspace: `/tmp/${sessionId}`, repos: [primaryBinding] };
      const session = await api.providers.engineHost.sessionFor(sessionId, meta);
      await session.attachment.ensureReady({ timeoutMs: 5_000 });

      // Stock image, not the bad bake; fallback recorded; handler called once.
      expect(provider.createCalls[0].image).toBe("stock:img");
      const row = (await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0];
      expect(row.imageFallback).toMatchObject({ reason: "contract", sourceId: "fb-cfg1", bakeId: "pb-bad" });
      expect(events).toEqual([expect.objectContaining({ sessionId, sourceId: "fb-cfg1", bakeId: "pb-bad", contract: 0, repoFullName: "acme/widgets" })]);

      // Re-evaluating while the bake is still bad stamps and counts nothing new.
      const firstAt = (row.imageFallback as { at: number }).at;
      expect(await fallbackCount()).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      await session.options.specProvider!();
      const again = (await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0];
      expect((again.imageFallback as { at: number }).at).toBe(firstAt);
      expect(await fallbackCount()).toBe(1);
      // The handler stays unconditional (workflow sessions have no row); the
      // source service dedupes on its side.
      expect(events).toHaveLength(2);

      // A compatible bake lands. Re-evaluating the spec provider (the same
      // closure a reconcile sweep runs) clears the fallback and picks the bake.
      await api.providers.db.insert(bakes).values(bakeRow("pb-good", now + 1000, { contractVersion: 3, contractSource: "label" }));
      const desired = await session.options.specProvider!();
      expect(desired.image).toBe("valet-prebuild/acme-widgets:pb-good");
      const cleared = (await api.providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)))[0];
      expect(cleared.imageFallback).toBeNull();
      expect(events).toHaveLength(2);
    } finally {
      await meterProvider.shutdown();
      metrics.disable();
    }
  });

  describe("startup warning", () => {
    async function seed(bakeIds: Array<{ id: string; contractVersion: number; contractSource: "label" | "missing" }>) {
      const provider = makeIsolatedProvider({ customImage: true, backend: "kubernetes" });
      api = await bootTestApi({ sandboxProvider: provider, defaultImage: "stock:img" });
      const now = Date.now();
      await api.providers.db.insert(imageSources).values({
        id: "fb-cfg1", orgId: ORG, kind: "repo", parentId: null, name: "acme/widgets", externalRef: null, pullSecretName: null,
        setupCommands: null, repoHost: "github", repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git",
        schedule: "nightly", enabled: true, lastBoundAt: null, createdAt: now, updatedAt: now,
      });
      for (const [i, b] of bakeIds.entries()) {
        await api.providers.db.insert(bakes).values({
          id: b.id, sourceId: "fb-cfg1", identityHash: "", commitSha: "sha1", imageRef: `valet-prebuild/acme-widgets:${b.id}`, status: "pushed" as const,
          builderBackend: "kubernetes", recipe: { recipe: [], setup: [], image: undefined }, error: null, logTail: null,
          startedAt: now + i, finishedAt: now + i, createdAt: now + i, contractVersion: b.contractVersion, contractSource: b.contractSource,
        });
      }
      const sessionId = "fb-warn-session";
      await insertSession(api.providers.db, sessionId);
      const meta = { userId: USER, orgId: ORG, workspace: `/tmp/${sessionId}`, repos: [primaryBinding] };
      return { sessionId, meta, host: api.providers.engineHost };
    }
    const noteCount = async (sessionId: string, threadId: string) =>
      ((await api!.providers.engineStore.getThreadSnapshot(sessionId, threadId))?.entries ?? [])
        .filter((e) => e.type === "message" && e.role === "system" && String(e.content).includes("failed its compatibility check")).length;

    it("a session that falls back gets the startup warning in its system prompt and one thread note", async () => {
      const { sessionId, meta, host } = await seed([{ id: "pb-bad", contractVersion: 0, contractSource: "missing" }]);
      const session = await host.sessionFor(sessionId, meta);
      await session.attachment.ensureReady({ timeoutMs: 5_000 });
      const prompt = session.options.systemPrompt ?? "";
      expect(prompt).toContain("## Startup warning");
      expect(prompt).toContain("Prebuilt dependencies for `acme/widgets` are unavailable right now because the repo image is being rebuilt.");
      const thread = await session.createThread("web:default");
      expect(await noteCount(sessionId, thread.id)).toBe(1);
      // A rebuild of the same session does not add a second note.
      await host.invalidateSession(sessionId);
      const again = await host.sessionFor(sessionId, meta);
      await again.attachment.ensureReady({ timeoutMs: 5_000 });
      expect(again).not.toBe(session);
      expect(again.options.systemPrompt ?? "").toContain("## Startup warning");
      expect(await noteCount(sessionId, thread.id)).toBe(1);
    });

    it("a session whose repo bake is compatible has no startup warning", async () => {
      const { sessionId, meta, host } = await seed([{ id: "pb-good", contractVersion: 3, contractSource: "label" }]);
      const session = await host.sessionFor(sessionId, meta);
      await session.attachment.ensureReady({ timeoutMs: 5_000 });
      expect(session.options.systemPrompt ?? "").not.toContain("## Startup warning");
    });
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

  it("workflow sessions run credential-only prep on an isolated provider", async () => {
    const provider = makeIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    // The shape a scheduled team run builds: no app row, no repo bindings,
    // and a synthesized `team:<id>` actor (workflows/engine-deps.ts).
    const session = await api.providers.engineHost.workflowSessionFor("wf:wfrun_prep:sync", {
      actorUserId: "team:team-1",
      orgId: ORG,
      owner: { type: "team", id: "team-1" },
      workspace: "/tmp/wf-prep-sync",
    });
    expect(session.options.specProvider).toBeDefined();

    await session.attachment.ensureReady({ timeoutMs: 5_000 });
    expect(session.attachment.state).toBe("ready");

    // The credential helper, its hard prerequisite, and the generic git
    // identity are installed so `git push` authenticates; nothing clones.
    expect(provider.execs).toContain("git config --global credential.helper '/usr/local/bin/git-credential-valet'");
    expect(provider.execs).toContain("git config --global credential.useHttpPath true");
    expect(provider.execs).toContain("git config --global user.name 'Valet Agent'");
    expect(provider.execs).toContain("git config --global user.email 'agent@valet.local'");
    expect(provider.execs.some((c) => c.includes("git clone"))).toBe(false);
    // Prep installed valet-secrets, so the prompt names it.
    expect(session.options.systemPrompt).toContain("valet-secrets run");
  });

  it("a team run a member started commits under the generic identity, not the member's", async () => {
    const provider = makeIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    // A manual run of a team-owned workflow carries the member who clicked
    // Run as its actor. The identity follows the owner.
    const session = await api.providers.engineHost.workflowSessionFor("wf:wfrun_manual:sync", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "team", id: "team-1" },
      workspace: "/tmp/wf-manual-sync",
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.execs).toContain("git config --global user.name 'Valet Agent'");
    expect(provider.execs).toContain("git config --global user.email 'agent@valet.local'");
    expect(provider.execs.some((c) => c.includes("local@dev") || c.includes("Local Dev"))).toBe(false);
  });

  it("a user-owned workflow run commits under its owner's identity", async () => {
    const provider = makeIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const session = await api.providers.engineHost.workflowSessionFor("wf:wfrun_user:sync", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp/wf-user-sync",
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.execs).toContain("git config --global user.name 'Local Dev'");
    expect(provider.execs).toContain("git config --global user.email 'local@dev'");
  });

  it("a workflow session's spec provider writes nothing to agent_sessions", async () => {
    api = await bootTestApi({ sandboxProvider: makeIsolatedProvider() });
    const session = await api.providers.engineHost.workflowSessionFor("wf:wfrun_noflags:sync", {
      actorUserId: "team:team-1",
      orgId: ORG,
      owner: { type: "team", id: "team-1" },
      workspace: "/tmp/wf-noflags-sync",
    });
    // A workflow session has no row and no repository, so the repo-flag
    // read must not issue its UPDATE: the write could only fail provisioning.
    const update = vi.spyOn(api.providers.db, "update");

    await session.options.specProvider!();

    expect(update.mock.calls.some(([table]) => table === agentSessions)).toBe(false);
  });

  it("workflow sessions skip prep on a non-isolated provider", async () => {
    const provider = makeNonIsolatedProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const session = await api.providers.engineHost.workflowSessionFor("wf:wfrun_noprep:sync", {
      actorUserId: USER,
      orgId: ORG,
      owner: { type: "user", id: USER },
      workspace: "/tmp/wf-noprep-sync",
    });
    expect(session.options.specProvider).toBeUndefined();
    expect(session.options.systemPrompt).toContain("This sandbox has no secrets command.");

    await session.attachment.ensureReady({ timeoutMs: 5_000 });
    expect(session.attachment.state).toBe("ready");
    expect(provider.execs).toHaveLength(0);
  });
});

describe("imageFallbackPrompt", () => {
  it("renders the spec 7.2 paragraph and nothing when there is no fallback", async () => {
    const { imageFallbackPrompt } = await import("./host.js");
    expect(imageFallbackPrompt(undefined)).toBe("");
    expect(imageFallbackPrompt("acme/widgets")).toBe(
      "\n\n## Startup warning\n\nPrebuilt dependencies for `acme/widgets` are unavailable right now because the repo image is being rebuilt. The workspace is checked out; install what you need.",
    );
  });
});
