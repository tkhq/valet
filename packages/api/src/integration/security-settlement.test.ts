/**
 * THE SETTLEMENT SEAM PROOF (spec §Dependencies "Settlement signals to a
 * non-orchestrator parent"; plan M3 checkpoint).
 *
 * The security runner is a hub-created session — engine purpose
 * `interactive`, not `orchestrator`. The loop's self-advance depends on the
 * dispatched cell child's `child.settled` signal being ADMITTED to that
 * interactive parent by `admitSignal`'s edge ACL (orchestrator/signals.ts).
 *
 * Investigation result, pinned by this suite: the ACL's rule (a) —
 * parent <-> child, either direction, judged from the child's durable
 * `parentSessionId` — is purpose-agnostic, so the edge is ALREADY admitted
 * for an interactive parent. No signals.ts change was needed; this test is
 * the tripwire that keeps it that way.
 *
 * No ANTHROPIC_API_KEY and no model turn: the runner thread is paused so
 * the admitted signal stays observable in its queue, and the child's real
 * dispatched submission is settled by aborting the child session (the
 * engine settles queued AND in-flight work `aborted` — a real settlement
 * outcome, which is all the watcher needs).
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SignalContent } from "@valet/engine";
import { bootTestApi, type TestApi } from "./_setup.js";
import {
  actingAs,
  buildPausedRunner,
  completeCellViaRoute,
  createSecuritySession,
  dispatchViaRoute,
  setPlanViaRoute,
  settleChildByAbort,
  startViaRoute,
  stateDoc,
  writeFileAsChild,
} from "./security-harness.js";
import { internalToken } from "../lib/internal-auth.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { openBackgroundWork } from "../engine/wakeups-admin.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import {
  clearSecurityCredentialSession,
  hasSecurityCredentialValues,
  registerSecurityCredentialValue,
  SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
} from "../services/security-credential-tripwire.js";
import { agentSessions, childWatches, eventDropLog, securityCells } from "../schema/index.js";
import type { CreateSessionResponse, SecurityDispatchResponse } from "../wire/types.js";

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA };

const ONE_CELL_PLAN = ["cells:", "  - ordinal: 1", "    persona: code-review", "    name: recon", "    goal: Map the codebase"].join("\n");
const LEAKED = "sk-live-settlement-0123456789abcdef";

let api: TestApi | undefined;
const tripwireSessions: string[] = [];

afterEach(async () => {
  for (const id of tripwireSessions.splice(0)) clearSecurityCredentialSession(id);
  await api?.cleanup();
  api = undefined;
});

/** Every submission the child holds, settled or not. */
async function submissionCount(childId: string): Promise<number> {
  const store = api!.providers.engineStore;
  const unsettled = await store.listUnsettledSubmissions(childId);
  const settled = await store.listSettledSubmissionsBefore(childId, Date.now() + 1);
  return unsettled.length + settled.length;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await api?.providers.wakeWatcher.sweep();
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitFor: timed out");
}

