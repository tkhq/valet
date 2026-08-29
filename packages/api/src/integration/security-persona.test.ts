/**
 * THE PERSONA ROUND TRIP (plan M4): one dispatch through the real route,
 * then the dispatched child acts over the internal persona routes exactly
 * as the `sec_*` persona tools do — child's own session id in the URL and
 * in `x-valet-session-id`; the route resolves the cell claim
 * (`security_cells.child_session_id`) and finds the engagement FROM it.
 *
 * Proves, end to end on the virtual sandbox:
 *   - the write claim (own state.yml lands; a peer-directory write is
 *     refused naming the actor's directory),
 *   - evidence-gated finding reports (fingerprint returned),
 *   - review gating (a non-review cell cannot flip statuses; the review
 *     cell can),
 *   - the /protocol.md mount is readable through the claim,
 *   - the HOST attachment: the dispatched child's session build carries the
 *     persona tool set (sec_finding_review only on the review cell), the
 *     code-review role, the tool endpoint config, and NO childSpawner —
 *     both at spawn (the claim is stamped BEFORE the child is built) and on
 *     a post-evict rebuild through the generic `sessionFor` path.
 *
 * No ANTHROPIC_API_KEY and no model turn: the runner thread is paused, and
 * the children are settled by aborting them (the settlement suite's
 * precedent — abort settles queued and in-flight work alike).
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "./_setup.js";
import { internalToken } from "../lib/internal-auth.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { agentSessions, childWatches, securityCells } from "../schema/index.js";
import type {
  CreateSessionResponse,
  SecurityCompleteCellResponse,
  SecurityDispatchResponse,
  SecurityReportFindingResponse,
  SecurityReviewFindingResponse,
  SecurityTreeFileResponse,
  SecurityWriteFileResponse,
} from "../wire/types.js";

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA };

/** Two cells: 01-recon (plain) and 02-verify (review, reads 01). */
const PLAN = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase",
  "  - ordinal: 2",
  "    persona: code-review",
  "    name: verify",
  "    goal: Verify findings",
  "    reads: [1]",
  "    review: true",
].join("\n");

