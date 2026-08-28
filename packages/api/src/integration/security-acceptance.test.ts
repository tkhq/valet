/**
 * M10 ACCEPTANCE SUITE (spec §Acceptance Scenarios A–E,
 * docs/specs/2026-08-27-valet-security-design.md; plan M10).
 *
 * Mechanics come from security-harness.ts — the boot, dispatch,
 * act-as-child, and settle-by-abort moves the M3–M6 suites
 * (security-settlement, security-persona, security-yield, security-triage)
 * proved one at a time. No ANTHROPIC_API_KEY and no model turn anywhere:
 * the runner thread is paused so admitted signals stay observable, and
 * children settle by abort (a real settlement — all the watcher and the
 * complete route need).
 *
 * Coverage map for steps proven elsewhere (do not duplicate):
 *   - Scenario A approval-gate payload (spec A.3 first half): the sec_start
 *     gate itself is a tool-layer concern — engine/security-tools.test.ts
 *     asserts the decision request names repo/SHA/cells/personas/cost.
 *     Here the start ROUTE (the post-approval backend) is exercised.
 *   - Scenario D part 1 (yield → yielded → resume → stable ids, spec D.1–3):
 *     security-yield.test.ts end to end. Not repeated here.
 *   - Scenario E.1 (admin verify/refute, actor user:<id>, reason required):
 *     security-triage.test.ts "human review ...".
 *   - Scenario E.2 audit event (actor, format, row count):
 *     security-triage.test.ts "exports md, sarif ...".
 *   - Scenario E.3 link chip on the findings list:
 *     security-triage.test.ts "filing: ...".
 *   - Scenario E.4 web dialog copy: M8 component tests
 *     (packages/web .../file-issue-dialog); the API-side corrective message
 *     is asserted here.
 *   - Scenario E.5 digest body builder unit coverage:
 *     services/security-issues.test.ts; the route-level digest is here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { Type } from "typebox";
import type { PluginAction, SignalContent, ValetPlugin } from "@valet/engine";
import linearPlugin from "@valet/plugin-linear/plugin";
import { bootTestApi, type TestApi } from "./_setup.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { ChildWatcher } from "../orchestrator/children.js";
import {
  agentSessions,
  securityCells,
  securityFiles,
  securityFindings,
  teamMembers,
  teams,
} from "../schema/index.js";
import type { SarifLog } from "../services/security-export.js";
import {
  actingAs,
  buildPausedRunner,
  completeCellViaRoute,
  createSecuritySession,
  dispatchViaRoute,
  EVIDENCE,
  FAKE_SHA,
  getSecurity,
  queuedPromptOf,
  reportFindingAsChild,
  runCellToCompletion,
  setPlanViaRoute,
  settleChildByAbort,
  startViaRoute,
  stateDoc,
  waitFor,
  watchSettled,
  writeFileAsChild,
} from "./security-harness.js";
import type {
  GetSecurityStatusResponse,
  ListSecurityFindingsResponse,
  SecurityCloseResponse,
  SecurityDigestIssueResponse,
  SecurityFailCellResponse,
  SecurityFileIssueResponse,
  SecurityReviewFindingResponse,
} from "../wire/types.js";

/** A second ≥200-char evidence body with a distinct file/title, so the two
 * Scenario A findings carry distinct fingerprints. */
const EVIDENCE_2 =
  "GET /api/users/:id at src/routes/users.ts reads the id from the URL and returns the row without an " +
  "ownership check: `db.select().from(users).where(eq(users.id, id))`. Any authenticated caller can " +
  "enumerate ids and read every other tenant's profile, email, and API key fingerprints — a classic IDOR.";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

// ── Local route helpers (single-scenario; shared moves live in the harness) ─

