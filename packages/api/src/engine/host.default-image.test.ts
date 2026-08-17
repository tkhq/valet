/**
 * Final-review fix wave, Fix 1: `VALET_SANDBOX_IMAGE` was read for the
 * kubernetes backend only (`providers/sandbox-backend.ts`'s kubernetes
 * branch) and silently ignored for the docker backend — `EngineHost`'s
 * `defaultImage` was never wired from env in `providers/node.ts`, so every
 * docker-backend session got `DockerSandboxProvider`'s own
 * `node:20-bookworm` default regardless of what `VALET_SANDBOX_IMAGE` said.
 *
 * This test pins the seam end to end: `EngineHostOpts.defaultImage` (which
 * `providers/node.ts` now sets from `resolveDefaultImage(process.env)`,
 * see `providers/sandbox-backend.test.ts` for the pure-function pin) must
 * reach `SandboxCreateOpts.image` on the actual `SandboxProvider.create()`
 * call — proven here with a recording fake provider instead of a live
 * Docker daemon.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  VirtualSandbox,
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreateOpts,
  type SandboxProvider,
  type SandboxStatus,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";

/** Records every `SandboxCreateOpts` it's asked to create a sandbox with —
 * everything else delegates to `VirtualSandbox`/a trivial in-memory map,
 * mirroring `gateway-proxy.test.ts`'s `GatewayTestSandboxProvider`. */
class RecordingSandboxProvider implements SandboxProvider {
  readonly backend = "recording-test";
  readonly createCalls: SandboxCreateOpts[] = [];
  private sandboxes = new Map<string, VirtualSandbox>();
  private nextId = 1;

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

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls.push(opts);
    const id = `rec-${this.nextId++}`;
    const sb = new VirtualSandbox(id);
    this.sandboxes.set(id, sb);
    return sb;
  }

  async restore(id: string): Promise<Sandbox> {
    const sb = this.sandboxes.get(id);
    if (!sb) throw new Error(`recording sandbox not found: ${id}`);
    return sb;
  }

  async destroy(id: string): Promise<void> {
    const sb = this.sandboxes.get(id);
    if (sb) await sb.destroy?.();
    this.sandboxes.delete(id);
  }

  async status(id: string): Promise<SandboxStatus> {
    return this.sandboxes.has(id) ? { id, state: "ready", startedAt: Date.now() } : { id, state: "released" };
  }
}

describe("EngineHost defaultImage → SandboxCreateOpts.image", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("threads a pinned defaultImage through to the sandbox provider's create() call", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider, defaultImage: "ghcr.io/example/sandbox:full" });

    const sessionId = "default-image-pin";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-image-pin",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-image-pin",
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.length).toBeGreaterThan(0);
    for (const call of provider.createCalls) {
      expect(call.image).toBe("ghcr.io/example/sandbox:full");
    }
  });

  it("leaves SandboxCreateOpts.image undefined when no defaultImage is configured", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({ sandboxProvider: provider });

    const sessionId = "default-image-unset";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-image-unset",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-image-unset",
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.length).toBeGreaterThan(0);
    for (const call of provider.createCalls) {
      expect(call.image).toBeUndefined();
    }
  });

  // ── defaultImages: per-profile stock-image fallthrough (boot-window fix) ──

  it("full-profile session with no base bake uses defaultImages.full, not defaultImages.headless or defaultImage", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({
      sandboxProvider: provider,
      defaultImage: "ghcr.io/example/headless:fallback",
      defaultImages: {
        headless: "ghcr.io/example/headless:stock",
        full: "ghcr.io/example/full:stock",
      },
    });

    const sessionId = "default-images-full-boot-window";
    const now = Date.now();
    // Insert a full-profile session row (no base bake seeded → boot-window state).
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-full-boot-window",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "full",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-full-boot-window",
      profile: "full",
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.length).toBeGreaterThan(0);
    // Must boot the full stock image, NOT the headless or general defaultImage.
    expect(provider.createCalls[0]!.image).toBe("ghcr.io/example/full:stock");
    expect(provider.createCalls[0]!.image).not.toBe("ghcr.io/example/headless:stock");
    expect(provider.createCalls[0]!.image).not.toBe("ghcr.io/example/headless:fallback");
  });

  it("headless-profile session with no base bake uses defaultImages.headless", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({
      sandboxProvider: provider,
      defaultImage: "ghcr.io/example/headless:fallback",
      defaultImages: {
        headless: "ghcr.io/example/headless:stock",
        full: "ghcr.io/example/full:stock",
      },
    });

    const sessionId = "default-images-headless-boot-window";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-headless-boot-window",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-headless-boot-window",
      // profile defaults to headless when omitted
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.length).toBeGreaterThan(0);
    expect(provider.createCalls[0]!.image).toBe("ghcr.io/example/headless:stock");
  });

  it("docker session (headless profile) boots the full stock image — the headless stock has no docker toolchain", async () => {
    const provider = new RecordingSandboxProvider();
    api = await bootTestApi({
      sandboxProvider: provider,
      defaultImage: "ghcr.io/example/headless:fallback",
      defaultImages: {
        headless: "ghcr.io/example/headless:stock",
        full: "ghcr.io/example/full:stock",
      },
    });

    const sessionId = "default-images-docker-headless";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-docker-headless",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "headless",
      docker: true,
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-docker-headless",
      docker: true,
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.length).toBeGreaterThan(0);
    expect(provider.createCalls[0]!.image).toBe("ghcr.io/example/full:stock");
    // The docker flag itself still reaches the provider.
    expect(provider.createCalls[0]!.docker).toBe(true);
    // And the profile stays headless — only the image lineage changes.
    expect(provider.createCalls[0]!.profile).toBe("headless");
  });

  it("falls through to defaultImage when defaultImages is not set (backwards compat)", async () => {
    const provider = new RecordingSandboxProvider();
    // No defaultImages — only defaultImage set, same as before this fix.
    api = await bootTestApi({
      sandboxProvider: provider,
      defaultImage: "ghcr.io/example/legacy:stock",
    });

    const sessionId = "default-images-absent";
    const now = Date.now();
    await api.providers.db.insert(agentSessions).values({
      id: sessionId,
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-absent",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "full",
      createdAt: now,
      updatedAt: now,
    });

    const session = await api.providers.engineHost.sessionFor(sessionId, {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/default-images-absent",
      profile: "full",
    });
    await session.attachment.ensureReady({ timeoutMs: 5_000 });

    expect(provider.createCalls.length).toBeGreaterThan(0);
    // No defaultImages → falls through to defaultImage.
    expect(provider.createCalls[0]!.image).toBe("ghcr.io/example/legacy:stock");
  });
});
