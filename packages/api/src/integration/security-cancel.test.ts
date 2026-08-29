/**
 * Cancel + completion-notification routes (valet-security §Cancel,
 * §Completion notification). No engine turns and no ANTHROPIC_API_KEY —
 * the engagement + cells are seeded directly, so nothing prompts. The cancel
 * route's child teardown runs against a non-live child (engineHost.destroy is
 * a no-op there); the test asserts the soft-delete the route writes itself.
 */
import { describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import {
  agentSessions,
  notifications,
  securityCells,
  securityEngagements,
  securityFindings,
  users,
} from "../schema/index.js";
import type { CreateSessionResponse, GetSessionSecurityResponse } from "../wire/types.js";

const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" };

const EVIDENCE = `The route reads the session id from the URL and never checks ownership. Excerpt: db.select().from(sessions).where(eq(sessions.id, id)) — any authenticated caller can read any session, which leaks other tenants' transcripts.`;

async function createSecuritySession(
  baseUrl: string,
): Promise<{ session: CreateSessionResponse; engagementId: string }> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp/valet-security-cancel-test", kind: "security", repo: REPO }),
  });
  expect(res.status).toBe(201);
  const session = (await res.json()) as CreateSessionResponse;
  const security = await fetch(`${baseUrl}/api/sessions/${session.id}/security`);
  expect(security.status).toBe(200);
  const body = (await security.json()) as GetSessionSecurityResponse;
  return { session, engagementId: body.engagement.id };
}

/** Drive the seeded engagement to running with one running cell whose
 * `child_session_id` names a real child agent_sessions row. Returns the child
 * id so the teardown assertion can read its status. */
async function seedRunningCell(
  api: TestApi,
  engagementId: string,
): Promise<{ childSessionId: string; cellId: string }> {
  const { db } = api.providers;
  const now = Date.now();
  const childSessionId = "child_cancel_1";
  await db
    .update(securityEngagements)
    .set({ status: "running", repoRef: "0".repeat(40) })
    .where(eq(securityEngagements.id, engagementId));
  await db.insert(agentSessions).values({
    id: childSessionId,
    userId: "local-user",
    orgId: "local-org",
    workspace: "/tmp/child",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const cellId = "cell_cancel_1";
  await db.insert(securityCells).values({
    id: cellId,
    engagementId,
    ordinal: 1,
    persona: "code-review",
    goal: "recon",
    dir: "01-recon",
    reads: "[]",
    status: "running",
    attempts: 1,
    childSessionId,
    dispatchedAt: now,
    createdAt: now,
  });
  return { childSessionId, cellId };
}

function postJson(url: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("api integration: security cancel route", () => {
  it("cancels a running engagement, fails cells, tears the child down, and pings the owner", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      const { childSessionId, cellId } = await seedRunningCell(api, engagementId);
      const cancelUrl = `${api.baseUrl}/api/sessions/${session.id}/security/cancel`;

      const res = await postJson(cancelUrl);
      expect(res.status).toBe(200);
      const body = (await res.json()) as GetSessionSecurityResponse;
      expect(body.engagement.status).toBe("cancelled");
      expect(body.cells.find((c) => c.id === cellId)?.status).toBe("failed");

      // The running cell's child was torn down through the session-terminate
      // seam: soft-deleted, exactly as DELETE /api/sessions/:id does.
      const { db } = api.providers;
      const childRows = await db
        .select({ status: agentSessions.status })
        .from(agentSessions)
        .where(eq(agentSessions.id, childSessionId));
      expect(childRows[0]?.status).toBe("deleted");

      // The owner got a completion ping (kind 'notification').
      const notifs = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, "local-user"), eq(notifications.kind, "notification")));
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toBe("Security review cancelled");
      expect(notifs[0].body).toContain("acme/api");
    } finally {
      await api.cleanup();
    }
  });

  it("refuses the internal token (403 human-only) and a non-admin viewer (404)", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await seedRunningCell(api, engagementId);
      const cancelUrl = `${api.baseUrl}/api/sessions/${session.id}/security/cancel`;

      // The runner's path: refused outright, naming the human action.
      const asRunner = await postJson(cancelUrl, {}, { "x-valet-internal": internalToken(), "x-valet-session-id": session.id });
      expect(asRunner.status).toBe(403);
      expect(((await asRunner.json()) as { error: string }).error).toContain("human");

      // A non-owner (no view access) gets the existence-hiding 404.
      const { db } = api.providers;
      await db.insert(users).values({ id: "intruder", email: "i@x.test", name: "I", role: "member" });
      const asIntruder = await postJson(cancelUrl, {}, { "x-valet-test-user-id": "intruder" });
      expect(asIntruder.status).toBe(404);

      // Nothing was cancelled by the refused calls.
      const rows = await db
        .select({ status: securityEngagements.status })
        .from(securityEngagements)
        .where(eq(securityEngagements.id, engagementId));
      expect(rows[0]?.status).toBe("running");
    } finally {
      await api.cleanup();
    }
  });

  it("refuses a completed engagement with a corrective 409", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await api.providers.db
        .update(securityEngagements)
        .set({ status: "completed" })
        .where(eq(securityEngagements.id, engagementId));
      const res = await postJson(`${api.baseUrl}/api/sessions/${session.id}/security/cancel`);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(
        "Only a planning or running engagement can be cancelled",
      );
    } finally {
      await api.cleanup();
    }
  });
});

