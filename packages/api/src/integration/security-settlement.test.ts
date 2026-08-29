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
import { internalToken } from "../lib/internal-auth.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { createSecurityEngagementService } from "../services/security-engagements.js";
import { agentSessions, childWatches, eventDropLog, securityCells } from "../schema/index.js";
import type { CreateSessionResponse, SecurityDispatchResponse } from "../wire/types.js";

const SHA = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
const REPO = { fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", ref: SHA };

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
