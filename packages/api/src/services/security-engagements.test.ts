import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { codeReviewPresetPlan, findingFingerprint, parsePlan, KNOWN_PERSONAS } from "@valet/plugin-security";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { securityCells, securityFiles, securityFindings, type SecurityCellRow } from "../schema/index.js";
import {
  buildDispatchPrompt,
  createSecurityEngagementService,
  MAX_REVISIONS_PER_PATH,
  STATE_DOC_STALE_MS,
  type SecurityEngagementService,
} from "./security-engagements.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const DONE_DOC = [
  "protocol_version: 1",
  "status: done",
  "checklist:",
  "  pending: 0",
  "  done: 5",
  "queue:",
  "  pending: 0",
  "  done: 3",
  "",
].join("\n");

const YIELD_DOC = DONE_DOC.replace("status: done", "status: yielding").replace(
  "  pending: 0\n  done: 3",
  "  pending: 31\n  done: 3",
);

const VIOLATION_DOC = DONE_DOC.replace("queue:\n  pending: 0", "queue:\n  pending: 2");

/** A body long enough to clear the 200-character evidence floor. */
const EVIDENCE = `The route reads the session id from the URL and never checks ownership. Excerpt: db.select().from(sessions).where(eq(sessions.id, id)) — any authenticated caller can read any session, which leaks other tenants' transcripts.`;

