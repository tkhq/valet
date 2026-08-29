/**
 * COVERAGE LEDGER ROUND TRIP (M-P2d, spec §Coverage honesty): the persona
 * `sec_coverage_report` tool posts to POST /:id/security/coverage over the cell
 * claim, exactly as the persona tools do (child's own session id in the URL and
 * in `x-valet-session-id`; the route resolves the claim and finds the
 * engagement from it).
 *
 * Proves, end to end on the virtual sandbox:
 *   - an assessed row lands for the acting cell,
 *   - a not_assessed WITHOUT a reason is a corrective 409 (never a silent gap),
 *   - a not_assessed WITH a reason lands and surfaces on GET .../coverage,
 *   - the GET rollup counts assessed vs not_assessed and lists the gap,
 *   - a non-persona (claimless) session is refused 403,
 *   - the dispatched child's build carries sec_coverage_report.
 *
 * No ANTHROPIC_API_KEY and no model turn: the runner thread is paused and the
 * child is settled by aborting it (the persona suite's precedent).
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { agentSessions } from "../schema/index.js";
import type {
  CreateSessionResponse,
  ListSecurityCoverageResponse,
  SecurityDispatchResponse,
  SecurityReportCoverageResponse,
} from "../wire/types.js";

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA };

/** One sast cell. */
const PLAN = [
  "cells:",
  "  - ordinal: 1",
  "    persona: sast",
  "    name: sast",
  "    goal: Scan the code",
].join("\n");

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function actingAs(sessionId: string, json = true): Record<string, string> {
  return {
    "x-valet-internal": internalToken(),
    "x-valet-session-id": sessionId,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

describe("api integration: coverage ledger over the cell claim", () => {
  it(
    "persona records assessed + not_assessed coverage; a reasonless gap is refused",
    async () => {
      api = await bootTestApi();
      const { db, engineHost } = api.providers;

      const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: `/tmp/valet-sec-cov-${randomUUID()}`,
          kind: "security",
          repo: REPO,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as CreateSessionResponse;
      const sessionId = created.id;

      const service = createSecurityEngagementService({ db });
      const found = await service.getEngagementBySession(sessionId);
      const engagementId = found!.engagement.id;
      await service.setPlan(engagementId, PLAN);

      const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
      const runner = await engineHost.sessionFor(sessionId, await loadSessionMeta(db, rows[0]));
      const runnerThread = runner.thread("web:default");
      await runner.pause();

      await service.startEngagement(engagementId, { resolvedSha: SHA });

      // Dispatch the sast cell through the real route.
      const dispatchRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({ threadId: runnerThread.id }),
      });
      expect(dispatchRes.status).toBe(200);
      const dispatched = (await dispatchRes.json()) as SecurityDispatchResponse;
      const child = dispatched.cell.childSessionId!;
      expect(child).toBeTruthy();

      // The child's build carries the coverage tool.
      const childTools = (engineHost.liveSession(child)!.options.tools ?? []).map((t) => t.name);
      expect(childTools).toContain("sec_coverage_report");

      // An assessed row lands for the acting cell.
      const assessedRes = await fetch(`${api.baseUrl}/api/sessions/${child}/security/coverage`, {
        method: "POST",
        headers: actingAs(child),
        body: JSON.stringify({ area: "secrets scan", status: "assessed", tool: "gitleaks" }),
      });
      expect(assessedRes.status).toBe(200);
      const assessed = (await assessedRes.json()) as SecurityReportCoverageResponse;
      expect(assessed.coverage.status).toBe("assessed");
      expect(assessed.coverage.cellId).toBe(dispatched.cell.id);

      // A not_assessed WITHOUT a reason is a corrective error — never a silent gap.
      const reasonless = await fetch(`${api.baseUrl}/api/sessions/${child}/security/coverage`, {
        method: "POST",
        headers: actingAs(child),
        body: JSON.stringify({ area: "semgrep owasp", status: "not_assessed", tool: "semgrep" }),
      });
      expect(reasonless.status).toBe(409);
      expect(((await reasonless.json()) as { error: string }).error).toMatch(
        /substantive reason .* naming the consequence/,
      );

      // A not_assessed WITH a reason lands.
      const gapRes = await fetch(`${api.baseUrl}/api/sessions/${child}/security/coverage`, {
        method: "POST",
        headers: actingAs(child),
        body: JSON.stringify({
          area: "semgrep owasp",
          status: "not_assessed",
          tool: "semgrep",
          reason: "OWASP sink rules not scanned because semgrep is missing.",
        }),
      });
      expect(gapRes.status).toBe(200);

      // The GET coverage route rolls it up: 1 assessed, 1 not_assessed, 1 gap.
      const listRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/coverage`, {
        headers: actingAs(sessionId, false),
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as ListSecurityCoverageResponse;
      expect(list.coverage).toHaveLength(2);
      expect(list.rollup.assessed).toBe(1);
      expect(list.rollup.notAssessed).toBe(1);
      expect(list.rollup.gaps).toEqual([
        {
          area: "semgrep owasp",
          tool: "semgrep",
          reason: "OWASP sink rules not scanned because semgrep is missing.",
        },
      ]);

      // A non-persona session (the runner, which no cell claims) is refused:
      // the coverage tool is a persona seam, resolved from the cell claim.
      const nonPersona = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/coverage`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({ area: "runner attempt", status: "assessed" }),
      });
      expect(nonPersona.status).toBe(403);
      expect(((await nonPersona.json()) as { error: string }).error).toBe(
        "This session is not a dispatched persona cell.",
      );

      // Tidy: settle the child so cleanup does not race a live turn.
      await engineHost.liveSession(child)?.abort();
    },
    60_000,
  );
});
