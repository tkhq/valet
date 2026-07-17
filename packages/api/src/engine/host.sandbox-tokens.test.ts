/**
 * Task 8 (auth-v2 plan): sandbox provisioning must mint a per-session
 * sandbox token + derive a per-session JWT secret and hand both (plus the
 * api's base URL) to the sandbox provider as env vars. Session teardown
 * (`EngineHost.destroy`) must revoke the session's live tokens.
 *
 * Uses a recording wrapper around `VirtualSandboxProvider` so we can assert
 * on the `env` the provider's `create()` actually received, without needing
 * Docker.
 */
import { describe, it, expect, afterEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  VirtualSandboxProvider,
  type Sandbox,
  type SandboxCreateOpts,
  type SandboxProvider,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { deriveSandboxJwtSecret } from "../auth/sandbox-tokens.js";
import { internalToken } from "../lib/internal-auth.js";
import { sandboxTokens } from "../schema/index.js";

/** Wraps a real `SandboxProvider`, recording every `create()` call's opts. */
class RecordingSandboxProvider implements SandboxProvider {
  readonly backend: string;
  createCalls: SandboxCreateOpts[] = [];
  private readonly inner: SandboxProvider;

  constructor(inner: SandboxProvider) {
    this.inner = inner;
    this.backend = inner.backend;
  }

  capabilities() {
    return this.inner.capabilities();
  }

  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.createCalls.push(opts);
    return this.inner.create(opts);
  }

  restore(id: string): Promise<Sandbox> {
    return this.inner.restore(id);
  }

  destroy(id: string): Promise<void> {
    return this.inner.destroy(id);
  }

  status(id: string) {
    return this.inner.status(id);
  }
}

/** Waits until the session's sandbox attachment reaches `ready`, kicking
 * provisioning via `warm()`. Bounded so a stuck attachment fails fast. */
async function warmAndWait(session: { attachment: { state: string; warm(): void } }): Promise<void> {
  session.attachment.warm();
  const deadline = Date.now() + 2000;
  while (session.attachment.state !== "ready") {
    if (Date.now() > deadline) throw new Error(`sandbox attachment never became ready (state=${session.attachment.state})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("EngineHost sandbox token wiring", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("provisioning a session's sandbox mints a token row and injects the three env vars", async () => {
    const recorder = new RecordingSandboxProvider(new VirtualSandboxProvider());
    api = await bootTestApi({ sandboxProvider: recorder });
    const { engineHost, db } = api.providers;

    const session = await engineHost.sessionFor("sbtok-session-1", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/sbtok-session-1",
    });

    await warmAndWait(session);

    expect(recorder.createCalls.length).toBe(1);
    const env = recorder.createCalls[0].env;
    expect(env).toBeDefined();
    expect(env?.VALET_SANDBOX_TOKEN).toMatch(/^st_[0-9a-f]{48}$/);
    expect(env?.VALET_API_URL).toBe("http://localhost:8788");
    expect(env?.VALET_SANDBOX_JWT_SECRET).toBe(
      deriveSandboxJwtSecret(internalToken(), "sbtok-session-1"),
    );

    const rows = await db
      .select()
      .from(sandboxTokens)
      .where(and(eq(sandboxTokens.sessionId, "sbtok-session-1"), isNull(sandboxTokens.revokedAt)))
      .limit(1);
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.userId).toBe("local-user");
    expect(row?.orgId).toBe("local-org");
  });

  it("destroy() revokes the session's live sandbox tokens", async () => {
    const recorder = new RecordingSandboxProvider(new VirtualSandboxProvider());
    api = await bootTestApi({ sandboxProvider: recorder });
    const { engineHost, db } = api.providers;

    const session = await engineHost.sessionFor("sbtok-session-2", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/sbtok-session-2",
    });
    await warmAndWait(session);

    const before = await db
      .select()
      .from(sandboxTokens)
      .where(eq(sandboxTokens.sessionId, "sbtok-session-2"));
    expect(before.length).toBe(1);
    expect(before[0].revokedAt).toBeNull();

    await engineHost.destroy("sbtok-session-2");

    const after = await db
      .select()
      .from(sandboxTokens)
      .where(eq(sandboxTokens.sessionId, "sbtok-session-2"));
    expect(after.length).toBe(1);
    expect(after[0].revokedAt).not.toBeNull();
  });

  it("restore mints an ADDITIONAL token, leaving the pre-rebuild one live (rebuild-safe)", async () => {
    // Final-review fix wave: a rebuild on a cache miss must NOT revoke the
    // token a still-running sandbox is holding, or its git credential helper
    // 401s until pod recreation. So a rebuild mints a new token and the prior
    // one stays live (bounded only by its natural 24h TTL); explicit
    // revocation is reserved for `destroy()`.
    const recorder = new RecordingSandboxProvider(new VirtualSandboxProvider());
    api = await bootTestApi({ sandboxProvider: recorder });
    const { engineHost, db } = api.providers;

    const first = await engineHost.sessionFor("sbtok-session-3", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/sbtok-session-3",
    });
    await warmAndWait(first);
    const firstToken = recorder.createCalls[0].env?.VALET_SANDBOX_TOKEN;

    // Evict the in-process cache (not destroy) so the next `sessionFor` call
    // goes through the restore branch of `buildSession` against the same
    // durable session row.
    engineHost.evictCache("sbtok-session-3");

    const restored = await engineHost.sessionFor("sbtok-session-3", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/sbtok-session-3",
    });
    await warmAndWait(restored);
    const secondToken = recorder.createCalls[1].env?.VALET_SANDBOX_TOKEN;

    expect(secondToken).toBeDefined();
    expect(secondToken).not.toBe(firstToken);

    const rows = await db
      .select()
      .from(sandboxTokens)
      .where(eq(sandboxTokens.sessionId, "sbtok-session-3"));
    expect(rows.length).toBe(2);
    // Both tokens are live — the rebuild revoked nothing.
    const live = rows.filter((r) => r.revokedAt === null);
    expect(live.length).toBe(2);
  });
});