async function statusViaRoute(a: TestApi, sessionId: string): Promise<GetSecurityStatusResponse> {
  const res = await fetch(`${a.baseUrl}/api/sessions/${sessionId}/security/status`, {
    headers: actingAs(sessionId, false),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GetSecurityStatusResponse;
}

async function failCellViaRoute(
  a: TestApi,
  sessionId: string,
  cellId: string,
  reason: string,
): Promise<SecurityFailCellResponse> {
  const res = await fetch(`${a.baseUrl}/api/sessions/${sessionId}/security/cells/${cellId}/fail`, {
    method: "POST",
    headers: actingAs(sessionId),
    body: JSON.stringify({ reason }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityFailCellResponse;
}

async function closeViaRoute(a: TestApi, sessionId: string): Promise<SecurityCloseResponse> {
  const res = await fetch(`${a.baseUrl}/api/sessions/${sessionId}/security/close`, {
    method: "POST",
    headers: actingAs(sessionId),
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityCloseResponse;
}

/** sec_finding_review as the dispatched child (review cells only). */
async function reviewFindingAsChild(
  a: TestApi,
  childSessionId: string,
  findingId: string,
  body: { status: "verified" | "refuted"; reason: string },
): Promise<SecurityReviewFindingResponse> {
  const res = await fetch(
    `${a.baseUrl}/api/sessions/${childSessionId}/security/findings/${findingId}/review`,
    { method: "POST", headers: actingAs(childSessionId), body: JSON.stringify(body) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SecurityReviewFindingResponse;
}

function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ── Scenario A ──────────────────────────────────────────────────────────────

/** Spec A.2's refined plan: the preset minus the secrets sweep — 4 cells,
 * verify reads every predecessor and carries the review grant. */
const PLAN_A = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase and seed the checklist",
  "  - ordinal: 2",
  "    persona: code-review",
  "    name: authz-sweep",
  "    goal: Sweep authorization checks",
  "    reads: [1]",
  "  - ordinal: 3",
  "    persona: code-review",
  "    name: injection-sweep",
  "    goal: Sweep injection sinks",
  "    reads: [1]",
  "  - ordinal: 4",
  "    persona: code-review",
  "    name: verify",
  "    goal: Attack every open finding",
  "    reads: [1, 2, 3]",
  "    review: true",
].join("\n");

describe("acceptance scenario A: code-review engagement end to end", () => {
  it(
    "plan → start → 4 dispatched cells → findings → verify refutes → close manifest",
    async () => {
      api = await bootTestApi();
      const { db } = api.providers;

      // A.1: hub-created kind='security' session, engagement seeded planning.
      const { sessionId, engagementId } = await createSecuritySession(api);
      const seeded = await getSecurity(api, sessionId);
      expect(seeded.engagement.status).toBe("planning");
      expect(seeded.cells).toEqual([]);

      const { threadId } = await buildPausedRunner(api, sessionId);

      // A.2: the runner refines the plan ("skip the secrets sweep").
      expect(await setPlanViaRoute(api, sessionId, PLAN_A)).toBe(4);

      // A.3 (post-approval backend): cells materialize with dir and reads
      // stamped; the SHA pins; status flips to running.
      const started = await startViaRoute(api, sessionId);
      expect(started.engagement.status).toBe("running");
      expect(started.engagement.repoRef).toBe(FAKE_SHA);
      expect(started.cells.map((c) => c.dir)).toEqual([
        "01-recon",
        "02-authz-sweep",
        "03-injection-sweep",
        "04-verify",
      ]);
      expect(started.cells.map((c) => c.reads)).toEqual([[], [1], [1], [1, 2, 3]]);
      expect(started.cells.every((c) => c.status === "pending")).toBe(true);
      expect(started.cells[3].review).toBe(true);

      // A.4: dispatch cell 1 — running with a child pinned to the SHA.
      const d1 = await dispatchViaRoute(api, sessionId, threadId);
      expect(d1.cell.dir).toBe("01-recon");
      expect(d1.cell.status).toBe("running");
      expect(d1.cell.attempts).toBe(1);
      const child1 = d1.cell.childSessionId!;
      expect(child1).toBeTruthy();

      // A.5: state doc revisions drive the cell rail's live progress.
      const reconDocV1 = stateDoc({
        status: "working",
        checklist: { pending: 33, done: 14 },
        queue: { pending: 3, done: 5 },
      });
      await writeFileAsChild(api, child1, "/cells/01-recon/state.yml", reconDocV1);
      const midCell = (await getSecurity(api, sessionId)).cells[0];
      expect(midCell.progress).toEqual({
        status: "working",
        checklist: { pending: 33, done: 14 },
        queue: { pending: 3, done: 5 },
      });
      const reconDocV2 = stateDoc({
        status: "working",
        checklist: { pending: 12, done: 35 },
        queue: { pending: 1, done: 7 },
      });
      await writeFileAsChild(api, child1, "/cells/01-recon/state.yml", reconDocV2);
      expect((await getSecurity(api, sessionId)).cells[0].progress?.checklist).toEqual({
        pending: 12,
        done: 35,
      });

      // A.6: done + zeros → sec_cell_complete passes.
      const reconDone = stateDoc({ status: "done", checklist: { pending: 0, done: 47 } });
      await writeFileAsChild(api, child1, "/cells/01-recon/state.yml", reconDone);
      await settleChildByAbort(api, child1);
      const c1 = await completeCellViaRoute(api, sessionId, d1.cell.id);
      expect(c1.outcome).toBe("completed");

      // A.7: cell 2's dispatch prompt is selective — its reads cell's state
      // doc path only, never the injection cell's directory.
      const d2 = await dispatchViaRoute(api, sessionId, threadId);
      expect(d2.cell.dir).toBe("02-authz-sweep");
      const child2 = d2.cell.childSessionId!;
      const prompt2 = await queuedPromptOf(api, child2);
      expect(prompt2).toContain("/cells/02-authz-sweep/");
      expect(prompt2).toContain("- /cells/01-recon/state.yml");
      expect(prompt2).not.toContain("/cells/03-injection-sweep/");

      // The persona reads recon's state doc verbatim via sec_fs_read.
      const readBack = await fetch(
        `${api.baseUrl}/api/sessions/${child2}/security/files?path=${encodeURIComponent(
          "/cells/01-recon/state.yml",
        )}`,
        { headers: actingAs(child2, false) },
      );
      expect(readBack.status).toBe(200);
      expect(((await readBack.json()) as { content: string }).content).toBe(reconDone);

      // Two evidence-carrying findings with distinct fingerprints.
      const f1 = await reportFindingAsChild(api, child2, {
        severity: "high",
        title: "SQL injection in login handler",
        file: "src/auth/login.ts",
        line: 42,
        body: EVIDENCE,
      });
      const f2 = await reportFindingAsChild(api, child2, {
        severity: "medium",
        title: "IDOR on user profiles",
        file: "src/routes/users.ts",
        line: 7,
        body: EVIDENCE_2,
      });
      expect(f1.finding.fingerprint).not.toBe(f2.finding.fingerprint);
      expect(f1.finding.body.length).toBeGreaterThanOrEqual(200);
      expect(f2.finding.body.length).toBeGreaterThanOrEqual(200);

      await writeFileAsChild(
        api,
        child2,
        "/cells/02-authz-sweep/state.yml",
        stateDoc({ status: "done" }),
      );
      await settleChildByAbort(api, child2);
      expect((await completeCellViaRoute(api, sessionId, d2.cell.id)).outcome).toBe("completed");

      // sec_status reflects the finding counts by severity mid-engagement.
      const midStatus = await statusViaRoute(api, sessionId);
      expect(midStatus.findingCounts).toEqual({ critical: 0, high: 1, medium: 1, low: 0, info: 0 });

      // A.8 first half: cell 3 repeats (content immaterial to the scenario).
      const d3 = await runCellToCompletion(api, sessionId, threadId);
      expect(d3.cell.dir).toBe("03-injection-sweep");

      // A.8 second half: the verify cell reads ALL prior state docs and
      // refutes one finding with a reason.
      const d4 = await dispatchViaRoute(api, sessionId, threadId);
      expect(d4.cell.dir).toBe("04-verify");
      const child4 = d4.cell.childSessionId!;
      const prompt4 = await queuedPromptOf(api, child4);
      expect(prompt4).toContain("- /cells/01-recon/state.yml");
      expect(prompt4).toContain("- /cells/02-authz-sweep/state.yml");
      expect(prompt4).toContain("- /cells/03-injection-sweep/state.yml");

      const reviewed = await reviewFindingAsChild(api, child4, f2.finding.id, {
        status: "refuted",
        reason: "The route sits behind requireOwner middleware mounted in app.ts; the excerpt missed it.",
      });
      expect(reviewed.finding.status).toBe("refuted");
      expect(reviewed.finding.statusActor).toBe(d4.cell.id);

      await writeFileAsChild(api, child4, "/cells/04-verify/state.yml", stateDoc({ status: "done" }));
      await settleChildByAbort(api, child4);
      expect((await completeCellViaRoute(api, sessionId, d4.cell.id)).outcome).toBe("completed");

      // A.9: sec_close computes the manifest; the engagement completes.
      const { manifest } = await closeViaRoute(api, sessionId);
      expect(manifest.status).toBe("completed");
      expect(manifest.repoRef).toBe(FAKE_SHA);
      expect(manifest.cells).toHaveLength(4);
      expect(manifest.cells.every((c) => c.status === "completed" && c.attempts === 1)).toBe(true);
      expect(manifest.cells.find((c) => c.dir === "01-recon")?.stateDocRevisions).toBe(3);
      expect(manifest.findings.total).toBe(2);
      expect(manifest.findings.distinctBySeverity).toEqual({
        critical: 0,
        high: 1,
        medium: 1,
        low: 0,
        info: 0,
      });
      expect(manifest.findings.statusBreakdown).toEqual({ open: 1, verified: 0, refuted: 1 });
      expect(manifest.findings.filedLinks).toBe(0);

      // A.10: REST reflects the final state — cells all completed, findings
      // carry empty links and the refuted status with the verify cell as
      // actor. (The GitHub blob link is derived client-side from repoRef —
      // the pinned SHA asserted above — per spec deviation: the wire carries
      // rows, not rendered links.)
      const finalSecurity = await getSecurity(api, sessionId);
      expect(finalSecurity.engagement.status).toBe("completed");
      expect(finalSecurity.cells.every((c) => c.status === "completed")).toBe(true);

      const list = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/findings`);
      const listBody = (await list.json()) as ListSecurityFindingsResponse;
      expect(listBody.findings).toHaveLength(2);
      expect(listBody.findings.every((f) => f.links?.length === 0)).toBe(true);
      const refuted = listBody.findings.find((f) => f.id === f2.finding.id);
      expect(refuted?.status).toBe("refuted");
      expect(refuted?.statusActor).toBe(d4.cell.id);
      expect(refuted?.statusReason).toContain("requireOwner");
      expect(finalSecurity.engagement.id).toBe(engagementId);
    },
    120_000,
  );
});

// ── Scenario B ──────────────────────────────────────────────────────────────

const PLAN_B = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase",
  "  - ordinal: 2",
  "    persona: code-review",
  "    name: authz-sweep",
  "    goal: Sweep authorization checks",
  "    reads: [1]",
].join("\n");

describe("acceptance scenario B: api restart is a non-event", () => {
  /**
   * Restart emulation, in-process. What a real restart loses is IN-MEMORY
   * state: the engine host's session cache and the ChildWatcher's armed
   * awaiters. This test drops exactly that — `engineHost.evictAll()` (the
   * documented process-shutdown path: cache gone, durable rows untouched) —
   * then mirrors main.ts's boot sequence over the same PGlite db:
   * materialize every session with unsettled submissions (`sessionFor`,
   * the `restoreUnsettledSessions` move) and `rearm()` a FRESH ChildWatcher
   * (a new process's watcher starts empty).
   *
   * What this proves: recovery is driven ENTIRELY by durable rows — the
   * unsettled child_watches row, the queued submission, the security_cells
   * claim — and the rearm path delivers the child.settled signal exactly
   * once after the "restart", with no re-dispatch and no id churn.
   *
   * What this skips: the process boundary itself (fresh WASM db handle,
   * module state). orchestrator-restart.test.ts proves that half for the
   * same spawn/watch/rearm machinery with a real SIGKILL; repeating it here
   * would gate this suite on ANTHROPIC_API_KEY for no new coverage.
   */
  it(
    "evict + rearm over the same db: attempts stays 1, ids stable, signal lands post-restart",
    async () => {
      api = await bootTestApi();
      const { db, engineHost, engineStore, prebuildService } = api.providers;

      const { sessionId, engagementId } = await createSecuritySession(api);
      const { threadId } = await buildPausedRunner(api, sessionId);
      await setPlanViaRoute(api, sessionId, PLAN_B);
      await startViaRoute(api, sessionId);

      // Cell 1 completes pre-restart, leaving durable rows to check later.
      const d1 = await dispatchViaRoute(api, sessionId, threadId);
      const child1 = d1.cell.childSessionId!;
      await writeFileAsChild(api, child1, "/cells/01-recon/state.yml", stateDoc({ status: "done" }));
      const finding1 = await reportFindingAsChild(api, child1, {
        severity: "high",
        title: "SQL injection in login handler",
        file: "src/auth/login.ts",
        line: 42,
        body: EVIDENCE,
      });
      await settleChildByAbort(api, child1);
      expect((await completeCellViaRoute(api, sessionId, d1.cell.id)).outcome).toBe("completed");

      // Dispatch cell 2 and do NOT settle it. Pause the child so the
      // no-API-key claim cannot settle the submission before the "crash" —
      // the crash must land mid-cell-2 (spec B.1).
      const d2 = await dispatchViaRoute(api, sessionId, threadId);
      const cell2Id = d2.cell.id;
      const child2 = d2.cell.childSessionId!;
      expect(d2.cell.attempts).toBe(1);
      await engineHost.liveSession(child2)?.pause();

      // Cell 2's own pre-crash work: a checkpoint and a finding.
      await writeFileAsChild(
        api,
        child2,
        "/cells/02-authz-sweep/state.yml",
        stateDoc({ status: "working", queue: { pending: 4, done: 2 } }),
      );
      const finding2 = await reportFindingAsChild(api, child2, {
        severity: "medium",
        title: "IDOR on user profiles",
        file: "src/routes/users.ts",
        line: 7,
        body: EVIDENCE_2,
      });

      // Pre-crash durable ids: the yield-suite move — these must survive.
      const fileIdsBefore = (
        await db
          .select({ id: securityFiles.id })
          .from(securityFiles)
          .where(eq(securityFiles.engagementId, engagementId))
      )
        .map((r) => r.id)
        .sort();
      const findingIdsBefore = (
        await db
          .select({ id: securityFindings.id })
          .from(securityFindings)
          .where(eq(securityFindings.engagementId, engagementId))
      )
        .map((r) => r.id)
        .sort();
      expect(findingIdsBefore).toEqual([finding1.finding.id, finding2.finding.id].sort());
      expect(await watchSettled(db, child2)).toBe(false);

      // ── The "restart": drop all in-memory session state. ──
      engineHost.evictAll();
      expect(engineHost.liveSession(child2)).toBeNull();
      expect(engineHost.liveSession(sessionId)).toBeNull();

      // ── Boot, mirroring main.ts: restore unsettled sessions, re-arm. ──
      const unsettledIds = await engineStore.listSessionIdsWithUnsettledSubmissions();
      expect(unsettledIds).toContain(child2);
      for (const id of unsettledIds) {
        const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
        if (!rows[0]) continue;
        const restored = await engineHost.sessionFor(id, await loadSessionMeta(db, rows[0]));
        // The runner's queued signals must stay observable, exactly as the
        // pre-crash buildPausedRunner arranged.
        if (id === sessionId) await restored.pause();
      }
      // A new process's watcher has no in-memory arms; rearm() re-observes
      // every unsettled durable watch (spec B.2 — ChildWatcher.rearm).
      const rebootWatcher = new ChildWatcher({ db, engineHost, engineStore, prebuildService });
      await rebootWatcher.rearm();

      // B.4: no re-dispatch happened — same attempt, same child, cell 1
      // untouched, every pre-crash row id intact.
      const cell2Rows = await db.select().from(securityCells).where(eq(securityCells.id, cell2Id)).limit(1);
      expect(cell2Rows[0].status).toBe("running");
      expect(cell2Rows[0].attempts).toBe(1);
      expect(cell2Rows[0].childSessionId).toBe(child2);
      const cell1Rows = await db.select().from(securityCells).where(eq(securityCells.id, d1.cell.id)).limit(1);
      expect(cell1Rows[0].status).toBe("completed");
      expect(cell1Rows[0].attempts).toBe(1);

      // B.2/B.3: the child settles post-restart with no user action on the
      // watch, and the re-armed watcher wakes the runner. Abort stands in
      // for the child's own settle, as everywhere in these suites.
      await engineHost.liveSession(child2)?.abort();
      await waitFor(() => watchSettled(db, child2), 20_000, "post-restart watch settle");

      const unsettled = await engineStore.listUnsettledSubmissions(sessionId);
      const child2Signals = unsettled.filter(
        (item) =>
          typeof item.content === "object" &&
          item.content !== null &&
          "kind" in item.content &&
          item.content.kind === "signal" &&
          (item.content as SignalContent).signalType === "child.settled" &&
          (item.content as SignalContent).attributes?.child_session_id === child2,
      );
      // Exactly one — the deterministic dispatchId dedups the rearm against
      // any pre-crash arm (the orchestrator-restart suite's guarantee).
      expect(child2Signals).toHaveLength(1);
      expect(child2Signals[0].threadId).toBe(threadId);

      // Ids after the restart: unchanged, byte for byte.
      const fileIdsAfter = (
        await db
          .select({ id: securityFiles.id })
          .from(securityFiles)
          .where(eq(securityFiles.engagementId, engagementId))
      )
        .map((r) => r.id)
        .sort();
      const findingIdsAfter = (
        await db
          .select({ id: securityFindings.id })
          .from(securityFindings)
          .where(eq(securityFindings.engagementId, engagementId))
      )
        .map((r) => r.id)
        .sort();
      expect(fileIdsAfter).toEqual(fileIdsBefore);
      expect(findingIdsAfter).toEqual(findingIdsBefore);

      // B.3 tail: the loop continues through sec_cell_complete — the claim
      // survived the restart, so the child finishes its doc and completes.
      await writeFileAsChild(api, child2, "/cells/02-authz-sweep/state.yml", stateDoc({ status: "done" }));
      const ruling = await completeCellViaRoute(api, sessionId, cell2Id);
      expect(ruling.outcome).toBe("completed");
      expect(ruling.cell?.attempts).toBe(1);
    },
    120_000,
  );
});

// ── Scenario C ──────────────────────────────────────────────────────────────

const PLAN_ONE_CELL = [
  "cells:",
  "  - ordinal: 1",
  "    persona: code-review",
  "    name: recon",
  "    goal: Map the codebase",
].join("\n");

describe("acceptance scenario C: exit condition enforced", () => {
  it(
    "done with queue.pending 2 → named violation, cell stays running → corrected doc → completed",
    async () => {
      api = await bootTestApi();
      const { db } = api.providers;

      const { sessionId } = await createSecuritySession(api);
      const { threadId } = await buildPausedRunner(api, sessionId);
      await setPlanViaRoute(api, sessionId, PLAN_ONE_CELL);
      await startViaRoute(api, sessionId);

      const d1 = await dispatchViaRoute(api, sessionId, threadId);
      const cellId = d1.cell.id;
      const child = d1.cell.childSessionId!;

      // C.1: the persona settles while the doc claims done with queue work
      // left.
      await writeFileAsChild(
        api,
        child,
        "/cells/01-recon/state.yml",
        stateDoc({ status: "done", queue: { pending: 2, done: 20 } }),
      );
      await settleChildByAbort(api, child);

      // C.2: sec_cell_complete refuses, naming the violation.
      const violated = await completeCellViaRoute(api, sessionId, cellId);
      expect(violated.outcome).toBe("violation");
      expect(violated.violation).toContain("queue.pending is 2");

      // The cell never showed completed before the pass (spec C.4): the row
      // is still running after the violation ruling.
      const midRows = await db.select().from(securityCells).where(eq(securityCells.id, cellId)).limit(1);
      expect(midRows[0].status).toBe("running");
      expect(midRows[0].settledAt).toBeNull();

      // C.3: the runner steers with child_send ("keep looping"). The steer
      // machinery is generic children.ts plumbing; what matters here is its
      // EFFECT — the same child (its write claim lives while the cell runs)
      // drains the queue and writes a corrected final doc. The durable watch
      // stays settled the whole time.
      expect(await watchSettled(db, child)).toBe(true);
      const corrected = await writeFileAsChild(
        api,
        child,
        "/cells/01-recon/state.yml",
        stateDoc({ status: "done", queue: { pending: 0, done: 22 } }),
      );
      expect(corrected.revision).toBe(2);

      // C.4: the re-ruling passes.
      const passed = await completeCellViaRoute(api, sessionId, cellId);
      expect(passed.outcome).toBe("completed");
      const doneRows = await db.select().from(securityCells).where(eq(securityCells.id, cellId)).limit(1);
      expect(doneRows[0].status).toBe("completed");
      expect(doneRows[0].attempts).toBe(1);
    },
    60_000,
  );
});

// ── Scenario D ──────────────────────────────────────────────────────────────

describe("acceptance scenario D: yield and child death", () => {
  // D.1–D.3 (yield → yielded ruling → resume dispatch → fresh child reads
  // its own state doc → stable finding/file ids): proven end to end by
  // security-yield.test.ts. Not duplicated here.

  it(
    "D.4: child destroyed without settling → status shows childGone → fail → resume completes on attempt 2",
    async () => {
      api = await bootTestApi();

      const { sessionId } = await createSecuritySession(api);
      const { threadId } = await buildPausedRunner(api, sessionId);
      await setPlanViaRoute(api, sessionId, PLAN_ONE_CELL);
      await startViaRoute(api, sessionId);

      const d1 = await dispatchViaRoute(api, sessionId, threadId);
      const cellId = d1.cell.id;
      const child1 = d1.cell.childSessionId!;

      // The child is destroyed out from under the cell — the session DELETE
      // is the "sandbox reclaimed" stand-in: it tears down the engine
      // session and soft-deletes the row, which is exactly what the child
      // status reader reports as gone. Deliberately NOT an abort-settle.
      const deleted = await fetch(`${api.baseUrl}/api/sessions/${child1}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);

      // sec_status shows the child gone; the cell stays running — nothing
      // auto-repairs (spec §Invariants).
      const status = await statusViaRoute(api, sessionId);
      expect(status.runningChild).not.toBeNull();
      expect(status.runningChild?.cellId).toBe(cellId);
      expect(status.runningChild?.childGone).toBe(true);
      expect(status.cells[0].status).toBe("running");

      // The runner rules explicitly: fail with a reason, then re-dispatch.
      const failed = await failCellViaRoute(
        api,
        sessionId,
        cellId,
        "The cell's child session is gone without settling. Re-dispatch with mode resume.",
      );
      expect(failed.cell.status).toBe("failed");

      const resumed = await dispatchViaRoute(api, sessionId, threadId, { cellId, mode: "resume" });
      expect(resumed.cell.id).toBe(cellId);
      expect(resumed.cell.attempts).toBe(2);
      const child2 = resumed.cell.childSessionId!;
      expect(child2).not.toBe(child1);

      // Attempt 2 completes normally.
      await writeFileAsChild(api, child2, "/cells/01-recon/state.yml", stateDoc({ status: "done" }));
      await settleChildByAbort(api, child2);
      const ruling = await completeCellViaRoute(api, sessionId, cellId);
      expect(ruling.outcome).toBe("completed");
      expect(ruling.cell?.attempts).toBe(2);
    },
    60_000,
  );
});

// ── Scenario E ──────────────────────────────────────────────────────────────

/** A fake plugin-github stand-in: same service + action id the filing route
 * invokes, counting calls and answering the create_issue response shape.
 * The REAL invoker seam runs — availability, discovery, argument
 * validation — only the provider call is faked. */
function fakeGithubPlugin(): { plugin: ValetPlugin; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const createIssue: PluginAction = {
    id: "github.create_issue",
    name: "Create issue",
    description: "Acceptance-suite fake of plugin-github's create_issue.",
    riskLevel: "low",
    parameters: Type.Object({
      owner: Type.String(),
      repo: Type.String(),
      title: Type.String(),
      body: Type.String(),
    }),
    execute: async (args) => {
      calls.push({ ...(args as Record<string, unknown>) });
      const number = 100 + calls.length;
      return {
        success: true,
        data: { number, html_url: `https://github.com/acme/api/issues/${number}` },
      };
    },
  };
  const plugin: ValetPlugin = {
    name: "github",
    version: "0.0.1",
    actions: [{ service: "github", actions: [createIssue] }],
  };
  return { plugin, calls };
}

describe("acceptance scenario E: triage, export, file issues (API half)", () => {
  // E.1 (admin verify/refute + actor user:<id> + reason ladder) and the
  // E.2 audit row and E.3 link chip live in security-triage.test.ts — see
  // the coverage map at the top of this file. Here: the gaps — SARIF
  // provenance from a STARTED engagement (pinned SHA), route-level filing
  // through a faked provider with a call count, the digest body, the
  // Linear corrective message, and the non-admin 403.

  it(
    "SARIF provenance + filters, idempotent filing (one provider call), digest body, Linear corrective 400",
    async () => {
      const github = fakeGithubPlugin();
      api = await bootTestApi({ plugins: [github.plugin, linearPlugin] });
      const { db } = api.providers;

      // A started engagement, so the export carries the pinned SHA.
      const { sessionId, engagementId } = await createSecuritySession(api);
      await startViaRoute(api, sessionId);

      const seedFinding = async (
        overrides: Partial<typeof securityFindings.$inferInsert> & { id: string },
      ) => {
        await db.insert(securityFindings).values({
          engagementId,
          cellId: "cell_x",
          fingerprint: `fp_${overrides.id}`,
          severity: "high",
          title: "SQL injection in login handler",
          file: "src/auth/login.ts",
          line: 42,
          body: EVIDENCE,
          status: "open",
          createdAt: Date.now(),
          ...overrides,
        });
      };
      await seedFinding({ id: "fnd_high", createdAt: 1_000 });
      await seedFinding({
        id: "fnd_med",
        severity: "medium",
        title: "IDOR on user profiles",
        file: "src/routes/users.ts",
        line: 7,
        body: EVIDENCE_2,
        createdAt: 2_000,
      });
      await seedFinding({
        id: "fnd_refuted",
        severity: "low",
        title: "verbose logging",
        file: "src/lib/log.ts",
        line: 3,
        status: "refuted",
        statusReason: "log level is debug-only",
        statusActor: "user:local-user",
        createdAt: 3_000,
      });

      const base = `${api.baseUrl}/api/sessions/${sessionId}/security`;

      // E.2: unfiltered SARIF carries all rows; suppressions ONLY on the
      // refuted one; versionControlProvenance pins the fake SHA.
      const full = (await (await fetch(`${base}/export?format=sarif`)).json()) as SarifLog;
      expect(full.runs[0].results).toHaveLength(3);
      expect(full.runs[0].versionControlProvenance[0].revisionId).toBe(FAKE_SHA);
      const suppressed = full.runs[0].results.filter((r) => r.suppressions !== undefined);
      expect(suppressed.map((r) => r.ruleId)).toEqual(["fp_fnd_refuted"]);
      expect(suppressed[0].suppressions).toEqual([
        { kind: "external", status: "accepted", justification: "log level is debug-only" },
      ]);

      // A filtered export EXCLUDES the out-of-scope rows.
      const filtered = (
        await (await fetch(`${base}/export?format=sarif&severity=high`)).json()
      ) as SarifLog;
      expect(filtered.runs[0].results).toHaveLength(1);
      expect(filtered.runs[0].results[0].ruleId).toBe("fp_fnd_high");

      // E.3: filing goes through the invoker with the acting user's
      // credentials; a repeat returns the existing link WITHOUT a second
      // provider call.
      const first = await postJson(`${base}/findings/fnd_high/issues`, { provider: "github" });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as SecurityFileIssueResponse;
      expect(firstBody.created).toBe(true);
      expect(firstBody.link.provider).toBe("github");
      expect(firstBody.link.url).toBe("https://github.com/acme/api/issues/101");
      expect(github.calls).toHaveLength(1);
      expect(github.calls[0].owner).toBe("acme");
      expect(github.calls[0].repo).toBe("api");

      const repeat = await postJson(`${base}/findings/fnd_high/issues`, { provider: "github" });
      expect(repeat.status).toBe(200);
      const repeatBody = (await repeat.json()) as SecurityFileIssueResponse;
      expect(repeatBody.created).toBe(false);
      expect(repeatBody.link.id).toBe(firstBody.link.id);
      expect(github.calls).toHaveLength(1);

      // E.5: ONE digest issue whose body lists every finding's title.
      const digest = await postJson(`${base}/issues/digest`, {
        provider: "github",
        findingIds: ["fnd_high", "fnd_med", "fnd_refuted"],
      });
      expect(digest.status).toBe(200);
      const digestBody = (await digest.json()) as SecurityDigestIssueResponse;
      expect(digestBody.url).toBe("https://github.com/acme/api/issues/102");
      expect(github.calls).toHaveLength(2);
      const digestIssueBody = String(github.calls[1].body);
      expect(digestIssueBody).toContain("SQL injection in login handler");
      expect(digestIssueBody).toContain("IDOR on user profiles");
      expect(digestIssueBody).toContain("verbose logging");
      // The digest writes NO link rows, so a per-finding filing for fnd_med
      // would still call the provider (asserted at the unit level in
      // services/security-issues.test.ts).

      // E.4: Linear is present in the registry but disconnected — the error
      // names the corrective action, verbatim from the dialog's copy.
      const linear = await postJson(`${base}/findings/fnd_med/issues`, {
        provider: "linear",
        teamId: "SEC",
      });
      expect(linear.status).toBe(400);
      expect(((await linear.json()) as { error: string }).error).toBe(
        "Connect the Linear integration in Settings.",
      );
    },
    60_000,
  );

  it("E.1 tail: a non-admin viewer's status flip answers 403 naming the right", async () => {
    api = await bootTestApi();
    const { db } = api.providers;

    // A team-owned session: test-member can view but not administer (the
    // full ladder — reason required, forward-only, actor stamp — lives in
    // security-triage.test.ts).
    const now = Date.now();
    await db.insert(teams).values({ id: "team_e", orgId: "local-org", name: "Sec", createdAt: now });
    await db.insert(teamMembers).values([
      { teamId: "team_e", userId: "local-user", role: "member" },
      { teamId: "team_e", userId: "test-member", role: "member" },
    ]);
    const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspace: "/tmp/valet-sec-acceptance-e1",
        kind: "security",
        repo: { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: FAKE_SHA },
        teamId: "team_e",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };
    const security = await fetch(`${api.baseUrl}/api/sessions/${created.id}/security`);
    const { engagement } = (await security.json()) as { engagement: { id: string } };
    await db.insert(securityFindings).values({
      id: "fnd_e1",
      engagementId: engagement.id,
      cellId: "cell_x",
      fingerprint: "fp_e1",
      severity: "high",
      title: "IDOR on sessions",
      file: "src/routes/sessions.ts",
      line: 42,
      body: EVIDENCE,
      status: "open",
      createdAt: now,
    });

    const denied = await postJson(
      `${api.baseUrl}/api/sessions/${created.id}/security/findings/fnd_e1/status`,
      { status: "refuted", reason: "not exploitable" },
      { "x-valet-test-user-id": "test-member" },
    );
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error: string };
    expect(deniedBody.error).toContain("canAdministerSession");

    // The finding is untouched.
    const rows = await db
      .select()
      .from(securityFindings)
      .where(and(eq(securityFindings.id, "fnd_e1"), eq(securityFindings.engagementId, engagement.id)));
    expect(rows[0].status).toBe("open");
  });
});
