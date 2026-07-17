/**
 * Session-create prebuild resolution end-to-end at the `EngineHost` seam
 * (sandbox images v2 plan, Task 4, spec decisions 1/8). Proves the resolved
 * prebuilt image ref reaches `SandboxCreateOpts.image` on the real provider
 * `create()` call and that `agent_sessions.prebuild_id` is persisted — using a
 * recording fake provider (customImage: true) whose sandbox tolerates the
 * fetch-on-start prep exec sequence, so no Docker daemon is involved.
 *
 * The stock-fallback matrix (disabled config, capability-false, none/failed
 * prebuild, unbound session) is pinned directly on `resolvePrebuildImage` in
 * `resolve.test.ts`; here we pin only the wiring that test can't see.
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
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, prebuildConfigs, prebuilds } from "../schema/index.js";
import type { RepoBinding } from "../wire/types.js";

/** Minimal `Sandbox` that returns success for every exec and no-ops the fs
 * writes workspace prep performs, so `prepareSandbox` completes without a real
 * container. `stat` always throws → prep takes the cold (stage-from-image)
 * path. */
class PrepFriendlySandbox implements Sandbox {
  constructor(readonly id: string) {}
  async readFile(): Promise<string> {
    return "";
  }
  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async writeFile(): Promise<void> {}
  async writeBinary(): Promise<void> {}
  async readdir(): Promise<string[]> {
    return [];
  }
  async stat(): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    throw new Error("ENOENT");
  }
  async mkdir(): Promise<void> {}
  async rm(): Promise<void> {}
  async exec(): Promise<ExecResult> {
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  async destroy(): Promise<void> {}
}

class RecordingSandboxProvider implements SandboxProvider {
  readonly backend = "recording-test";
  readonly createCalls: SandboxCreateOpts[] = [];
  private sandboxes = new Map<string, PrepFriendlySandbox>();
  private nextId = 1;

  capabilities(): SandboxCapabilities {
    return {
      snapshot: "none",
      persistentWorkspace: true,
      tunnels: false,
      warmPool: false,
      hibernation: false,
      customImage: true,
    };
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls.push(opts);
    const id = `rec-${this.nextId++}`;
    const sb = new PrepFriendlySandbox(id);
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

const ORG = "local-org";
const REPO = "acme/widgets";
const IMAGE_REF = "valet-prebuild/acme-widgets:sha1";

describe("EngineHost prebuild resolution at session create", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  async function seedPrebuild(db: TestApi["providers"]["db"], enabled = true): Promise<void> {
    const now = Date.now();
    await db.insert(prebuildConfigs).values({
      id: "cfg1",
      orgId: ORG,
      repoHost: "github",
      repoFullName: REPO,
      cloneUrl: "https://github.com/acme/widgets.git",
      schedule: "nightly",
      enabled,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(prebuilds).values({
      id: "pb1",
      configId: "cfg1",
      commitSha: "sha1",
      imageRef: IMAGE_REF,
      status: "pushed",
      builderBackend: "docker",
      recipe: { recipe: [], setup: [], image: undefined },
      error: null,
      logTail: null,
      startedAt: now,
      finishedAt: now,
      createdAt: now,
    });
  }

  const primary: RepoBinding = {
    host: "github",
    fullName: REPO,
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
  };

  it("boots the sandbox from the pushed prebuild image and persists prebuild_id", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider, defaultImage: "stock:img" });
    await seedPrebuild(api.providers.db);

    const sessionId = "pb-resolve";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: ORG,
      workspace: "/tmp/pb-resolve",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: ORG,
      workspace: "/tmp/pb-resolve",
      repos: [primary],
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.length).toBeGreaterThan(0);
    for (const call of provider.createCalls) {
      expect(call.image).toBe(IMAGE_REF);
    }
    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    expect(rows[0]?.prebuildId).toBe("pb1");
  });

  it("falls back to the stock image (and leaves prebuild_id null) when the config is disabled", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider, defaultImage: "stock:img" });
    await seedPrebuild(api.providers.db, false);

    const sessionId = "pb-disabled";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: ORG,
      workspace: "/tmp/pb-disabled",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: ORG,
      workspace: "/tmp/pb-disabled",
      repos: [primary],
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    for (const call of provider.createCalls) {
      expect(call.image).toBe("stock:img");
    }
    const rows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId));
    expect(rows[0]?.prebuildId ?? null).toBeNull();
  });
});