describe("api integration: cell settlement signals the interactive runner", () => {
  it(
    "dispatch → child settles → child.settled admitted to the runner thread, not drop-logged",
    async () => {
      api = await bootTestApi();
      const { db, engineHost, engineStore } = api.providers;

      // 1. A real hub-created security session (kind='security', repo pinned).
      const createRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspace: `/tmp/valet-sec-settle-${randomUUID()}`,
          kind: "security",
          repo: REPO,
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as CreateSessionResponse;
      const sessionId = created.id;

      // 2. Build the runner engine session (the same first-touch every web
      //    caller performs) and PAUSE it: the admitted signal must stay
      //    queued and observable instead of being claimed by a doomed
      //    no-API-key turn.
      const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
      const runner = await engineHost.sessionFor(sessionId, await loadSessionMeta(db, rows[0]));
      const runnerThread = runner.thread("web:default");
      await runner.pause();

      // The seam under test: the runner is NOT an orchestrator.
      const runnerData = await engineStore.getSession(sessionId);
      expect(runnerData?.purpose ?? "interactive").toBe("interactive");

      // 3. Start the engagement (service-level; SHA resolution is the start
      //    route's job and is covered by the tools suite).
      const service = createSecurityEngagementService({ db });
      const found = await service.getEngagementBySession(sessionId);
      await service.startEngagement(found!.engagement.id, { resolvedSha: SHA });

      // 4. Dispatch cell 1 through the REAL internal route → children.ts
      //    spawner → virtual sandbox child, watch row inserted, watcher armed.
      const dispatchRes = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-valet-internal": internalToken(),
          "x-valet-session-id": sessionId,
        },
        body: JSON.stringify({ threadId: runnerThread.id }),
      });
      expect(dispatchRes.status).toBe(200);
      const dispatched = (await dispatchRes.json()) as SecurityDispatchResponse;
      const childSessionId = dispatched.cell.childSessionId;
      expect(childSessionId).toBeTruthy();

      const watchRows = await db
        .select()
        .from(childWatches)
        .where(eq(childWatches.childSessionId, childSessionId!));
      expect(watchRows).toHaveLength(1);
      expect(watchRows[0].parentSessionId).toBe(sessionId);
      expect(watchRows[0].parentThreadId).toBe(runnerThread.id);
      expect(watchRows[0].settled).toBe(false);

      // The child is linked to the runner in durable engine state — the
      // edge admitSignal's rule (a) authorizes from.
      const childData = await engineStore.getSession(childSessionId!);
      expect(childData?.purpose).toBe("child");
      expect(childData?.parentSessionId).toBe(sessionId);

      // 5. Make the child settle without a model: abort settles its real
      //    dispatched submission `aborted` (queued or in-flight alike).
      const child = engineHost.liveSession(childSessionId!);
      expect(child).not.toBeNull();
      await child!.abort();

      // 6. The watcher observes the settlement, admits child.settled to the
      //    interactive runner thread, and marks the watch settled.
      await waitFor(async () => {
        const settled = await db
          .select({ settled: childWatches.settled })
          .from(childWatches)
          .where(eq(childWatches.childSessionId, childSessionId!))
          .limit(1);
        return settled[0]?.settled === true;
      });

      // (2) The runner's thread received the signal: it sits in the paused
      // thread's queue, addressed to the SPAWNING thread.
      const unsettled = await engineStore.listUnsettledSubmissions(sessionId);
      const settledSignals = unsettled.filter(
        (item) =>
          typeof item.content === "object" &&
          item.content !== null &&
          "kind" in item.content &&
          item.content.kind === "signal" &&
          (item.content as SignalContent).signalType === "child.settled",
      );
      expect(settledSignals).toHaveLength(1);
      expect(settledSignals[0].threadId).toBe(runnerThread.id);
      const content = settledSignals[0].content as SignalContent;
      expect(content.attributes?.child_session_id).toBe(childSessionId);
      // The abort races the child's own doomed no-key claim: whichever side
      // settles first, the outcome is a REAL settlement — that is what the
      // seam under test delivers.
      expect(["aborted", "failed"]).toContain(content.attributes?.outcome);
      // The engine namespaces the watcher's deterministic dispatchId by the
      // STAMPED sender — proof the signal was admitted AS the child.
      expect(settledSignals[0].dispatchId).toBe(
        `${childSessionId}:settled:${childSessionId}:${watchRows[0].queueItemId}`,
      );

      // (3) admitSignal did NOT drop it: no edge-denied/hop-budget drop-log
      // row exists for this admission (pending_cap noise would also fail).
      const drops = await db.select().from(eventDropLog);
      expect(drops).toEqual([]);

      // The cell row still points at the child — the runner's next turn can
      // sec_cell_complete (settled=true now) or sec_cell_fail on it.
      const cells = await db
        .select()
        .from(securityCells)
        .where(eq(securityCells.engagementId, found!.engagement.id));
      const recon = cells.find((cell) => cell.ordinal === 1);
      expect(recon?.status).toBe("running");
      expect(recon?.childSessionId).toBe(childSessionId);
    },
    60_000,
  );
});

