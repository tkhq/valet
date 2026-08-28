/**
 * Pivot-coordinator + needs loop (M-P4c, valet-security design
 * §Pivot-coordinator). Proves the human answer + delta re-run through the real
 * routes:
 *   - the persona reports a need (POST /security/needs), the coordinator marks
 *     a credential needs_human, and the GET /security response surfaces it;
 *   - the resolve route is human-only (the internal token is refused) and
 *     admin-gated, marks the need answered, and resets ONLY the affected cell to
 *     pending (a delta re-run), not the whole engagement;
 *   - the reset cell's re-dispatch carries the resolution into the prompt.
 *
 * No ANTHROPIC_API_KEY and no model turn: the engagement is started and cells
 * are dispatched at the service level; the persona need is posted through the
 * tool route.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { securityCells } from "../schema/index.js";
import type {
  CreateSessionResponse,
  GetSessionSecurityResponse,
  SecurityReportNeedResponse,
  SecurityResolveNeedsResponse,
} from "../wire/types.js";

const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" };
const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";

async function createSecuritySession(
  baseUrl: string,
): Promise<{ session: CreateSessionResponse; engagementId: string }> {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspace: `/tmp/valet-sec-needs-${randomUUID()}`,
      kind: "security",
      repo: REPO,
    }),
  });
  expect(res.status).toBe(201);
  const session = (await res.json()) as CreateSessionResponse;
  const security = await fetch(`${baseUrl}/api/sessions/${session.id}/security`);
  expect(security.status).toBe(200);
  const body = (await security.json()) as GetSessionSecurityResponse;
  return { session, engagementId: body.engagement.id };
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("api integration: pivot-coordinator + needs loop (M-P4c)", () => {
  it("persona reports a need, the human resolves it, and only the affected cell re-runs", async () => {
    const api = await bootTestApi();
    try {
      const { session, engagementId } = await createSecuritySession(api.baseUrl);
      const service = createSecurityEngagementService({ db: api.providers.db });
      const started = await service.startEngagement(engagementId, { resolvedSha: SHA });
      const cells = started.cells;

      // Run cell 1 to completion; dispatch cell 2, which records a need.
      await service.dispatchCell(engagementId, { cellId: cells[0].id, spawn: async () => ({ childSessionId: "child-1" }) });
      await service.writeFile(engagementId, {
        actorCellId: cells[0].id,
        path: `/cells/${cells[0].dir}/state.yml`,
        content: [
          "protocol_version: 1",
          "status: done",
          "checklist:",
          "  pending: 0",
          "  done: 3",
          "queue:",
          "  pending: 0",
          "  done: 2",
          "",
        ].join("\n"),
      });
      await service.completeCell(engagementId, cells[0].id, { settled: true });
      await service.dispatchCell(engagementId, {
        cellId: cells[1].id,
        spawn: async () => ({ childSessionId: "child-2" }),
      });

      // The persona posts a credential need through the tool route.
      const needRes = await postJson(
        `${api.baseUrl}/api/sessions/child-2/security/needs`,
        { kind: "credential", description: "A staging admin token to reach /admin routes." },
        { "x-valet-internal": internalToken(), "x-valet-session-id": "child-2" },
      );
      expect(needRes.status).toBe(200);
      const need = (await needRes.json()) as SecurityReportNeedResponse;
      expect(need.need.status).toBe("needs_human");
      expect(need.needsHuman).toHaveLength(1);
      const needId = need.need.id;

      // Yield cell 2 (it is blocked on the need).
      await service.writeFile(engagementId, {
        actorCellId: cells[1].id,
        path: `/cells/${cells[1].dir}/state.yml`,
        content: [
          "protocol_version: 1",
          "status: yielding",
          "checklist:",
          "  pending: 4",
          "  done: 1",
          "queue:",
          "  pending: 4",
          "  done: 1",
          "",
        ].join("\n"),
      });
      await service.completeCell(engagementId, cells[1].id, { settled: true });

      // GET /security surfaces the needs_human need.
      const view = await fetch(`${api.baseUrl}/api/sessions/${session.id}/security`);
      const viewBody = (await view.json()) as GetSessionSecurityResponse;
      expect(viewBody.needs).toBeDefined();
      expect(viewBody.needs?.some((n) => n.id === needId && n.status === "needs_human")).toBe(true);

      // The internal token is refused on the human resolve route.
      const asRunner = await postJson(
        `${api.baseUrl}/api/sessions/${session.id}/security/needs/resolve`,
        { answers: [{ needId, resolution: "Token: stg_admin." }] },
        { "x-valet-internal": internalToken() },
      );
      expect(asRunner.status).toBe(403);

      // The human answers; the delta re-run resets ONLY cell 2.
      const resolve = await postJson(`${api.baseUrl}/api/sessions/${session.id}/security/needs/resolve`, {
        answers: [{ needId, resolution: "Token: stg_admin_abc123." }],
      });
      expect(resolve.status).toBe(200);
      const resolved = (await resolve.json()) as SecurityResolveNeedsResponse;
      expect(resolved.answered).toHaveLength(1);
      expect(resolved.resetCellIds).toEqual([cells[1].id]);

      const rows = await api.providers.db
        .select()
        .from(securityCells)
        .where(eq(securityCells.engagementId, engagementId));
      const byOrdinal = new Map(rows.map((r) => [r.ordinal, r.status]));
      expect(byOrdinal.get(1)).toBe("completed"); // untouched
      expect(byOrdinal.get(2)).toBe("pending"); // reset for the delta re-run

      // The delta re-dispatch carries the resolution into the prompt.
      const redispatch = await service.dispatchCell(engagementId, {
        cellId: cells[1].id,
        spawn: async () => ({ childSessionId: "child-2b" }),
      });
      expect(redispatch.prompt).toContain("Resolved needs (continue the blocked work)");
      expect(redispatch.prompt).toContain("stg_admin_abc123");
    } finally {
      await api.cleanup();
    }
  });
});
