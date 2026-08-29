/**
 * REPORT ARTIFACT ROUND TRIP (M-P3, spec §Report generation): the report cell's
 * `sec_report_write` tool posts to POST /:id/security/report over the cell
 * claim, exactly as the persona tools do (child's own session id in the URL and
 * in `x-valet-session-id`; the route resolves the claim and finds the
 * engagement from it).
 *
 * Proves, end to end on the virtual sandbox:
 *   - the report cell's child build carries sec_report_write,
 *   - a report write stores markdown + JSON for the report cell,
 *   - a non-report persona cell is refused 403,
 *   - a non-persona (claimless runner) session is refused 403,
 *   - a non-object json is a corrective 400,
 *   - GET .../report returns the stored artifact (view-gated),
 *   - GET .../report/export returns md and json with the right content-type.
 *
 * No ANTHROPIC_API_KEY and no model turn: the runner thread is paused and the
 * child is settled by aborting it (the coverage suite's precedent).
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
  GetSecurityReportResponse,
  SecurityDispatchResponse,
  SecurityWriteReportResponse,
} from "../wire/types.js";

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA };

/** Recon (a non-report cell) then a report cell. The report cell reads recon. */
const PLAN = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase",
  "  - ordinal: 2",
  "    persona: report",
  "    name: report",
  "    goal: Write the engagement report",
  "    reads: [1]",
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

/** Dispatch the first pending cell of the engagement through the real route. */
async function dispatchNext(
  api: TestApi,
  sessionId: string,
  threadId: string,
  cellId?: string,
): Promise<SecurityDispatchResponse> {
  const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
    method: "POST",
    headers: actingAs(sessionId),
    body: JSON.stringify({ cellId, threadId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityDispatchResponse;
}

describe("api integration: report artifact over the cell claim", () => {
  it(
    "report cell writes the artifact; non-report and non-persona are refused; export serves md + json",
    async () => {
      api = await bootTestApi();
      const { db, engineHost } = api.providers;

      const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: `/tmp/valet-sec-report-${randomUUID()}`,
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

      // Dispatch recon (the non-report cell) first.
      const recon = await dispatchNext(api, sessionId, runnerThread.id);
      const reconChild = recon.cell.childSessionId!;
      expect(reconChild).toBeTruthy();

      // A non-report persona cell may NOT write the report — sec_report_write is
      // scoped to the report cell.
      const reconTools = (engineHost.liveSession(reconChild)!.options.tools ?? []).map((t) => t.name);
      expect(reconTools).not.toContain("sec_report_write");
      const reconAttempt = await fetch(`${api.baseUrl}/api/sessions/${reconChild}/security/report`, {
        method: "POST",
        headers: actingAs(reconChild),
        body: JSON.stringify({ markdown: "# nope", json: {} }),
      });
      expect(reconAttempt.status).toBe(403);
      expect(((await reconAttempt.json()) as { error: string }).error).toMatch(
        /Only the report cell/,
      );

      // Settle recon so the report cell can dispatch (serial engagement).
      await engineHost.liveSession(reconChild)?.abort();
      const reconState = [
        "protocol_version: 1",
        `cell: ${recon.cell.dir}`,
        `persona: ${recon.cell.persona}`,
        "status: done",
        "checklist:",
        "  pending: 0",
        "  done: 1",
        "queue:",
        "  pending: 0",
        "  done: 0",
        "findings: []",
        "log: []",
        "",
      ].join("\n");
      await fetch(`${api.baseUrl}/api/sessions/${reconChild}/security/files`, {
        method: "POST",
        headers: actingAs(reconChild),
        body: JSON.stringify({ path: `/cells/${recon.cell.dir}/state.yml`, content: reconState }),
      });
      await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/cells/${recon.cell.id}/complete`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({}),
      });

      // Dispatch the report cell.
      const report = await dispatchNext(api, sessionId, runnerThread.id);
      const reportChild = report.cell.childSessionId!;
      expect(reportChild).toBeTruthy();
      expect(report.cell.persona).toBe("report");

      // The report cell's child build carries sec_report_write.
      const reportTools = (engineHost.liveSession(reportChild)!.options.tools ?? []).map((t) => t.name);
      expect(reportTools).toContain("sec_report_write");

      // A non-object json is a corrective 400 — the snapshot is a record.
      const badJson = await fetch(`${api.baseUrl}/api/sessions/${reportChild}/security/report`, {
        method: "POST",
        headers: actingAs(reportChild),
        body: JSON.stringify({ markdown: "# Report", json: [1, 2, 3] }),
      });
      expect(badJson.status).toBe(400);
      expect(((await badJson.json()) as { error: string }).error).toMatch(/json must be an object/);

      // The report write stores markdown + JSON for the report cell.
      const md = "# Valet Security report\n\n## Executive summary\n\nOne confirmed high finding.";
      const snapshot = { executiveSummary: "one high", findings: [{ severity: "high", title: "IDOR" }] };
      const writeRes = await fetch(`${api.baseUrl}/api/sessions/${reportChild}/security/report`, {
        method: "POST",
        headers: actingAs(reportChild),
        body: JSON.stringify({ markdown: md, json: snapshot }),
      });
      expect(writeRes.status).toBe(200);
      const written = (await writeRes.json()) as SecurityWriteReportResponse;
      expect(written.report.markdown).toBe(md);
      expect(written.report.json).toEqual(snapshot);
      expect(written.report.generatedAt).toBeGreaterThan(0);

      // A non-persona (claimless runner) session is refused — the write is a
      // persona seam resolved from the cell claim.
      const runnerAttempt = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/report`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({ markdown: "# nope", json: {} }),
      });
      expect(runnerAttempt.status).toBe(403);
      expect(((await runnerAttempt.json()) as { error: string }).error).toBe(
        "This session is not a dispatched persona cell.",
      );

      // GET .../report returns the stored artifact (view-gated — the local-auth
      // owner reads it; no internal token).
      const getRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/report`);
      expect(getRes.status).toBe(200);
      const got = (await getRes.json()) as GetSecurityReportResponse;
      expect(got.report).not.toBeNull();
      expect(got.report!.markdown).toBe(md);
      expect(got.report!.json).toEqual(snapshot);

      // Export md — text/markdown, the report body.
      const mdExport = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/security/report/export?format=md`,
      );
      expect(mdExport.status).toBe(200);
      expect(mdExport.headers.get("content-type")).toMatch(/text\/markdown/);
      expect(await mdExport.text()).toBe(md);

      // Export json — application/json, the snapshot.
      const jsonExport = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/security/report/export?format=json`,
      );
      expect(jsonExport.status).toBe(200);
      expect(jsonExport.headers.get("content-type")).toMatch(/application\/json/);
      expect(JSON.parse(await jsonExport.text())).toEqual(snapshot);

      // Tidy: settle the report child so cleanup does not race a live turn.
      await engineHost.liveSession(reportChild)?.abort();
    },
    60_000,
  );
});