describe("security engagement service", () => {
  let db: AppDb;
  let svc: SecurityEngagementService;
  let spawnCount: number;
  const spawn = async () => ({ childSessionId: `child_${++spawnCount}` });

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    svc = createSecurityEngagementService({ db });
    spawnCount = 0;
  });

  async function makePlanning() {
    return svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
  }

  async function makeStarted() {
    const engagement = await makePlanning();
    return svc.startEngagement(engagement.id, { resolvedSha: SHA });
  }

  /** Dispatch a cell, write its state doc, and settle it via completeCell. */
  async function runCellToCompletion(engagementId: string, cell: SecurityCellRow, doc = DONE_DOC) {
    await svc.dispatchCell(engagementId, { cellId: cell.id, spawn });
    await svc.writeFile(engagementId, {
      actorCellId: cell.id,
      path: `/cells/${cell.dir}/state.yml`,
      content: doc,
    });
    return svc.completeCell(engagementId, cell.id, { settled: true });
  }

  // ── Plan lifecycle ───────────────────────────────────────────────────────

  it("setPlan replaces the plan while planning and refuses once running", async () => {
    const engagement = await makePlanning();
    const smaller = [
      "cells:",
      "  - ordinal: 1",
      "    persona: code-review",
      "    goal: Map the codebase",
      "",
    ].join("\n");
    const updated = await svc.setPlan(engagement.id, smaller);
    expect(updated.plan).toBe(smaller);

    await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    await expect(svc.setPlan(engagement.id, smaller)).rejects.toThrow(
      "The plan is immutable once the engagement is running.",
    );
  });

  it("startEngagement requires a pinned SHA", async () => {
    const engagement = await makePlanning();
    await expect(svc.startEngagement(engagement.id, { resolvedSha: "" })).rejects.toThrow(
      "Pin the repository to a commit SHA before starting.",
    );
  });

  it("startEngagement materializes cells with dir, reads, and review stamped", async () => {
    const { engagement, cells } = await makeStarted();
    expect(engagement.status).toBe("running");
    expect(engagement.repoRef).toBe(SHA);
    expect(cells).toHaveLength(5);
    expect(cells.map((c) => c.dir)).toEqual([
      "01-recon",
      "02-authz-sweep",
      "03-injection-sweep",
      "04-secrets-config",
      "05-verify",
    ]);
    expect(JSON.parse(cells[1].reads)).toEqual([1]);
    expect(JSON.parse(cells[4].reads)).toEqual([1, 2, 3, 4]);
    expect(cells[4].review).toBe(true);
    expect(cells.slice(0, 4).every((c) => !c.review)).toBe(true);
    expect(cells.every((c) => c.status === "pending" && c.attempts === 0)).toBe(true);

    await expect(svc.startEngagement(engagement.id, { resolvedSha: SHA })).rejects.toThrow(
      "already running",
    );
  });

  // ── Dispatch ─────────────────────────────────────────────────────────────

  it("dispatchCell picks the first pending cell and stamps the claim", async () => {
    const { engagement } = await makeStarted();
    const { cell } = await svc.dispatchCell(engagement.id, { spawn });
    expect(cell.ordinal).toBe(1);
    expect(cell.status).toBe("running");
    expect(cell.attempts).toBe(1);
    expect(cell.childSessionId).toBe("child_1");
    expect(cell.dispatchedAt).not.toBeNull();
  });

  it("dispatchCell refuses while another cell is running", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.dispatchCell(engagement.id, { spawn });
    await expect(svc.dispatchCell(engagement.id, { cellId: cells[1].id, spawn })).rejects.toThrow(
      "Cell 01 is still running. Complete or fail it before dispatching another.",
    );
    // Unnamed dispatch: the first pending would be cell 2, same refusal.
    await expect(svc.dispatchCell(engagement.id, { spawn })).rejects.toThrow(
      "Cell 01 is still running.",
    );
  });

  it("re-dispatching a yielded cell increments attempts and honors a mode override", async () => {
    const { engagement, cells } = await makeStarted();
    const result = await runCellToCompletion(engagement.id, cells[0], YIELD_DOC);
    expect(result.outcome).toBe("yielded");

    const { cell } = await svc.dispatchCell(engagement.id, {
      cellId: cells[0].id,
      mode: "resume",
      spawn,
    });
    expect(cell.attempts).toBe(2);
    expect(cell.mode).toBe("resume");
    expect(cell.status).toBe("running");
    expect(cell.childSessionId).toBe("child_2");
  });

  it("re-dispatching a failed cell increments attempts", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.dispatchCell(engagement.id, { spawn });
    await svc.failCell(engagement.id, cells[0].id, "sandbox reclaimed");

    const { cell } = await svc.dispatchCell(engagement.id, { cellId: cells[0].id, spawn });
    expect(cell.attempts).toBe(2);
    expect(cell.status).toBe("running");
  });

  it("dispatchCell refuses a completed cell and an engagement that never started", async () => {
    const planning = await makePlanning();
    await expect(svc.dispatchCell(planning.id, { spawn })).rejects.toThrow(
      "Start the engagement with sec_start before dispatching cells.",
    );

    const { engagement, cells } = await makeStarted();
    await runCellToCompletion(engagement.id, cells[0]);
    await expect(svc.dispatchCell(engagement.id, { cellId: cells[0].id, spawn })).rejects.toThrow(
      "Completed cells never re-run",
    );
  });

  it("a spawn failure releases the claim: status and attempts revert", async () => {
    const { engagement, cells } = await makeStarted();
    const boom = async (): Promise<{ childSessionId: string }> => {
      throw new Error("spawner down");
    };
    await expect(svc.dispatchCell(engagement.id, { spawn: boom })).rejects.toThrow("spawner down");
    const rows = await db.select().from(securityCells).where(eq(securityCells.id, cells[0].id));
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(0);
  });

  // ── completeCell rulings ─────────────────────────────────────────────────

  it("completeCell refuses an unsettled child", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.dispatchCell(engagement.id, { spawn });
    await expect(svc.completeCell(engagement.id, cells[0].id, { settled: false })).rejects.toThrow(
      "The cell's child has not settled. Wait for it to finish.",
    );
  });

  it("completeCell rules done → completed with settledAt", async () => {
    const { engagement, cells } = await makeStarted();
    const result = await runCellToCompletion(engagement.id, cells[0]);
    expect(result.outcome).toBe("completed");
    if (result.outcome === "completed") {
      expect(result.cell.status).toBe("completed");
      expect(result.cell.settledAt).not.toBeNull();
    }
  });

  it("completeCell rules yielding → yielded", async () => {
    const { engagement, cells } = await makeStarted();
    const result = await runCellToCompletion(engagement.id, cells[0], YIELD_DOC);
    expect(result.outcome).toBe("yielded");
    if (result.outcome === "yielded") expect(result.cell.status).toBe("yielded");
  });

  it("completeCell rules done-with-pending-queue as a violation, cell stays running", async () => {
    const { engagement, cells } = await makeStarted();
    const result = await runCellToCompletion(engagement.id, cells[0], VIOLATION_DOC);
    expect(result.outcome).toBe("violation");
    if (result.outcome === "violation") {
      expect(result.violation).toContain("queue.pending is 2");
    }
    const rows = await db.select().from(securityCells).where(eq(securityCells.id, cells[0].id));
    expect(rows[0].status).toBe("running");
  });

  it("completeCell rules a missing state doc as a violation", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.dispatchCell(engagement.id, { spawn });
    const result = await svc.completeCell(engagement.id, cells[0].id, { settled: true });
    expect(result).toEqual({
      outcome: "violation",
      violation:
        "No state doc found at /cells/01-recon/state.yml. The persona must write one before completing.",
    });
  });

  it("completeCell requires a running cell", async () => {
    const { engagement, cells } = await makeStarted();
    await expect(svc.completeCell(engagement.id, cells[0].id, { settled: true })).rejects.toThrow(
      "Cell 01 is pending, not running.",
    );
  });

  // ── Engagement tree ──────────────────────────────────────────────────────

  it("writeFile refuses a path outside the cell's own directory", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.dispatchCell(engagement.id, { spawn });
    await expect(
      svc.writeFile(engagement.id, {
        actorCellId: cells[0].id,
        path: "/cells/02-authz-sweep/state.yml",
        content: DONE_DOC,
      }),
    ).rejects.toThrow(
      "Write refused: /cells/02-authz-sweep/state.yml is outside your cell directory /cells/01-recon/.",
    );
  });

  it("writeFile appends revisions; nothing updates in place", async () => {
    const { engagement, cells } = await makeStarted();
    const path = "/cells/01-recon/notes.md";
    const first = await svc.writeFile(engagement.id, { actorCellId: cells[0].id, path, content: "one" });
    const second = await svc.writeFile(engagement.id, { actorCellId: cells[0].id, path, content: "two" });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    const latest = await svc.readFile(engagement.id, path);
    expect(latest).toEqual({ path, revision: 2, content: "two" });
    const older = await svc.readFile(engagement.id, path, 1);
    expect(older.content).toBe("one");
  });

  it("writeFile validates state.yml content and rejects oversized writes", async () => {
    const { engagement, cells } = await makeStarted();
    await expect(
      svc.writeFile(engagement.id, {
        actorCellId: cells[0].id,
        path: "/cells/01-recon/state.yml",
        content: "status: nonsense\n",
      }),
    ).rejects.toThrow("protocol_version");
    await expect(
      svc.writeFile(engagement.id, {
        actorCellId: cells[0].id,
        path: "/cells/01-recon/big.txt",
        content: "x".repeat(256 * 1024 + 1),
      }),
    ).rejects.toThrow("the limit is 262144");
  });

  it("writeFile refuses the 513th revision of a path", async () => {
    const { engagement, cells } = await makeStarted();
    const path = "/cells/01-recon/hot.md";
    // Seed the cap directly — 512 service round-trips prove nothing extra.
    await db.insert(securityFiles).values({
      id: "file_cap",
      engagementId: engagement.id,
      cellId: cells[0].id,
      path,
      revision: MAX_REVISIONS_PER_PATH,
      content: "cap",
      createdAt: Date.now(),
    });
    await expect(
      svc.writeFile(engagement.id, { actorCellId: cells[0].id, path, content: "over" }),
    ).rejects.toThrow("already has 512 revisions");
  });

  it("readFile serves the virtual mounts and names the fix for a missing path", async () => {
    const { engagement } = await makeStarted();
    const protocol = await svc.readFile(engagement.id, "/protocol.md");
    expect(protocol.revision).toBeNull();
    expect(protocol.content).toContain("State Doc Protocol");
    const plan = await svc.readFile(engagement.id, "/plan.yml");
    expect(plan.content).toBe(engagement.plan);
    await expect(svc.readFile(engagement.id, "/cells/01-recon/missing.md")).rejects.toThrow(
      "No file at /cells/01-recon/missing.md. Use sec_fs_list to see the tree.",
    );
  });

  it("listFiles groups revisions per path and includes the mounts", async () => {
    const { engagement, cells } = await makeStarted();
    const path = "/cells/01-recon/notes.md";
    await svc.writeFile(engagement.id, { actorCellId: cells[0].id, path, content: "one" });
    await svc.writeFile(engagement.id, { actorCellId: cells[0].id, path, content: "three" });
    const all = await svc.listFiles(engagement.id);
    expect(all.map((e) => e.path)).toEqual(["/cells/01-recon/notes.md", "/plan.yml", "/protocol.md"]);
    const notes = all.find((e) => e.path === path);
    expect(notes).toEqual({ path, revisions: 2, size: 5 });
    const scoped = await svc.listFiles(engagement.id, "/cells/");
    expect(scoped.map((e) => e.path)).toEqual([path]);
  });

  // ── Findings ─────────────────────────────────────────────────────────────

  it("reportFinding enforces the evidence floor", async () => {
    const { engagement, cells } = await makeStarted();
    await expect(
      svc.reportFinding(engagement.id, {
        cellId: cells[0].id,
        severity: "high",
        title: "IDOR on sessions",
        body: "too short",
      }),
    ).rejects.toThrow(
      "Finding body must carry evidence: a code excerpt and the reasoning from source to impact (at least 200 characters).",
    );
  });

  it("reportFinding caps at 100 per cell with a consolidation error", async () => {
    const { engagement, cells } = await makeStarted();
    // Seed the cap directly; the service path is exercised by other tests.
    await db.insert(securityFindings).values(
      Array.from({ length: 100 }, (_, i) => ({
        id: `fnd_seed_${i}`,
        engagementId: engagement.id,
        cellId: cells[0].id,
        fingerprint: `fp${i}`,
        severity: "low" as const,
        title: `finding ${i}`,
        body: EVIDENCE,
        status: "open" as const,
        createdAt: Date.now(),
      })),
    );
    await expect(
      svc.reportFinding(engagement.id, {
        cellId: cells[0].id,
        severity: "low",
        title: "one more",
        body: EVIDENCE,
      }),
    ).rejects.toThrow("Finding cap reached (100 per cell). Consolidate related findings instead of enumerating.");
  });

  it("reportFinding computes the fingerprint and returns siblings sharing it", async () => {
    const { engagement, cells } = await makeStarted();
    const shape = { file: "src/routes/sessions.ts", line: 42, title: "IDOR on sessions" };
    const first = await svc.reportFinding(engagement.id, {
      cellId: cells[0].id,
      severity: "high",
      ...shape,
      body: EVIDENCE,
    });
    expect(first.finding.fingerprint).toBe(findingFingerprint(shape));
    expect(first.siblings).toEqual([]);
    // Line 44 lands in the same ÷10 bucket → same fingerprint, sibling returned.
    const second = await svc.reportFinding(engagement.id, {
      cellId: cells[0].id,
      severity: "high",
      ...shape,
      line: 44,
      body: EVIDENCE,
    });
    expect(second.finding.fingerprint).toBe(first.finding.fingerprint);
    expect(second.siblings.map((s) => s.id)).toEqual([first.finding.id]);
  });

  it("reviewFinding is forward-only and gated to review cells or user actors", async () => {
    const { engagement, cells } = await makeStarted();
    const { finding } = await svc.reportFinding(engagement.id, {
      cellId: cells[0].id,
      severity: "high",
      title: "IDOR on sessions",
      file: "src/routes/sessions.ts",
      line: 42,
      body: EVIDENCE,
    });

    // A non-review cell may not flip.
    await expect(
      svc.reviewFinding(engagement.id, {
        findingId: finding.id,
        status: "refuted",
        reason: "the route checks ownership upstream",
        actor: cells[1].id,
      }),
    ).rejects.toThrow("Only review cells may flip finding statuses.");

    // Reason is required.
    await expect(
      svc.reviewFinding(engagement.id, {
        findingId: finding.id,
        status: "refuted",
        reason: "  ",
        actor: cells[4].id,
      }),
    ).rejects.toThrow("needs a reason");

    // The review cell flips it.
    const refuted = await svc.reviewFinding(engagement.id, {
      findingId: finding.id,
      status: "refuted",
      reason: "middleware enforces ownership before the route runs",
      actor: cells[4].id,
    });
    expect(refuted.status).toBe("refuted");
    expect(refuted.statusActor).toBe(cells[4].id);

    // Forward-only: no second flip, not even by a user.
    await expect(
      svc.reviewFinding(engagement.id, {
        findingId: finding.id,
        status: "verified",
        reason: "changed my mind",
        actor: "user:u1",
      }),
    ).rejects.toThrow(`Finding ${finding.id} is already refuted. Status flips are forward-only.`);
  });

  it("reviewFinding accepts a user actor on an open finding", async () => {
    const { engagement, cells } = await makeStarted();
    const { finding } = await svc.reportFinding(engagement.id, {
      cellId: cells[0].id,
      severity: "medium",
      title: "verbose error leaks stack",
      file: "src/app.ts",
      line: 10,
      body: EVIDENCE,
    });
    const verified = await svc.reviewFinding(engagement.id, {
      findingId: finding.id,
      status: "verified",
      reason: "reproduced against the pinned SHA",
      actor: "user:u1",
    });
    expect(verified.status).toBe("verified");
    expect(verified.statusActor).toBe("user:u1");
    expect(verified.statusReason).toBe("reproduced against the pinned SHA");
  });

  it("listFindings filters by severity, status, cell, and file substring", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.reportFinding(engagement.id, {
      cellId: cells[0].id,
      severity: "high",
      title: "IDOR on sessions",
      file: "src/routes/sessions.ts",
      line: 42,
      body: EVIDENCE,
    });
    await svc.reportFinding(engagement.id, {
      cellId: cells[1].id,
      severity: "low",
      title: "verbose logging",
      file: "src/lib/log.ts",
      line: 7,
      body: EVIDENCE,
    });
    const high = await svc.listFindings(engagement.id, { severity: "high" });
    expect(high.findings).toHaveLength(1);
    expect(high.findings[0].title).toBe("IDOR on sessions");
    const byPath = await svc.listFindings(engagement.id, { path: "lib/log" });
    expect(byPath.findings).toHaveLength(1);
    expect(byPath.findings[0].title).toBe("verbose logging");
    const byCell = await svc.listFindings(engagement.id, { cellId: cells[1].id });
    expect(byCell.findings).toHaveLength(1);
    const open = await svc.listFindings(engagement.id, { status: "open" });
    expect(open.findings).toHaveLength(2);
    expect(open.nextCursor).toBeNull();
  });

  // ── Close + manifest ─────────────────────────────────────────────────────

  it("closeEngagement refuses while a cell is pending", async () => {
    const { engagement } = await makeStarted();
    await expect(svc.closeEngagement(engagement.id)).rejects.toThrow(
      "Cell 01 is pending. Complete or fail every cell before closing.",
    );
  });

  it("closeEngagement computes the manifest with distinct-fingerprint counts", async () => {
    const { engagement, cells } = await makeStarted();
    for (const cell of cells) {
      const result = await runCellToCompletion(engagement.id, cell);
      expect(result.outcome).toBe("completed");
    }
    // Two findings sharing one fingerprint (same file/bucket/title) plus one
    // distinct — the manifest counts 2 distinct, not 3 rows.
    const shape = { file: "src/routes/sessions.ts", line: 42, title: "IDOR on sessions" };
    await svc.reportFinding(engagement.id, { cellId: cells[1].id, severity: "high", ...shape, body: EVIDENCE });
    await svc.reportFinding(engagement.id, { cellId: cells[1].id, severity: "high", ...shape, line: 45, body: EVIDENCE });
    const third = await svc.reportFinding(engagement.id, {
      cellId: cells[2].id,
      severity: "medium",
      title: "template injection in emails",
      file: "src/lib/mail.ts",
      line: 88,
      body: EVIDENCE,
    });
    await svc.reviewFinding(engagement.id, {
      findingId: third.finding.id,
      status: "refuted",
      reason: "the template variables are escaped by the renderer",
      actor: cells[4].id,
    });

    const manifest = await svc.closeEngagement(engagement.id);
    expect(manifest.status).toBe("completed");
    expect(manifest.repoRef).toBe(SHA);
    expect(manifest.cells).toHaveLength(5);
    expect(manifest.cells[1]).toMatchObject({
      ordinal: 2,
      dir: "02-authz-sweep",
      persona: "code-review",
      status: "completed",
      attempts: 1,
      stateDocRevisions: 1,
      findings: 2,
    });
    expect(manifest.findings.total).toBe(3);
    expect(manifest.findings.distinctBySeverity).toEqual({
      critical: 0,
      high: 1,
      medium: 1,
      low: 0,
      info: 0,
    });
    expect(manifest.findings.statusBreakdown).toEqual({ open: 2, verified: 0, refuted: 1 });
    expect(manifest.findings.filedLinks).toBe(0);

    const after = await svc.getEngagement(engagement.id);
    expect(after?.engagement.status).toBe("completed");
  });

  it("closeEngagement marks the engagement failed when a cell failed", async () => {
    const { engagement, cells } = await makeStarted();
    for (const cell of cells.slice(0, 4)) {
      await runCellToCompletion(engagement.id, cell);
    }
    await svc.dispatchCell(engagement.id, { cellId: cells[4].id, spawn });
    await svc.failCell(engagement.id, cells[4].id, "child died");
    const manifest = await svc.closeEngagement(engagement.id);
    expect(manifest.status).toBe("failed");
    expect(manifest.cells[4].status).toBe("failed");
  });

  // ── Progress ─────────────────────────────────────────────────────────────

  it("getRunningCellProgress parses the running cell's latest state doc, tolerantly", async () => {
    const { engagement, cells } = await makeStarted();
    expect(await svc.getRunningCellProgress(engagement.id)).toBeNull();
    await svc.dispatchCell(engagement.id, { spawn });
    expect(await svc.getRunningCellProgress(engagement.id)).toBeNull();
    await svc.writeFile(engagement.id, {
      actorCellId: cells[0].id,
      path: `/cells/${cells[0].dir}/state.yml`,
      content: [
        "protocol_version: 1",
        "status: working",
        "checklist:",
        "  pending: 33",
        "  done: 14",
        "queue:",
        "  pending: 3",
        "  done: 22",
      ].join("\n"),
    });
    expect(await svc.getRunningCellProgress(engagement.id)).toEqual({
      status: "working",
      checklist: { pending: 33, done: 14 },
      queue: { pending: 3, done: 22 },
    });
    // A doc that no longer parses (seeded directly — writes validate) reads
    // as no progress, never an error.
    await db
      .update(securityFiles)
      .set({ content: "{{not yaml" })
      .where(
        and(
          eq(securityFiles.engagementId, engagement.id),
          eq(securityFiles.path, `/cells/${cells[0].dir}/state.yml`),
        ),
      );
    expect(await svc.getRunningCellProgress(engagement.id)).toBeNull();
  });

  // ── Compaction stamps (M5) ───────────────────────────────────────────────

  it("stampCellCompaction stamps compactedAt and measures staleness, mutating nothing else", async () => {
    let clock = 1_000_000;
    const clocked = createSecurityEngagementService({ db, now: () => clock });
    const created = await clocked.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
    const { cells } = await clocked.startEngagement(created.id, { resolvedSha: SHA });
    await clocked.dispatchCell(created.id, {
      cellId: cells[0].id,
      spawn: async () => ({ childSessionId: "child_stamp" }),
    });

    // No state doc yet → staleness measures from the dispatch. 5 minutes in
    // is inside the stride: stamped, not stale.
    clock += 5 * 60_000;
    const fresh = await clocked.stampCellCompaction("child_stamp");
    expect(fresh).not.toBeNull();
    expect(fresh!.cell.compactedAt).toBe(clock);
    expect(fresh!.stateDocAgeMs).toBe(5 * 60_000);
    expect(fresh!.stale).toBe(false);

    // A checkpoint now, compaction 11 minutes later → stale.
    await clocked.writeFile(created.id, {
      actorCellId: cells[0].id,
      path: `/cells/${cells[0].dir}/state.yml`,
      content: YIELD_DOC,
    });
    clock += STATE_DOC_STALE_MS + 60_000;
    const stale = await clocked.stampCellCompaction("child_stamp");
    expect(stale!.stale).toBe(true);
    expect(stale!.stateDocAgeMs).toBe(STATE_DOC_STALE_MS + 60_000);
    expect(stale!.cell.compactedAt).toBe(clock);

    // Alert, don't auto-repair: the stamp is the ONLY mutation. Status,
    // attempts, child claim, and settledAt are untouched.
    const rows = await db.select().from(securityCells).where(eq(securityCells.id, cells[0].id)).limit(1);
    expect(rows[0].compactedAt).toBe(clock);
    expect(rows[0].status).toBe("running");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].childSessionId).toBe("child_stamp");
    expect(rows[0].settledAt).toBeNull();
  });

  it("stampCellCompaction returns null for a session no running cell claims", async () => {
    const { engagement, cells } = await makeStarted();
    expect(await svc.stampCellCompaction("child_nobody")).toBeNull();
    // A settled cell's claim no longer resolves either.
    await runCellToCompletion(engagement.id, cells[0]);
    expect(await svc.stampCellCompaction("child_1")).toBeNull();
    const rows = await db.select().from(securityCells).where(eq(securityCells.id, cells[0].id)).limit(1);
    expect(rows[0].compactedAt).toBeNull();
  });

  // ── Dispatch prompt ──────────────────────────────────────────────────────

  it("buildDispatchPrompt names ONLY the reads cells' state doc paths", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    // Cell 3 (injection-sweep) reads only cell 1 — cell 2's completed state
    // doc must NOT appear even though it exists.
    const readsCells = cells.filter((c) => c.ordinal === 1);
    const prompt = buildDispatchPrompt(cells[2], plan, readsCells, "PROTOCOL BODY");
    expect(prompt).toContain('You are the "code-review" persona for security cell 03-injection-sweep');
    expect(prompt).toContain(`Goal: ${cells[2].goal}`);
    expect(prompt).toContain("Your cell directory in the engagement tree is /cells/03-injection-sweep/.");
    expect(prompt).toContain("- /cells/01-recon/state.yml");
    expect(prompt).not.toContain("/cells/02-authz-sweep/state.yml");
    expect(prompt).not.toContain("/cells/04-secrets-config/state.yml");
    expect(prompt).toContain("PROTOCOL BODY");
  });

  it("buildDispatchPrompt carries resume instructions and path scope", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(
      engagement.plan.replace(
        "    name: injection-sweep\n",
        '    name: injection-sweep\n    paths: ["packages/api/**"]\n',
      ),
      KNOWN_PERSONAS,
    );
    const resumed: SecurityCellRow = { ...cells[2], mode: "resume" };
    const prompt = buildDispatchPrompt(resumed, plan, [], "P");
    expect(prompt).toContain("Mode: resume");
    expect(prompt).toContain("read your own latest state doc at /cells/03-injection-sweep/state.yml");
    expect(prompt).toContain("packages/api/**");
  });
});
