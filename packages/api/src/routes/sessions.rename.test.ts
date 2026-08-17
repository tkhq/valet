/**
 * PATCH /api/sessions/:id — the `title` half (V1 port #10, session rename).
 *
 * The route took only `model` before, so a wrong auto-generated title could
 * not be corrected. These tests pin the rename contract: the write, the
 * validation, the authorization, and the guarantee that a rename never
 * needs a sandbox.
 *
 * The model half stays covered by `teams-orchestrator.test.ts`, which also
 * pins the empty-body 400 this file re-checks from the rename side.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions } from "../schema/index.js";
import type { PatchSessionResponse } from "../wire/types.js";

async function seedSession(api: TestApi, opts: { id: string; userId: string; title?: string }): Promise<void> {
  const now = Date.now();
  await api.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: opts.userId,
    orgId: "local-org",
    workspace: `/tmp/rename-test-${opts.id}`,
    status: "active",
    title: opts.title ?? null,
    ownerType: "user",
    ownerId: opts.userId,
    createdAt: now,
    updatedAt: now,
  });
}

async function storedTitle(api: TestApi, sessionId: string): Promise<string | null> {
  const rows = await api.providers.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return rows[0]?.title ?? null;
}

function patch(api: TestApi, sessionId: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/sessions/:id — title", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("renames the session and returns the new title", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-happy", userId: "local-user", title: "Wrong Auto Title" });

    const res = await patch(api, "rn-happy", { title: "Postgres migration notes" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PatchSessionResponse;
    expect(body.title).toBe("Postgres migration notes");
    expect(await storedTitle(api, "rn-happy")).toBe("Postgres migration notes");
  });

  it("trims surrounding whitespace before storing", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-trim", userId: "local-user" });

    const res = await patch(api, "rn-trim", { title: "   Spaced out   " });
    expect(res.status).toBe(200);
    expect(await storedTitle(api, "rn-trim")).toBe("Spaced out");
  });

  it("renames without starting a sandbox", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-cold", userId: "local-user" });
    expect(api.providers.engineHost.isLive("rn-cold")).toBe(false);

    const res = await patch(api, "rn-cold", { title: "Named while asleep" });
    expect(res.status).toBe(200);
    // A rename must not materialize the engine session. A person renames
    // hibernated sessions from the list, and waking one to store a string
    // costs a sandbox start.
    expect(api.providers.engineHost.isLive("rn-cold")).toBe(false);
  });

  it("rejects an empty title and leaves the stored one alone", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-empty", userId: "local-user", title: "Keep me" });

    const res = await patch(api, "rn-empty", { title: "   " });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("at least one character");
    expect(await storedTitle(api, "rn-empty")).toBe("Keep me");
  });

  it("rejects a title past the length cap", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-long", userId: "local-user", title: "Keep me" });

    const res = await patch(api, "rn-long", { title: "x".repeat(201) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("200 characters or fewer");
    expect(await storedTitle(api, "rn-long")).toBe("Keep me");
  });

  it("rejects a non-string title", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-type", userId: "local-user", title: "Keep me" });

    const res = await patch(api, "rn-type", { title: 42 });
    expect(res.status).toBe(400);
    expect(await storedTitle(api, "rn-type")).toBe("Keep me");
  });

  it("still answers 'model is required' for a body with neither field", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-none", userId: "local-user" });

    const res = await patch(api, "rn-none", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "model is required" });
  });

  it("404s for a session owned by a different user, and writes nothing", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rn-other", userId: "test-member", title: "Theirs" });

    const res = await patch(api, "rn-other", { title: "Mine now" });
    expect(res.status).toBe(404);
    expect(await storedTitle(api, "rn-other")).toBe("Theirs");
  });

  it("404s for an unknown session id", async () => {
    api = await bootTestApi();
    const res = await patch(api, "rn-missing", { title: "Nowhere" });
    expect(res.status).toBe(404);
  });
});