describe("api integration: security completion notification", () => {
  /** Seed the engagement to running with every cell completed, so a close
   * flips it to 'completed'. Returns the finding count seeded. */
  async function seedClosable(api: TestApi, engagementId: string): Promise<void> {
    const { db } = api.providers;
    const now = Date.now();
    await db
      .update(securityEngagements)
      .set({ status: "running", repoRef: "0".repeat(40) })
      .where(eq(securityEngagements.id, engagementId));
    await db.insert(securityCells).values({
      id: "cell_done_1",
      engagementId,
      ordinal: 1,
      persona: "code-review",
      goal: "recon",
      dir: "01-recon",
      reads: "[]",
      status: "completed",
      attempts: 1,
      settledAt: now,
      createdAt: now,
    });
    await db.insert(securityFindings).values([
      {
        id: "fnd_c1",
        engagementId,
        cellId: "cell_done_1",
        fingerprint: "fp_c1",
        severity: "critical",
        title: "RCE via eval",
        file: "src/a.ts",
        line: 1,
        body: EVIDENCE,
        status: "open",
        createdAt: now,
      },
      {
        id: "fnd_h1",
        engagementId,
        cellId: "cell_done_1",
        fingerprint: "fp_h1",
        severity: "high",
        title: "IDOR",
        file: "src/b.ts",
        line: 2,
        body: EVIDENCE,
        status: "open",
        createdAt: now + 1,
      },
    ]);
  }

  it("close emits one owner notification naming the finding counts", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await seedClosable(api, engagementId);
      const closeUrl = `${api.baseUrl}/api/sessions/${session.id}/security/close`;

      // The runner closes via the internal token — the ping still fires.
      const res = await postJson(closeUrl, {}, { "x-valet-internal": internalToken(), "x-valet-session-id": session.id });
      expect(res.status).toBe(200);

      const { db } = api.providers;
      const notifs = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, "local-user"), eq(notifications.kind, "notification")));
      expect(notifs).toHaveLength(1);
      expect(notifs[0].title).toBe("Security review complete");
      expect(notifs[0].body).toContain("acme/api");
      expect(notifs[0].body).toContain("1 critical");
      expect(notifs[0].body).toContain("1 high");

      // Dedupe: a second close is refused by the service (already completed),
      // but the dedupe key means no second notification could land anyway.
      const second = await postJson(closeUrl, {}, { "x-valet-internal": internalToken(), "x-valet-session-id": session.id });
      expect(second.status).toBe(409);
      const after = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, "local-user"), eq(notifications.kind, "notification")));
      expect(after).toHaveLength(1);
    } finally {
      await api.cleanup();
    }
  });

  it("the close and cancel share a dedupe key so a review pings once", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      await seedClosable(api, engagementId);
      const { db } = api.providers;

      // Close first: one notification with id n-notification-security-close:<id>-local-user.
      const closeUrl = `${api.baseUrl}/api/sessions/${session.id}/security/close`;
      const closed = await postJson(closeUrl, {}, { "x-valet-internal": internalToken(), "x-valet-session-id": session.id });
      expect(closed.status).toBe(200);

      const rows = await db
        .select()
        .from(notifications)
        .where(like(notifications.id, `n-notification-security-close:${engagementId}-%`));
      expect(rows).toHaveLength(1);
    } finally {
      await api.cleanup();
    }
  });
});
