/**
 * Security needs route through attention (notification escalation design).
 * A need that waits for a person pings the session owner once with kind
 * "question". An auto-resolved need sends no ping. A human answer marks the
 * ping read. No ANTHROPIC_API_KEY and no model turn: the runner is paused and
 * the persona need is posted as the dispatched child.
 */
import { describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import {
  actingAs,
  buildPausedRunner,
  createSecuritySession,
  dispatchViaRoute,
  setPlanViaRoute,
  startViaRoute,
  waitFor,
} from "./security-harness.js";
import { attentionHref } from "../orchestrator/attention-wiring.js";
import { routeAttention } from "../orchestrator/attention.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { notifications, securityEngagements } from "../schema/index.js";
import type { SecurityReportNeedResponse } from "../wire/types.js";

// The real router, wrapped so one test can make it hang.
vi.mock("../orchestrator/attention.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orchestrator/attention.js")>();
  return { ...actual, routeAttention: vi.fn(actual.routeAttention) };
});

const PLAN = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase and seed the checklist",
].join("\n");

/** Start a one-cell engagement and dispatch its cell. Returns the runner
 * session id, the engagement id, the dispatched cell id, and its child session id. */
async function runningChild(
  api: TestApi,
): Promise<{ sessionId: string; engagementId: string; cellId: string; childId: string }> {
  const { sessionId, engagementId } = await createSecuritySession(api);
  const { threadId } = await buildPausedRunner(api, sessionId);
  await setPlanViaRoute(api, sessionId, PLAN);
  await startViaRoute(api, sessionId);
  const dispatched = await dispatchViaRoute(api, sessionId, threadId);
  const childId = dispatched.cell.childSessionId;
  if (!childId) throw new Error("dispatch returned no child session id");
  return { sessionId, engagementId, cellId: dispatched.cell.id, childId };
}

async function reportNeed(
  api: TestApi,
  childId: string,
  need: { kind: string; description: string },
): Promise<SecurityReportNeedResponse> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${childId}/security/needs`, {
    method: "POST",
    headers: actingAs(childId),
    body: JSON.stringify(need),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityReportNeedResponse;
}

function needRows(api: TestApi, prefix: string) {
  return api.providers.db.select().from(notifications).where(like(notifications.id, `${prefix}%`));
}

/** The route does not wait for the attention ping, so wait for its rows. */
async function waitForNeedRows(api: TestApi, prefix: string, n: number) {
  await waitFor(async () => (await needRows(api, prefix)).length >= n, 5_000, `${n} ${prefix} rows`);
  return needRows(api, prefix);
}

describe("api integration: security needs route through attention", () => {
  it("each human need pings the owner once with kind question", async () => {
    const api = await bootTestApi();
    try {
      const { sessionId, childId } = await runningChild(api);
      const first = await reportNeed(api, childId, { kind: "decision", description: "Pick the staging or production target." });
      const second = await reportNeed(api, childId, { kind: "decision", description: "Confirm the admin routes are in scope." });
      expect(first.need.status).toBe("needs_human");
      expect(second.need.status).toBe("needs_human");

      for (const need of [first.need, second.need]) {
        const rows = await waitForNeedRows(api, `n-question-security-need:${need.id}-`, 1);
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe("question");
        expect(rows[0].title).toBe("Security review needs an answer");
        expect(rows[0].href).toBe(attentionHref(sessionId, undefined, { type: "user", id: "local-user" }));
        expect(rows[0].body).toContain("acme/api");
      }
      expect(await needRows(api, "n-question-security-need:")).toHaveLength(2);
    } finally {
      await api.cleanup();
    }
  });

  it("pings for an earlier open need that a later report's sweep moves to needs_human", async () => {
    const api = await bootTestApi();
    try {
      const { engagementId, cellId, childId } = await runningChild(api);
      // A need recorded with no sweep, as after a crash between record and sweep.
      const service = createSecurityEngagementService({ db: api.providers.db });
      const orphan = await service.reportNeed(engagementId, {
        cellId,
        kind: "decision",
        description: "Confirm the admin routes are in scope.",
      });
      expect(await needRows(api, "n-question-security-need:")).toHaveLength(0);

      const later = await reportNeed(api, childId, { kind: "decision", description: "Pick the staging or production target." });
      expect(later.needsHuman.map((n) => n.id)).toContain(orphan.id);
      for (const id of [orphan.id, later.need.id]) {
        const rows = await waitForNeedRows(api, `n-question-security-need:${id}-`, 1);
        expect(rows).toHaveLength(1);
        expect(rows[0].body).toContain("from cell 1.");
      }
    } finally {
      await api.cleanup();
    }
  });

  it("does not ping the owner for an auto-resolved tool need", async () => {
    const api = await bootTestApi();
    try {
      const { engagementId, childId } = await runningChild(api);
      await api.providers.db
        .update(securityEngagements)
        .set({ configTools: JSON.stringify(["nmap"]) })
        .where(eq(securityEngagements.id, engagementId));
      vi.mocked(routeAttention).mockClear();
      const reported = await reportNeed(api, childId, { kind: "tool", description: "Install nmap to scan the service ports." });
      expect(reported.need.status).not.toBe("needs_human");
      expect(await needRows(api, "n-question-security-need:")).toHaveLength(0);
      expect(routeAttention).not.toHaveBeenCalled();
    } finally {
      await api.cleanup();
    }
  });

  it("resolving the need marks its notification read", async () => {
    const api = await bootTestApi();
    try {
      const { sessionId, childId } = await runningChild(api);
      const reported = await reportNeed(api, childId, { kind: "decision", description: "Pick the staging or production target." });
      const prefix = `n-question-security-need:${reported.need.id}-`;
      expect((await waitForNeedRows(api, prefix, 1))[0]?.readAt).toBeNull();

      const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/needs/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: [{ needId: reported.need.id, resolution: "Use staging." }] }),
      });
      expect(res.status).toBe(200);
      const rows = await needRows(api, prefix);
      expect(rows).toHaveLength(1);
      expect(rows[0].readAt).not.toBeNull();
    } finally {
      await api.cleanup();
    }
  });

  it("a hanging attention route does not delay the need response", async () => {
    const api = await bootTestApi();
    try {
      const { childId } = await runningChild(api);
      vi.mocked(routeAttention).mockClear();
      vi.mocked(routeAttention).mockImplementationOnce(() => new Promise<void>(() => {}));
      // The abort fails the test after 1 s instead of at the suite timeout.
      const res = await fetch(`${api.baseUrl}/api/sessions/${childId}/security/needs`, {
        method: "POST",
        headers: actingAs(childId),
        body: JSON.stringify({ kind: "decision", description: "Pick the staging or production target." }),
        signal: AbortSignal.timeout(1_000),
      });
      expect(res.status).toBe(200);
      const reported = (await res.json()) as SecurityReportNeedResponse;
      expect(reported.need.status).toBe("needs_human");
      expect(routeAttention).toHaveBeenCalledTimes(1);
    } finally {
      await api.cleanup();
    }
  });
});
