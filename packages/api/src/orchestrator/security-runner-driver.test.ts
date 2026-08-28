import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
  SecurityRunnerDriver,
  type RunnerSubmit,
} from "./security-runner-driver.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = 1_700_000_000_000;

describe("SecurityRunnerDriver", () => {
  let db: AppDb;
  let svc: SecurityEngagementService;
  let submit: ReturnType<typeof vi.fn> & RunnerSubmit;
  /** Injected idle signal — empty means idle, non-empty means working/gated. */
  let unsettled: unknown[];
  let spawnCount: number;
  const spawn = async () => ({ childSessionId: `child_${++spawnCount}` });

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    svc = createSecurityEngagementService({ db, now: () => NOW });
    submit = vi.fn(async () => undefined) as ReturnType<typeof vi.fn> & RunnerSubmit;
    unsettled = [];
    spawnCount = 0;
  });

  function makeDriver(maxStalls = 3): SecurityRunnerDriver {
    return new SecurityRunnerDriver({
      db,
      engineStore: { listUnsettledSubmissions: async () => unsettled },
      submit,
      now: () => NOW,
      // Sweep is driven manually; interval is only used by start().
      sweepIntervalMs: 20_000,
      maxStalls,
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

  it("does not nudge while a cell is running (a persona child is in flight)", async () => {
    const { engagementId, cells } = await seedStarted();
    await db
      .update(securityCells)
      .set({ status: "running" })
      .where(eq(securityCells.id, cells[0].id));

    await makeDriver().sweep();

    expect(submit).not.toHaveBeenCalled();
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
});