describe("api integration: failing a cell stops its child's background work", () => {
  it("sec_cell_fail cancels the child's pending wakeup", async () => {
    api = await bootTestApi();
    const { engineStore } = api.providers;
    const { sessionId } = await createSecuritySession(api);
    const { threadId } = await buildPausedRunner(api, sessionId);
    await setPlanViaRoute(api, sessionId, ONE_CELL_PLAN);
    await startViaRoute(api, sessionId);
    const dispatched = await dispatchViaRoute(api, sessionId, threadId);
    const childId = dispatched.cell.childSessionId;
    if (!childId) throw new Error("dispatch returned no child session id");

    const now = Date.now();
    await engineStore.createWakeup({
      id: "wk_parked1",
      sessionId: childId,
      threadId: "th_child",
      kind: "timer",
      status: "pending",
      reason: "re-check later",
      prompt: "re-check later",
      fireAt: now + 30 * 24 * 3_600_000,
      logOffset: 0,
      logTail: "",
      eventCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    expect(await openBackgroundWork(engineStore, childId)).toBe(1);
    const submissionsBefore = await submissionCount(childId);
    const unsettledBefore = (await engineStore.listUnsettledSubmissions(childId)).map((item) => item.id);

    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/cells/${dispatched.cell.id}/fail`, {
      method: "POST",
      headers: actingAs(sessionId),
      body: JSON.stringify({ reason: "The child parked on a 30 day timer." }),
    });
    expect(res.status).toBe(200);
    expect(await openBackgroundWork(engineStore, childId)).toBe(0);
    // The cancel sends no terminal signal, so the persona starts no new turn.
    expect(await submissionCount(childId)).toBe(submissionsBefore);
    const unsettledAfter = await engineStore.listUnsettledSubmissions(childId);
    expect(unsettledAfter.filter((item) => !unsettledBefore.includes(item.id))).toEqual([]);
  }, 60_000);
});

/** Run a one-cell engagement to a completed cell whose child holds a
 * registered value. Returns the runner session id and the child id. */
async function completedCellWithValue(): Promise<{ sessionId: string; childId: string }> {
  const { sessionId, engagementId } = await createSecuritySession(api!);
  const { threadId } = await buildPausedRunner(api!, sessionId);
  await setPlanViaRoute(api!, sessionId, ONE_CELL_PLAN);
  await startViaRoute(api!, sessionId);
  const dispatched = await dispatchViaRoute(api!, sessionId, threadId);
  const childId = dispatched.cell.childSessionId;
  if (!childId) throw new Error("dispatch returned no child session id");
  registerSecurityCredentialValue(childId, engagementId, LEAKED);
  tripwireSessions.push(childId);
  await writeFileAsChild(
    api!,
    childId,
    `/cells/${dispatched.cell.dir}/state.yml`,
    stateDoc({ cell: dispatched.cell.dir, persona: dispatched.cell.persona, status: "done" }),
  );
  await settleChildByAbort(api!, childId);
  expect((await completeCellViaRoute(api!, sessionId, dispatched.cell.id)).outcome).toBe("completed");
  return { sessionId, childId };
}

describe("api integration: the tripwire entry outlives cell settlement", () => {
  it("sanitizes a signal to a completed cell's child, and clears at destroy", async () => {
    api = await bootTestApi();
    const { db, engineHost, engineStore } = api.providers;
    const { childId } = await completedCellWithValue();
    expect(hasSecurityCredentialValues(childId)).toBe(true);

    // A process the child started can still exit and prompt it.
    const [childRow] = await db.select().from(agentSessions).where(eq(agentSessions.id, childId)).limit(1);
    const child = await engineHost.sessionFor(childId, await loadSessionMeta(db, childRow));
    const receipt = await child.prompt({
      kind: "signal",
      signalType: "process.exited",
      body: `exit 0\n${LEAKED}\n`,
      attributes: {},
    });
    const stored = JSON.stringify((await engineStore.getQueueItem(childId, receipt.queueItemId))?.content);
    expect(stored).toContain(SECURITY_CREDENTIAL_OUTPUT_BLOCKED);
    expect(stored).not.toContain(LEAKED);

    await engineHost.destroy(childId);
    expect(hasSecurityCredentialValues(childId)).toBe(false);
  }, 60_000);

  it("clears a settled cell's entry when the engagement closes", async () => {
    api = await bootTestApi();
    const { sessionId, childId } = await completedCellWithValue();
    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/close`, {
      method: "POST",
      headers: actingAs(sessionId),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(hasSecurityCredentialValues(childId)).toBe(false);
  }, 60_000);

  it("clears a settled cell's entry when the engagement is cancelled", async () => {
    api = await bootTestApi();
    const { sessionId, childId } = await completedCellWithValue();
    const res = await fetch(`${api.baseUrl}/api/sessions/${sessionId}/security/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(hasSecurityCredentialValues(childId)).toBe(false);
  }, 60_000);
});
