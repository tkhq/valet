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
    return { snapshot: "none", persistentWorkspace: false, tunnels: false, warmPool: false, coldStartEstimateMs: 0 };
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
});
