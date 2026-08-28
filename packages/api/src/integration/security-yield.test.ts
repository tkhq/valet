/**
 * THE YIELD ROUND TRIP (plan M5, spec §Context Discipline "Yield: the
 * persona's deliberate stop" — Scenario D steps 1–3 shape): a persona that
 * checkpoints `status: yielding` with pending work settles, the runner's
 * complete ruling lands `yielded` (settledAt stamped, not a failure), and
 * `sec_dispatch { mode: 'resume' }` re-dispatches the SAME cell row onto a
 * fresh child that reads its own prior state doc and finishes the work.
 *
 * Durability is the point: the first attempt's finding row and state-doc
 * revision survive the yield with stable ids — nothing re-runs, nothing is
 * lost, `attempts` counts dispatches onto one row.
 *
 * Same harness as security-persona.test.ts: no ANTHROPIC_API_KEY and no
 * model turn — the runner thread is paused, and children are settled by
 * aborting them (the settlement suite's abort precedent).
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import {
  agentSessions,
  childWatches,
  securityCells,
  securityFiles,
  securityFindings,
} from "../schema/index.js";
import type {
  CreateSessionResponse,
  SecurityCompleteCellResponse,
  SecurityDispatchResponse,
  SecurityReportFindingResponse,
  SecurityTreeFileResponse,
  SecurityWriteFileResponse,
} from "../wire/types.js";

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA };

/** One cell: the whole plan is a single recon sweep that yields mid-way. */
const PLAN = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase",
].join("\n");

/** Attempt 1's deliberate stop: work remains on the queue. */
const YIELDING_DOC = [
  "protocol_version: 1",
  "status: yielding",
  "checklist:",
  "  pending: 2",
  "  done: 8",
  "queue:",
  "  pending: 5",
  "  done: 12",
].join("\n");

/** Attempt 2 finishes: done with both pending counts at zero. */
const DONE_DOC = [
  "protocol_version: 1",
  "status: done",
  "checklist:",
  "  pending: 0",
  "  done: 10",
  "queue:",
  "  pending: 0",
  "  done: 17",
].join("\n");

/** ≥ 200 characters of evidence, per the finding body floor. */
const EVIDENCE =
  "The login handler at src/auth/login.ts builds its SQL with string concatenation: " +
  '`db.query("SELECT * FROM users WHERE name = \'" + req.body.name + "\'")`. ' +
  "Attacker-controlled req.body.name reaches the query text unescaped, so a single quote breaks out " +
  "of the literal and injects arbitrary SQL — full table read via UNION SELECT.";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor: timed out");
}