// The recon cell (01-recon, persona code-review) writes its own done doc.
// Strict: every required key, plus cell/persona naming THIS cell.
const DONE_STATE_DOC = [
  "protocol_version: 1",
  "cell: 01-recon",
  "persona: code-review",
  "status: done",
  "checklist:",
  "  pending: 0",
  "  done: 3",
  "queue:",
  "  pending: 0",
  "  done: 3",
  "findings: []",
  "log: []",
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

/** Headers the persona tools send: internal token + the CHILD as acting session. */
function actingAs(sessionId: string, json = true): Record<string, string> {
  return {
    "x-valet-internal": internalToken(),
    "x-valet-session-id": sessionId,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

describe("api integration: persona round trip over the cell claim", () => {
  it(
    "dispatch → persona writes state + finding → settle → complete → review cell verifies",
    async () => {
      api = await bootTestApi();
      const { db, engineHost, engineStore } = api.providers;

      // 1. A real hub-created security session, plan replaced with 2 cells.
      const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: `/tmp/valet-sec-persona-${randomUUID()}`,
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

      // 2. Build + pause the runner (the spawner authorizes against the
      //    parent's engine row; pausing keeps doomed no-key turns unclaimed).
      const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
      const runner = await engineHost.sessionFor(sessionId, await loadSessionMeta(db, rows[0]));
      const runnerThread = runner.thread("web:default");
      await runner.pause();

      // 3. Start service-level: a 40-hex ref short-circuits SHA resolution
      //    offline (the start route's resolution is the tools suite's job).
      await service.startEngagement(engagementId, { resolvedSha: SHA });

      // 4. Dispatch cell 1 through the REAL route.
      const dispatchRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({ threadId: runnerThread.id }),
      });
      expect(dispatchRes.status).toBe(200);
      const dispatched = (await dispatchRes.json()) as SecurityDispatchResponse;
      const child1 = dispatched.cell.childSessionId!;
      expect(child1).toBeTruthy();

      // 5. HOST ATTACHMENT, spawn-time build: the claim was stamped before
      //    the child was built, so the cached session already carries the
      //    persona set — no review tool (cell 1 is plain), no sec_dispatch,
      //    no spawner, and the code-review role is registered.
      const child1Session = engineHost.liveSession(child1);
      expect(child1Session).not.toBeNull();
      // The persona inherits the runner's model — the runner defaulted to the
      // capable security model, so the persona runs on it, not the haiku floor.
      expect(child1Session!.options.model.id).toBe("claude-sonnet-4-6");
      const child1Tools = (child1Session!.options.tools ?? []).map((t) => t.name);
      expect(child1Tools).toContain("sec_fs_write");
      expect(child1Tools).toContain("sec_fs_read");
      expect(child1Tools).toContain("sec_finding_report");
      expect(child1Tools).not.toContain("sec_finding_review");
      expect(child1Tools).not.toContain("sec_dispatch");
      expect(child1Tools).not.toContain("task");
      expect(child1Session!.options.toolConfig?.childSpawner).toBeUndefined();
      expect(typeof child1Session!.options.toolConfig?.internalToken).toBe("string");
      expect((child1Session!.options.roles ?? []).map((r) => r.name)).toContain("code-review");

      // The dispatch prompt rides the child's queued submission with the
      // persona role selected for the turn.
      const child1Items = await engineStore.listUnsettledSubmissions(child1);
      expect(child1Items).toHaveLength(1);
      expect(child1Items[0].role).toBe("code-review");

      // 6. Act AS child 1 over the internal routes (what the persona tools do).
      // Own state doc → 200, revision 1.
      const writeOwn = await fetch(`${api.baseUrl}/api/sessions/${child1}/security/files`, {
        method: "POST",
        headers: actingAs(child1),
        body: JSON.stringify({ path: "/cells/01-recon/state.yml", content: DONE_STATE_DOC }),
      });
      expect(writeOwn.status).toBe(200);
      const written = (await writeOwn.json()) as SecurityWriteFileResponse;
      expect(written).toEqual({ path: "/cells/01-recon/state.yml", revision: 1 });

      // Peer-directory write → refused, naming the actor's own directory.
      const writePeer = await fetch(`${api.baseUrl}/api/sessions/${child1}/security/files`, {
        method: "POST",
        headers: actingAs(child1),
        body: JSON.stringify({ path: "/cells/02-verify/x.md", content: "not mine" }),
      });
      expect(writePeer.status).toBe(409);
      const peerBody = (await writePeer.json()) as { error: string };
      expect(peerBody.error).toBe(
        "Write refused: /cells/02-verify/x.md is outside your cell directory /cells/01-recon/.",
      );

      // Evidence-carrying finding → 200 with a fingerprint.
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
      expect(reported.finding.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(reported.finding.status).toBe("open");
      expect(reported.siblings).toEqual([]);
      const findingId = reported.finding.id;

      // A NON-review cell must not flip statuses (spec threat 8).
      const badReview = await fetch(
        `${api.baseUrl}/api/sessions/${child1}/security/findings/${findingId}/review`,
        {
          method: "POST",
          headers: actingAs(child1),
          body: JSON.stringify({ status: "refuted", reason: "trying to bury my peer's finding" }),
        },
      );
      expect(badReview.status).toBe(409);
      const badReviewBody = (await badReview.json()) as { error: string };
      expect(badReviewBody.error).toBe("Only review cells may flip finding statuses.");

      // The read-only protocol mount is reachable through the claim.
      const protocolRes = await fetch(
        `${api.baseUrl}/api/sessions/${child1}/security/files?path=${encodeURIComponent("/protocol.md")}`,
        { headers: actingAs(child1, false) },
      );
      expect(protocolRes.status).toBe(200);
      const protocol = (await protocolRes.json()) as SecurityTreeFileResponse;
      expect(protocol.content).toContain("protocol_version");

      // 7. Settle child 1 (abort = a real settlement, M3 precedent), then
      //    rule on the cell: the state doc says done + zeros → completed.
      await engineHost.liveSession(child1)?.abort();
      await waitFor(async () => {
        const settled = await db
          .select({ settled: childWatches.settled })
          .from(childWatches)
          .where(eq(childWatches.childSessionId, child1))
          .limit(1);
        return settled[0]?.settled === true;
      });
      const completeRes = await fetch(
        `${api.baseUrl}/api/sessions/${sessionId}/security/cells/${dispatched.cell.id}/complete`,
        { method: "POST", headers: actingAs(sessionId), body: JSON.stringify({}) },
      );
      expect(completeRes.status).toBe(200);
      const ruling = (await completeRes.json()) as SecurityCompleteCellResponse;
      expect(ruling.outcome).toBe("completed");

      // A completed cell's claim no longer resolves: acting as child 1 is
      // now a claimless persona call.
      const staleWrite = await fetch(`${api.baseUrl}/api/sessions/${child1}/security/files`, {
        method: "POST",
        headers: actingAs(child1),
        body: JSON.stringify({ path: "/cells/01-recon/late.md", content: "too late" }),
      });
      expect(staleWrite.status).toBe(403);
      expect(((await staleWrite.json()) as { error: string }).error).toBe(
        "This session is not a dispatched persona cell.",
      );

      // 8. Dispatch cell 2 (the review cell) and act as its child.
      const dispatch2Res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
        method: "POST",
        headers: actingAs(sessionId),
        body: JSON.stringify({ threadId: runnerThread.id }),
      });
      expect(dispatch2Res.status).toBe(200);
      const dispatched2 = (await dispatch2Res.json()) as SecurityDispatchResponse;
      const child2 = dispatched2.cell.childSessionId!;

      // Selective context on the wire: cell 2's dispatch prompt names its
      // own directory and its reads cell's state doc, nothing else's.
      const child2Items = await engineStore.listUnsettledSubmissions(child2);
      expect(child2Items).toHaveLength(1);
      expect(child2Items[0].role).toBe("code-review");
      const prompt2 =
        typeof child2Items[0].content === "string"
          ? child2Items[0].content
          : JSON.stringify(child2Items[0].content);
      expect(prompt2).toContain("/cells/02-verify/");
      expect(prompt2).toContain("- /cells/01-recon/state.yml");

      // The review cell's build carries sec_finding_review.
      const child2Session = engineHost.liveSession(child2);
      const child2Tools = (child2Session!.options.tools ?? []).map((t) => t.name);
      expect(child2Tools).toContain("sec_fs_write");
      expect(child2Tools).toContain("sec_finding_review");
      expect(child2Tools).not.toContain("sec_dispatch");

      // Acting as the review cell's child, the flip lands.
      const goodReview = await fetch(
        `${api.baseUrl}/api/sessions/${child2}/security/findings/${findingId}/review`,
        {
          method: "POST",
          headers: actingAs(child2),
          body: JSON.stringify({ status: "verified", reason: "reproduced the injection from the excerpt" }),
        },
      );
      expect(goodReview.status).toBe(200);
      const reviewed = (await goodReview.json()) as SecurityReviewFindingResponse;
      expect(reviewed.finding.status).toBe("verified");
      const cell2Rows = await db
        .select()
        .from(securityCells)
        .where(eq(securityCells.id, dispatched2.cell.id))
        .limit(1);
      expect(reviewed.finding.statusActor).toBe(cell2Rows[0].id);

      // 9. The post-restart path: settle child 2, evict it, rebuild through
      //    the generic sessionFor — the claim lookup re-attaches the
      //    persona set (cell 2 is still running until the runner rules).
      await engineHost.liveSession(child2)?.abort();
      engineHost.evictCache(child2);
      const child2Rows = await db.select().from(agentSessions).where(eq(agentSessions.id, child2)).limit(1);
      const rebuilt = await engineHost.sessionFor(child2, await loadSessionMeta(db, child2Rows[0]));
      const rebuiltTools = (rebuilt.options.tools ?? []).map((t) => t.name);
      expect(rebuiltTools).toContain("sec_fs_write");
      expect(rebuiltTools).toContain("sec_finding_review");
      expect(rebuiltTools).not.toContain("sec_dispatch");
      expect((rebuilt.options.roles ?? []).map((r) => r.name)).toContain("code-review");
      await rebuilt.pause();
    },
    60_000,
  );
});
