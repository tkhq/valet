/**
 * Integration test: dismiss a settled child from the orchestrator tree.
 *
 * Dismiss is app-side display state (`child_watches.dismissed_at`): a
 * dismissed watch leaves GET /api/orchestrator/children, but the child
 * session row and its history stay reachable from the Sessions page.
 * Only settled children can be dismissed. Ungated — no Anthropic key.
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { agentSessions, childWatches } from "../schema/index.js";
import type { GetOrchestratorChildrenResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

const ORCH_SESSION_ID = "orchestrator:user:local-user";

async function insertChild(opts: { id: string; settled: boolean }): Promise<void> {
  const { db } = api!.providers;
  const now = Date.now();
  await db.insert(agentSessions).values({
    id: opts.id,
    userId: "local-user",
    orgId: "local-org",
    workspace: `/tmp/${opts.id}`,
    title: `Child ${opts.id}`,
    status: "active",
    ownerType: "user",
    ownerId: "local-user",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(childWatches).values({
    childSessionId: opts.id,
    queueItemId: `qi-${opts.id}`,
    parentSessionId: ORCH_SESSION_ID,
    parentThreadId: "th-1",
    actorUserId: "local-user",
    orgId: "local-org",
    settled: opts.settled,
    createdAt: now,
  });
}

describe("POST /api/orchestrator/children/:childSessionId/dismiss", () => {
  it("hides a settled child from the list; the session row survives", async () => {
    api = await bootTestApi();
    await insertChild({ id: "child-a", settled: true });

    const before = (await (
      await fetch(`${api.baseUrl}/api/orchestrator/children`)
    ).json()) as GetOrchestratorChildrenResponse;
    expect(before.children.map((ch) => ch.sessionId)).toContain("child-a");

    const dismiss = await fetch(
      `${api.baseUrl}/api/orchestrator/children/child-a/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(200);

    const after = (await (
      await fetch(`${api.baseUrl}/api/orchestrator/children`)
    ).json()) as GetOrchestratorChildrenResponse;
    expect(after.children.map((ch) => ch.sessionId)).not.toContain("child-a");

    // The watch row is marked dismissed, not deleted, and the child's
    // agent_sessions row is untouched.
    const watchRows = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-a"));
    expect(typeof watchRows[0]?.dismissedAt).toBe("number");
    const sessionRows = await api.providers.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, "child-a"));
    expect(sessionRows[0]?.status).toBe("active");
  });

  it("refuses to dismiss a child that has not settled", async () => {
    api = await bootTestApi();
    await insertChild({ id: "child-b", settled: false });

    const dismiss = await fetch(
      `${api.baseUrl}/api/orchestrator/children/child-b/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(409);

    const rows = await api.providers.db
      .select()
      .from(childWatches)
      .where(eq(childWatches.childSessionId, "child-b"));
    expect(rows[0]?.dismissedAt).toBeNull();
  });

  it("404s for a child that belongs to no watch of this orchestrator", async () => {
    api = await bootTestApi();
    const dismiss = await fetch(
      `${api.baseUrl}/api/orchestrator/children/nope/dismiss`,
      { method: "POST" },
    );
    expect(dismiss.status).toBe(404);
  });
});
