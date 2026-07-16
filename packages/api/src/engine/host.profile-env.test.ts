/**
 * Task 5 (sandbox auth gateway plan): `EngineHost.mintSandboxEnv` gains a
 * `profile` param and emits two more env keys — `VALET_SESSION_ID` (must
 * equal the session id the sandbox JWT's `sid` claim carries, since the
 * gateway enforces `sid === VALET_SESSION_ID`) and `VALET_SANDBOX_PROFILE`
 * — alongside the three pre-existing keys, byte-identical.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  VirtualSandboxProvider,
  type Sandbox,
  type SandboxCreateOpts,
  type SandboxProvider,
} from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { deriveSandboxJwtSecret } from "../auth/sandbox-tokens.js";
import { internalToken } from "../lib/internal-auth.js";

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

async function warmAndWait(session: { attachment: { state: string; warm(): void } }): Promise<void> {
  session.attachment.warm();
  const deadline = Date.now() + 2000;
  while (session.attachment.state !== "ready") {
    if (Date.now() > deadline) throw new Error(`sandbox attachment never became ready (state=${session.attachment.state})`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("EngineHost.mintSandboxEnv profile wiring", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("defaults to headless profile and includes VALET_SESSION_ID == sessionId", async () => {
    const recorder = new RecordingSandboxProvider(new VirtualSandboxProvider());
    api = await bootTestApi({ sandboxProvider: recorder });
    const { engineHost } = api.providers;

    const session = await engineHost.sessionFor("profile-session-headless", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/profile-session-headless",
    });
    await warmAndWait(session);

    const env = recorder.createCalls[0].env;
    expect(env).toBeDefined();
    // Byte-identical pin on the three pre-existing keys.
    expect(env?.VALET_SANDBOX_TOKEN).toMatch(/^st_[0-9a-f]{48}$/);
    expect(env?.VALET_API_URL).toBe("http://localhost:8788");
    expect(env?.VALET_SANDBOX_JWT_SECRET).toBe(
      deriveSandboxJwtSecret(internalToken(), "profile-session-headless"),
    );
    // New keys.
    expect(env?.VALET_SESSION_ID).toBe("profile-session-headless");
    expect(env?.VALET_SANDBOX_PROFILE).toBe("headless");
  });

  it("threads profile: 'full' from the session row through to the sandbox env", async () => {
    const recorder = new RecordingSandboxProvider(new VirtualSandboxProvider());
    api = await bootTestApi({ sandboxProvider: recorder });
    const { engineHost, db } = api.providers;
    const { agentSessions } = await import("../schema/index.js");

    const now = Date.now();
    await db.insert(agentSessions).values({
      id: "profile-session-full",
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/profile-session-full",
      status: "active",
      ownerType: "user",
      ownerId: "local-user",
      profile: "full",
      createdAt: now,
      updatedAt: now,
    });

    const session = await engineHost.sessionFor("profile-session-full", {
      userId: "local-user",
      orgId: "local-org",
      workspace: "/tmp/profile-session-full",
      profile: "full",
    });
    await warmAndWait(session);

    const env = recorder.createCalls[0].env;
    expect(env?.VALET_SESSION_ID).toBe("profile-session-full");
    expect(env?.VALET_SANDBOX_PROFILE).toBe("full");
  });
});