/** Headers the sec_* tools send: internal token + the acting session. */
function actingAs(sessionId: string, json = true): Record<string, string> {
  return {
    "x-valet-internal": internalToken(),
    "x-valet-session-id": sessionId,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

describe("api integration: yield and resume round trip", () => {
  it(
    "yielding settle → yielded ruling → resume dispatch → fresh child reads its own state doc → completed",
    async () => {
      api = await bootTestApi();
      const { db, engineHost, engineStore } = api.providers;

      // 1. A real hub-created security session with the 1-cell plan.
      const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: `/tmp/valet-sec-yield-${randomUUID()}`,
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

      // 2. Build + pause the runner (no-key turns stay unclaimed).
      const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
      const runner = await engineHost.sessionFor(sessionId, await loadSessionMeta(db, rows[0]));
      const runnerThread = runner.thread("web:default");
      await runner.pause();

      // 3. Start service-level (a 40-hex ref short-circuits SHA resolution).
      await service.startEngagement(engagementId, { resolvedSha: SHA });

      // 4. Dispatch attempt 1 through the real route.
      const dispatchRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({ threadId: runnerThread.id }),
      });
      expect(dispatchRes.status).toBe(200);
      const dispatched = (await dispatchRes.json()) as SecurityDispatchResponse;
      const cellId = dispatched.cell.id;
      const child1 = dispatched.cell.childSessionId!;
      expect(dispatched.cell.attempts).toBe(1);

      // 5. As child 1: checkpoint a yielding state doc and report a finding.
      const writeRes = await fetch(`${api.baseUrl}/api/sessions/${child1}/security/files`, {
        method: "POST",
        headers: actingAs(child1),
        body: JSON.stringify({ path: "/cells/01-recon/state.yml", content: YIELDING_DOC }),
      });
      expect(writeRes.status).toBe(200);
      expect(((await writeRes.json()) as SecurityWriteFileResponse).revision).toBe(1);

      const reportRes = await fetch(`${api.baseUrl}/api/sessions/${child1}/security/findings`, {
        method: "POST",
        headers: actingAs(child1),
        body: JSON.stringify({
          severity: "high",
          title: "SQL injection in login handler",
          file: "src/auth/login.ts",
          line: 42,
          body: EVIDENCE,
        }),
      });
      expect(reportRes.status).toBe(200);
      const reported = (await reportRes.json()) as SecurityReportFindingResponse;
      const findingId = reported.finding.id;

      // The revision-1 row's id, for the stable-id assertion after resume.
      const rev1Rows = await db
        .select()
        .from(securityFiles)
        .where(
          and(
            eq(securityFiles.engagementId, engagementId),
            eq(securityFiles.path, "/cells/01-recon/state.yml"),
            eq(securityFiles.revision, 1),
          ),
        );
      const rev1Id = rev1Rows[0].id;

      // 6. Settle child 1 (abort = a real settlement), then rule: the doc
      //    says yielding with pending work → yielded, settledAt stamped.
      await engineHost.liveSession(child1)?.abort();
      await waitFor(async () => {
        const settled = await db
          .select({ settled: childWatches.settled })
          .from(childWatches)
          .where(eq(childWatches.childSessionId, child1))
          .limit(1);
        return settled[0]?.settled === true;
      });
      const complete1 = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/security/cells/${cellId}/complete`,
        { method: "POST", headers: actingAs(sessionId), body: JSON.stringify({}) },
      );
      expect(complete1.status).toBe(200);
      const ruling1 = (await complete1.json()) as SecurityCompleteCellResponse;
      expect(ruling1.outcome).toBe("yielded");
      const yieldedRows = await db.select().from(securityCells).where(eq(securityCells.id, cellId)).limit(1);
      expect(yieldedRows[0].status).toBe("yielded");
      expect(yieldedRows[0].settledAt).not.toBeNull();

      // 7. Re-dispatch the SAME cell with mode 'resume': attempt 2, a NEW child.
      const resumeRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({ cellId, mode: "resume", threadId: runnerThread.id }),
      });
      expect(resumeRes.status).toBe(200);
      const resumed = (await resumeRes.json()) as SecurityDispatchResponse;
      expect(resumed.cell.id).toBe(cellId);
      expect(resumed.cell.status).toBe("running");
      expect(resumed.cell.attempts).toBe(2);
      const child2 = resumed.cell.childSessionId!;
      expect(child2).not.toBe(child1);

      // The dispatch prompt carries the resume contract.
      const child2Items = await engineStore.listUnsettledSubmissions(child2);
      expect(child2Items).toHaveLength(1);
      const prompt =
        typeof child2Items[0].content === "string"
          ? child2Items[0].content
          : JSON.stringify(child2Items[0].content);
      expect(prompt).toContain("Mode: resume");
      expect(prompt).toContain(
        "read your own latest state doc at /cells/01-recon/state.yml",
      );

      // 8. The NEW child reads attempt 1's checkpoint: revision 1 round-trips.
      const readBack = await fetch(
        `${api.baseUrl}/api/sessions/${child2}/security/files?path=${encodeURIComponent(
          "/cells/01-recon/state.yml",
        )}&revision=1`,
        { headers: actingAs(child2, false) },
      );
      expect(readBack.status).toBe(200);
      const readBody = (await readBack.json()) as SecurityTreeFileResponse;
      expect(readBody.revision).toBe(1);
      expect(readBody.content).toBe(YIELDING_DOC);

      // 9. Attempt 2 finishes the queue: done + zeros (revision 2), settle,
      //    complete → completed.
      const write2 = await fetch(`${api.baseUrl}/api/sessions/${child2}/security/files`, {
        method: "POST",
        headers: actingAs(child2),
        body: JSON.stringify({ path: "/cells/01-recon/state.yml", content: DONE_DOC }),
      });
      expect(write2.status).toBe(200);
      expect(((await write2.json()) as SecurityWriteFileResponse).revision).toBe(2);

      await engineHost.liveSession(child2)?.abort();
      await waitFor(async () => {
        const settled = await db
          .select({ settled: childWatches.settled })
          .from(childWatches)
          .where(eq(childWatches.childSessionId, child2))
          .limit(1);
        return settled[0]?.settled === true;
      });
      const complete2 = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/security/cells/${cellId}/complete`,
        { method: "POST", headers: actingAs(sessionId), body: JSON.stringify({}) },
      );
      expect(complete2.status).toBe(200);
      const ruling2 = (await complete2.json()) as SecurityCompleteCellResponse;
      expect(ruling2.outcome).toBe("completed");
      const doneRows = await db.select().from(securityCells).where(eq(securityCells.id, cellId)).limit(1);
      expect(doneRows[0].status).toBe("completed");
      expect(doneRows[0].attempts).toBe(2);

      // 10. Attempt 1's rows survived the yield with stable ids: the finding
      //     and the revision-1 state doc are the same rows, untouched.
      const findingRows = await db
        .select()
        .from(securityFindings)
        .where(eq(securityFindings.engagementId, engagementId));
      expect(findingRows).toHaveLength(1);
      expect(findingRows[0].id).toBe(findingId);
      expect(findingRows[0].status).toBe("open");
      const revRows = await db
        .select()
        .from(securityFiles)
        .where(
          and(
            eq(securityFiles.engagementId, engagementId),
            eq(securityFiles.path, "/cells/01-recon/state.yml"),
          ),
        );
      expect(revRows.map((r) => r.revision).sort()).toEqual([1, 2]);
      expect(revRows.find((r) => r.revision === 1)?.id).toBe(rev1Id);
      expect(revRows.find((r) => r.revision === 1)?.content).toBe(YIELDING_DOC);
    },
    60_000,
  );
});
