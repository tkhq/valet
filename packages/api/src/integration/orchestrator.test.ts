/**
 * Integration test: orchestrator lifecycle (Phase 4 Task 7).
 *
 *   - POST /api/orchestrator is idempotent: two calls, one engine session
 *     row, one `orchestrator_identities` row.
 *   - GET /api/orchestrator probes without creating.
 *   - The ensured session is `queueMode: 'steer'` (user principal, decision
 *     17) and its `systemContext` carries the assembled memory snapshot —
 *     asserted via `Session.options` (a public field on the engine's own
 *     `Session`), not by driving a real LLM turn.
 *   - Key-gated (real Anthropic + a create-counting sandbox provider): the
 *     orchestrator answers a prompt with ZERO `sandboxProvider.create` calls
 *     — proves the sandbox-less wake.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { VirtualSandboxProvider, type Sandbox, type SandboxCreateOpts, type SandboxProvider } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import { driveTurn } from "./_test-utils.js";
import { internalToken } from "../lib/internal-auth.js";
import { agentSessions, orchestratorIdentities } from "../schema/index.js";
import type { EnsureOrchestratorResponse, GetOrchestratorResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("api integration: orchestrator lifecycle", () => {
  it("GET /api/orchestrator before any ensure reports exists: false", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/orchestrator`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetOrchestratorResponse;
    expect(body.exists).toBe(false);
    expect(body.sessionId).toBe("orchestrator:user:local-user");
  });

  it("POST /api/orchestrator is idempotent — two calls, one session row, one identity row", async () => {
    api = await bootTestApi();

    const first = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as EnsureOrchestratorResponse;
    expect(firstBody.sessionId).toBe("orchestrator:user:local-user");

    const second = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as EnsureOrchestratorResponse;
    expect(secondBody.sessionId).toBe(firstBody.sessionId);

    const { db } = api.providers;
    const sessionRows = await db.select().from(agentSessions).where(eq(agentSessions.id, firstBody.sessionId)).all();
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.title).toBe("Assistant");
    expect(sessionRows[0]?.ownerType).toBe("user");
    expect(sessionRows[0]?.ownerId).toBe("local-user");

    const identityRows = await db
      .select()
      .from(orchestratorIdentities)
      .where(eq(orchestratorIdentities.sessionId, firstBody.sessionId))
      .all();
    expect(identityRows).toHaveLength(1);

    const probe = await fetch(`${api.baseUrl}/api/orchestrator`);
    const probeBody = (await probe.json()) as GetOrchestratorResponse;
    expect(probeBody.exists).toBe(true);
    expect(probeBody.sessionId).toBe(firstBody.sessionId);
  });

  it("ensured session is queueMode 'steer' with the memory snapshot in systemContext", async () => {
    api = await bootTestApi();

    // Seed a pinned memory file before ensuring the orchestrator, so the
    // snapshot fragment isn't just the empty-memory default — proves the
    // real assembleMemorySnapshot ran, not a stub.
    const writeRes = await fetch(`${api.baseUrl}/api/memory`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-valet-internal": internalToken(),
        "x-valet-owner": "user:local-user",
        "x-valet-actor": "local-user",
      },
      body: JSON.stringify({
        path: "preferences/tone.md",
        content: "Keep replies terse and direct.",
        pinned: true,
      }),
    });
    expect(writeRes.status).toBe(200);

    const ensureRes = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
    const { sessionId } = (await ensureRes.json()) as EnsureOrchestratorResponse;

    const session = api.providers.engineHost.liveSession(sessionId);
    expect(session).not.toBeNull();
    expect(session?.options.queueMode).toBe("steer");
    expect(session?.options.purpose).toBe("orchestrator");
    expect(session?.options.owner).toEqual({ type: "user", id: "local-user" });

    const fragments = session?.options.systemContext ?? [];
    const snapshotFragment = fragments.find((f) => f.name === "memory-snapshot");
    expect(snapshotFragment).toBeDefined();
    expect(snapshotFragment?.content).toContain("Keep replies terse and direct.");
    expect(snapshotFragment?.content).toContain("preferences/tone.md");

    // Persona lands as the session systemPrompt.
    expect(session?.options.systemPrompt).toContain("personal assistant");
    expect(session?.options.systemPrompt).toContain("mem_search");
  });
});

// ── Sandbox-less wake (key-gated: real Anthropic call) ──────────────────────

/** Counts `create()` calls while delegating everything else to a real
 * `VirtualSandboxProvider` — proves the orchestrator turn below never
 * provisions a sandbox. */
class CreateCountingSandboxProvider implements SandboxProvider {
  creates = 0;
  private readonly inner = new VirtualSandboxProvider();
  readonly backend = this.inner.backend;
  capabilities() {
    return this.inner.capabilities();
  }
  async create(opts: SandboxCreateOpts): Promise<Sandbox> {
    this.creates++;
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

const describeIfKey = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfKey("api integration: orchestrator sandbox-less wake", () => {
  it(
    "answers a prompt with zero sandboxProvider.create calls",
    async () => {
      const counter = new CreateCountingSandboxProvider();
      api = await bootTestApi({ sandboxProvider: counter });

      const ensureRes = await fetch(`${api.baseUrl}/api/orchestrator`, { method: "POST" });
      expect(ensureRes.status).toBe(200);
      const { sessionId } = (await ensureRes.json()) as EnsureOrchestratorResponse;

      await driveTurn({
        baseUrl: api.baseUrl,
        wsUrl: api.wsUrl,
        sessionId,
        prompt: "Reply with exactly the word 'ack' and nothing else. Do not use any tools.",
      });

      expect(counter.creates).toBe(0);
    },
    60_000,
  );
});
