import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Wakeup } from "@valet/engine";
import { codeReviewPresetPlan } from "@valet/plugin-security";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import {
  agentSessions,
  securityCells,
  securityEngagements,
  securityFindings,
  type SecurityCellRow,
} from "../schema/index.js";
import {
  createSecurityEngagementService,
  type SecurityEngagementService,
} from "../services/security-engagements.js";
import {
  NUDGE_TEXT,
  SECURITY_BACKGROUND_WORK_MAX_MS,
  SecurityRunnerDriver,
  SUBMIT_STALL_TEXT,
  type RunnerAlert,
  type RunnerSubmit,
} from "./security-runner-driver.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

describe("SecurityRunnerDriver", () => {
  let db: AppDb;
  let svc: SecurityEngagementService;
  let submit: ReturnType<typeof vi.fn> & RunnerSubmit;
  /** Injected idle signal — empty means idle, non-empty means working/gated. */
  let unsettled: unknown[];
  /** Per-session unsettled override (fix 2): a child session id → its list.
   * Falls back to `unsettled` for any id not in the map (the runner session). */
  let unsettledBySession: Map<string, unknown[]>;
  /** Child session ids that hold one active hold lease. */
  let holdsBySession: Set<string>;
  /** Child session ids → their open wakeups. */
  let wakeupsBySession: Map<string, Wakeup[]>;
  /** The driver's clock. A test advances it to start a new stall episode. */
  let clock: number;
  let spawnCount: number;
  const spawn = async () => ({ childSessionId: `child_${++spawnCount}` });

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    svc = createSecurityEngagementService({ db, now: () => NOW });
    submit = vi.fn(async () => undefined) as ReturnType<typeof vi.fn> & RunnerSubmit;
    unsettled = [];
    unsettledBySession = new Map();
    holdsBySession = new Set();
    wakeupsBySession = new Map();
    clock = NOW;
    spawnCount = 0;
  });

  function makeDriver(maxStalls = 3, maxSubmitFailures = 3, alert?: RunnerAlert): SecurityRunnerDriver {
    return new SecurityRunnerDriver({
      db,
      engineStore: {
        getSession: async () => null,
        listThreads: async () => [],
        listUnsettledSubmissions: async (sessionId: string) =>
          unsettledBySession.get(sessionId) ?? unsettled,
        listWakeups: async (sessionId: string) => wakeupsBySession.get(sessionId) ?? [],
        listActiveLeases: async (sessionId: string) =>
          holdsBySession.has(sessionId)
            ? [{ id: "ls_hold1", sessionId, ownerKind: "hold", reason: "long scan", createdAt: NOW, deadlineAt: NOW + 3_600_000 }]
            : [],
      },
      submit,
      now: () => clock,
      // Sweep is driven manually; interval is only used by start().
      sweepIntervalMs: 20_000,
      maxStalls,
      maxSubmitFailures,
      alert,
    });
  }

  /** Seed a runner session row + a started engagement with materialized cells.
   * Returns the engagement id, session id, and the cell rows. */
  async function seedStarted(status: "active" | "archived" = "active"): Promise<{
    engagementId: string;
    sessionId: string;
    cells: SecurityCellRow[];
  }> {
    const sessionId = `s_${Math.random().toString(36).slice(2)}`;
    await db.insert(agentSessions).values({
      id: sessionId,
      userId: "u1",
      orgId: "local-org",
      workspace: "/workspace",
      status,
      ownerType: "user",
      ownerId: "u1",
      profile: "headless",
      kind: "security",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const engagement = await svc.createEngagement({
      sessionId,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
    const started = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    return { engagementId: engagement.id, sessionId, cells: started.cells };
  }

  it("nudges an idle runner with a pending cell and no unsettled submission", async () => {
    const { cells } = await seedStarted();
    // Every cell is `pending`, nothing running, no unsettled submission → idle
    // with work to do.
    expect(cells.every((c) => c.status === "pending")).toBe(true);

    await makeDriver().sweep();

    expect(submit).toHaveBeenCalledTimes(1);
    const [, text] = submit.mock.calls[0];
    expect(text).toBe(NUDGE_TEXT);
  });

  it("does not nudge while a running cell's child is still working (has an unsettled submission)", async () => {
    const { cells } = await seedStarted();
    await db
      .update(securityCells)
      .set({ status: "running", childSessionId: "child_working" })
      .where(eq(securityCells.id, cells[0].id));
    // The child is genuinely working: the child.settled signal path owns the
    // self-advance, so the sweep must stay silent (fix 2 skip condition).
    unsettledBySession.set("child_working", [{ id: "q1" }]);

    await makeDriver().sweep();

    expect(submit).not.toHaveBeenCalled();
  });

  it("nudges a running cell whose child has settled (no unsettled submission) — the lost-signal gap", async () => {
    const { cells } = await seedStarted();
    await db
      .update(securityCells)
      .set({ status: "running", childSessionId: "child_settled" })
      .where(eq(securityCells.id, cells[0].id));
    // The child finished but the child.settled signal was lost (a restart). Its
    // unsettled list is empty, and the runner is idle → nudge (fix 2). Without
    // this the runner loops re-dispatching a finished child.
    unsettledBySession.set("child_settled", []);

    await makeDriver().sweep();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1]).toBe(NUDGE_TEXT);
  });

  it("does not nudge while the running cell's child holds background work", async () => {
    const { cells } = await seedStarted();
    await db
      .update(securityCells)
      .set({ status: "running", childSessionId: "child_scanning" })
      .where(eq(securityCells.id, cells[0].id));
    // The child settled but holds a lease for a background scan. Its next
    // child.settled arrives when the scan ends, so a nudge only burns stalls.
    unsettledBySession.set("child_scanning", []);
    holdsBySession.add("child_scanning");

    await makeDriver().sweep();

    expect(submit).not.toHaveBeenCalled();
  });

  it("nudges a running cell mid-dispatch (no childSessionId yet)", async () => {
    const { cells } = await seedStarted();
    // A running cell with no child id is mid-dispatch. It falls through to the
    // idle nudge — the polling net owns the gap (fix 2).
    await db
      .update(securityCells)
      .set({ status: "running", childSessionId: null })
      .where(eq(securityCells.id, cells[0].id));

    await makeDriver().sweep();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1]).toBe(NUDGE_TEXT);
  });

  it("does not nudge when the runner has an unsettled submission", async () => {
    await seedStarted();
    // A gated submission is UNSETTLED: the sec_start approval gate blocks the
    // runner with a submission that never settles. A non-empty list therefore
    // also covers "blocked on an approval" — the sweep must stay silent.
    unsettled = [{ id: "q1" }];

    await makeDriver().sweep();

    expect(submit).not.toHaveBeenCalled();
  });

  it("skips an archived runner session", async () => {
    await seedStarted("archived");

    await makeDriver().sweep();

    expect(submit).not.toHaveBeenCalled();
  });

  it("does not nudge a completed engagement and evicts its stall entry", async () => {
    const { engagementId, sessionId, cells } = await seedStarted();
    const driver = makeDriver();

    // First sweep nudges (idle with work) and records a stall entry.
    await driver.sweep();
    expect(submit).toHaveBeenCalledTimes(1);

    // Complete every cell and close the engagement out of band.
    for (const cell of cells) {
      await db
        .update(securityCells)
        .set({ status: "completed" })
        .where(eq(securityCells.id, cell.id));
    }
    await db
      .update(securityEngagements)
      .set({ status: "completed" })
      .where(eq(securityEngagements.id, engagementId));

    submit.mockClear();
    await driver.sweep();

    // No nudge for a completed engagement, and the in-memory entry is evicted:
    // reviving the engagement to running nudges as a first sight (stalls=1),
    // not as a continuation of the pre-completion budget.
    expect(submit).not.toHaveBeenCalled();
    // Prove eviction: put it back to running with a pending cell.
    await db
      .update(securityEngagements)
      .set({ status: "running" })
      .where(eq(securityEngagements.id, engagementId));
    await db
      .update(securityCells)
      .set({ status: "pending" })
      .where(eq(securityCells.id, cells[0].id));
    await driver.sweep();
    expect(submit).toHaveBeenCalledTimes(1);
    void sessionId;
  });

  it("does not nudge a cancelled engagement (swept only for planning/running)", async () => {
    const { engagementId, cells } = await seedStarted();
    // A cancelled engagement fails every unsettled cell and leaves running
    // neither. The sweep queries planning|running only, so it never sees it.
    await svc.cancelEngagement(engagementId);
    const cancelled = await db
      .select({ status: securityEngagements.status })
      .from(securityEngagements)
      .where(eq(securityEngagements.id, engagementId));
    expect(cancelled[0].status).toBe("cancelled");
    void cells;

    await makeDriver().sweep();

    expect(submit).not.toHaveBeenCalled();
  });

  it("caps nudges: N no-progress nudges, then one stall message, then quiet", async () => {
    const { sessionId } = await seedStarted();
    const driver = makeDriver(3);

    // Three no-progress sweeps → three nudges (stalls reach maxStalls=3).
    await driver.sweep();
    await driver.sweep();
    await driver.sweep();
    expect(submit).toHaveBeenCalledTimes(3);
    for (const [, text] of submit.mock.calls) expect(text).toBe(NUDGE_TEXT);

    // Fourth sweep: stalls (3) >= maxStalls (3) → stop nudging, post the stall
    // message ONCE instead.
    submit.mockClear();
    await driver.sweep();
    expect(submit).toHaveBeenCalledTimes(1);
    const [row, stallMsg] = submit.mock.calls[0];
    expect(row.id).toBe(sessionId);
    expect(stallMsg).toContain("has not progressed");
    expect(stallMsg).not.toBe(NUDGE_TEXT);

    // Fifth+ sweeps: quiet — already alerted for this signature.
    submit.mockClear();
    await driver.sweep();
    await driver.sweep();
    expect(submit).not.toHaveBeenCalled();
  });

  it("resumes nudging when the progress signature changes after a stall", async () => {
    const { engagementId, cells } = await seedStarted();
    const driver = makeDriver(3);

    // Drive past the cap into the alerted-quiet state.
    for (let i = 0; i < 6; i++) await driver.sweep();
    submit.mockClear();
    await driver.sweep();
    expect(submit).not.toHaveBeenCalled(); // quiet

    // The user intervenes: a cell advances, changing the signature.
    await db
      .update(securityCells)
      .set({ status: "completed" })
      .where(eq(securityCells.id, cells[0].id));

    await driver.sweep();
    // New signature → budget resets and nudging resumes.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1]).toBe(NUDGE_TEXT);
    void engagementId;
  });

  it("resets the stall counter when a finding lands between nudges", async () => {
    const { engagementId, cells } = await seedStarted();
    const driver = makeDriver(3);

    await driver.sweep(); // stalls=1
    await driver.sweep(); // stalls=2
    expect(submit).toHaveBeenCalledTimes(2);

    // A finding raises the finding count → new signature → reset to 1.
    await db.insert(securityFindings).values({
      id: "fnd_1",
      engagementId,
      cellId: cells[0].id,
      fingerprint: "abc123",
      severity: "high",
      title: "IDOR on session read",
      body: "x".repeat(200),
      status: "open",
      createdAt: NOW,
    });

    submit.mockClear();
    // Two more sweeps land at stalls 1 and 2 against the new signature, both
    // under the cap, so both nudge — proving the counter reset.
    await driver.sweep();
    await driver.sweep();
    await driver.sweep();
    expect(submit).toHaveBeenCalledTimes(3);
    for (const [, text] of submit.mock.calls) expect(text).toBe(NUDGE_TEXT);
  });

  it("alerts ONCE after repeated submit failures (fix 10b: an un-restorable runner)", async () => {
    await seedStarted();
    // Every submit throws — a cold start for an un-restorable runner. The
    // driver counts consecutive failures and trips the alert at the cap.
    submit.mockImplementation(async () => {
      throw new Error("cold start failed: session not restorable");
    });
    const driver = makeDriver(10, 3); // high nudge cap so the submit cap trips first

    // Three failing sweeps reach maxSubmitFailures=3. On the third, the alert
    // fires: recordSecurityRunnerStalled() + one SUBMIT_STALL_TEXT ask.
    await driver.sweep(); // failure 1
    await driver.sweep(); // failure 2
    await driver.sweep(); // failure 3 → alert (nudge attempt + one human ask)

    const askCalls = submit.mock.calls.filter(([, text]) => text === SUBMIT_STALL_TEXT);
    expect(askCalls).toHaveLength(1);

    // Further failing sweeps stay quiet on the human ask — alerted once.
    const before = submit.mock.calls.filter(([, text]) => text === SUBMIT_STALL_TEXT).length;
    await driver.sweep();
    await driver.sweep();
    const after = submit.mock.calls.filter(([, text]) => text === SUBMIT_STALL_TEXT).length;
    expect(after).toBe(before);
  });

  it("alerts the owner once when the stall cap trips", async () => {
    const { engagementId, sessionId, cells } = await seedStarted();
    const alert = vi.fn<RunnerAlert>(async () => undefined);
    const driver = makeDriver(3, 3, alert);

    // Three nudges reach the cap; the fourth sweep alerts.
    for (let i = 0; i < 4; i++) await driver.sweep();
    expect(alert).toHaveBeenCalledTimes(1);
    const [row, first] = alert.mock.calls[0];
    expect(row.id).toBe(sessionId);
    expect(first.title).toBe("Security review stalled");
    expect(first.body).toContain("has not progressed");
    expect(first.dedupeKey).toMatch(new RegExp(`^security-stall:${engagementId}:[0-9a-f]{8}:${NOW}$`));

    // Quiet for the same signature.
    await driver.sweep();
    await driver.sweep();
    expect(alert).toHaveBeenCalledTimes(1);

    // Progress, then a second stall episode alerts again with a new key.
    await db.update(securityCells).set({ status: "completed" }).where(eq(securityCells.id, cells[0].id));
    for (let i = 0; i < 4; i++) await driver.sweep();
    expect(alert).toHaveBeenCalledTimes(2);
    const second = alert.mock.calls[1][1];
    expect(second.dedupeKey).toMatch(new RegExp(`^security-stall:${engagementId}:[0-9a-f]{8}:${NOW}$`));
    expect(second.dedupeKey).not.toBe(first.dedupeKey);
  });

  it("alerts the owner when submit keeps failing, over the alert seam not the submit seam", async () => {
    const { engagementId } = await seedStarted();
    submit.mockImplementation(async () => {
      throw new Error("cold start failed: session not restorable");
    });
    const alert = vi.fn<RunnerAlert>(async () => undefined);
    const driver = makeDriver(10, 3, alert);

    await driver.sweep();
    await driver.sweep();
    expect(alert).not.toHaveBeenCalled();
    await driver.sweep(); // failure 3 trips the cap
    expect(alert).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls.filter(([, text]) => text === SUBMIT_STALL_TEXT)).toHaveLength(1);
    expect(alert.mock.calls[0][1]).toEqual({
      title: "Security runner needs attention",
      body: SUBMIT_STALL_TEXT,
      dedupeKey: `security-runner-down:${engagementId}:${NOW}`,
    });

    await driver.sweep();
    await driver.sweep();
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("gives two submit-failure episodes at the same signature different dedupe keys", async () => {
    const { engagementId } = await seedStarted();
    let failing = true;
    submit.mockImplementation(async () => {
      if (failing) throw new Error("cold start failed: session not restorable");
    });
    const alert = vi.fn<RunnerAlert>(async () => undefined);
    const driver = makeDriver(10, 3, alert);

    for (let i = 0; i < 3; i++) await driver.sweep();
    failing = false;
    await driver.sweep();
    failing = true;
    clock = NOW + 60_000;
    for (let i = 0; i < 3; i++) await driver.sweep();

    expect(alert.mock.calls.map(([, event]) => event.dedupeKey)).toEqual([
      `security-runner-down:${engagementId}:${NOW}`,
      `security-runner-down:${engagementId}:${NOW + 60_000}`,
    ]);
  });

  it("a synchronously throwing alert sink still lets the submit-stall ask go out", async () => {
    await seedStarted();
    submit.mockImplementation(async () => {
      throw new Error("cold start failed: session not restorable");
    });
    const alert = vi.fn<RunnerAlert>(() => {
      throw new Error("attention router misconfigured");
    });
    const driver = makeDriver(10, 3, alert);

    for (let i = 0; i < 3; i++) await expect(driver.sweep()).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls.filter(([, text]) => text === SUBMIT_STALL_TEXT)).toHaveLength(1);
  });

  it("a throwing alert sink does not break the sweep", async () => {
    const { cells } = await seedStarted();
    const alert = vi.fn<RunnerAlert>(async () => {
      throw new Error("attention router down");
    });
    const driver = makeDriver(3, 3, alert);

    for (let i = 0; i < 3; i++) await driver.sweep();
    submit.mockClear();
    // The cap trips: the alert throws, and the stall message still reaches the runner.
    await expect(driver.sweep()).resolves.toBeUndefined();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1]).toContain("has not progressed");

    // After progress, the next tick nudges as normal.
    submit.mockClear();
    await db.update(securityCells).set({ status: "completed" }).where(eq(securityCells.id, cells[0].id));
    await driver.sweep();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1]).toBe(NUDGE_TEXT);
  });
  /** A running cell dispatched `ageMs` ago whose child settled but holds one
   * timer that fires in 30 days. */
  async function seedParkedChild(ageMs: number): Promise<{ engagementId: string; cells: SecurityCellRow[] }> {
    const seeded = await seedStarted();
    await db
      .update(securityCells)
      .set({ status: "running", childSessionId: "child_parked", dispatchedAt: NOW - ageMs })
      .where(eq(securityCells.id, seeded.cells[0].id));
    unsettledBySession.set("child_parked", []);
    wakeupsBySession.set("child_parked", [
      {
        id: "wk_timer1",
        sessionId: "child_parked",
        threadId: "th_child",
        kind: "timer",
        status: "pending",
        reason: "re-check later",
        prompt: "re-check later",
        fireAt: NOW + 30 * 24 * HOUR_MS,
        logOffset: 0,
        logTail: "",
        eventCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    return seeded;
  }

  it("counts stalls and alerts once background work outlives the deadline from dispatch", async () => {
    await seedParkedChild(25 * HOUR_MS);
    const alert = vi.fn<RunnerAlert>(async () => undefined);
    const driver = makeDriver(3, 3, alert);

    for (let i = 0; i < 4; i++) await driver.sweep();

    expect(submit.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(submit.mock.calls[0][1]).toBe(NUDGE_TEXT);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][1].title).toBe("Security review stalled");
    expect(SECURITY_BACKGROUND_WORK_MAX_MS).toBe(24 * HOUR_MS);
  });

  it("stays quiet while background work is inside the deadline", async () => {
    await seedParkedChild(HOUR_MS);
    const alert = vi.fn<RunnerAlert>(async () => undefined);
    const driver = makeDriver(3, 3, alert);

    for (let i = 0; i < 4; i++) await driver.sweep();

    expect(submit).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("gives two stall episodes with the same signature different dedupe keys", async () => {
    const { engagementId, cells } = await seedStarted();
    const alert = vi.fn<RunnerAlert>(async () => undefined);
    const driver = makeDriver(3, 3, alert);

    for (let i = 0; i < 4; i++) await driver.sweep();
    expect(alert).toHaveBeenCalledTimes(1);

    // A resume moves the engagement away and back to the same signature.
    clock = NOW + 60_000;
    await db.update(securityCells).set({ status: "completed" }).where(eq(securityCells.id, cells[0].id));
    await driver.sweep();
    clock = NOW + 120_000;
    await db.update(securityCells).set({ status: "pending" }).where(eq(securityCells.id, cells[0].id));
    for (let i = 0; i < 4; i++) await driver.sweep();

    expect(alert).toHaveBeenCalledTimes(2);
    const first = alert.mock.calls[0][1].dedupeKey;
    const second = alert.mock.calls[1][1].dedupeKey;
    expect(first).not.toBe(second);
    const sig = (key: string) => key.split(":")[2];
    expect(sig(second)).toBe(sig(first));
    expect(first).toBe(`security-stall:${engagementId}:${sig(first)}:${NOW}`);
    expect(second).toBe(`security-stall:${engagementId}:${sig(first)}:${NOW + 120_000}`);
  });

  it("a never-resolving alert sink does not block the sweep", async () => {
    await seedStarted();
    const alert = vi.fn<RunnerAlert>(() => new Promise<void>(() => {}));
    const driver = makeDriver(3, 3, alert);
    for (let i = 0; i < 3; i++) await driver.sweep();

    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 100));
    const outcome = await Promise.race([driver.sweep().then(() => "done"), timeout]);

    expect(outcome).toBe("done");
    expect(alert).toHaveBeenCalledTimes(1);
  });
});
