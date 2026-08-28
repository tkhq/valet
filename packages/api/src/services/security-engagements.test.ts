import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { PgDb } from "@valet/store-postgres";
import {
  codeReviewPresetPlan,
  findingFingerprint,
  parsePlan,
  presetPlan,
  serializePlan,
  KNOWN_PERSONAS,
} from "@valet/plugin-security";
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

/**
 * The five-cell code-review plan with the sweeps' `triad` flags stripped, so
 * `makeStarted` materializes exactly five cells. Most of this suite predates
 * the M-P2b triad expansion and asserts a five-cell shape (dispatch order,
 * verify at ordinal 5, findings per cell). The triad expansion has its own
 * `startEngagement expands triad phases` test below and the plugin-security
 * unit suite; this fixture keeps the rest of the suite on the flat shape.
 */
const FLAT_PLAN = serializePlan(
  parsePlan(codeReviewPresetPlan(), KNOWN_PERSONAS)
    .cells // Drop the report cell and the triad flags so this suite stays on the
    // flat five-cell shape it predates (recon + 3 sweeps + verify).
    .filter((c) => c.persona !== "report")
    .map((c) => {
      const { triad: _triad, ...rest } = c;
      return rest;
    }),
);

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
      plan: FLAT_PLAN,
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

  it("startEngagement expands triad phases into architect → worker → verifier (M-P2b)", async () => {
    // The real code-review preset marks its three sweeps triad: true.
    const engagement = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
    const { cells } = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    // 1 recon + 3 triads (3 cells each) + 1 verify + 1 report = 12.
    expect(cells).toHaveLength(12);
    expect(cells.map((c) => c.dir)).toEqual([
      "01-recon",
      "02-authz-sweep-plan",
      "03-authz-sweep",
      "04-authz-sweep-verify",
      "05-injection-sweep-plan",
      "06-injection-sweep",
      "07-injection-sweep-verify",
      "08-secrets-config-plan",
      "09-secrets-config",
      "10-secrets-config-verify",
      "11-verify",
      "12-report",
    ]);
    expect(cells.map((c) => c.persona)).toEqual([
      "code-review",
      "architect",
      "code-review",
      "verifier",
      "architect",
      "code-review",
      "verifier",
      "architect",
      "code-review",
      "verifier",
      "code-review",
      "report",
    ]);
    // The authz worker (ordinal 3) reads recon (1) + its architect (2). Its
    // verifier (ordinal 4) reads the worker (3). review only on verifiers +
    // the final engagement verify.
    expect(JSON.parse(cells[2].reads)).toEqual([1, 2]);
    expect(JSON.parse(cells[3].reads)).toEqual([3]);
    expect(cells.filter((c) => c.review).map((c) => c.ordinal)).toEqual([4, 7, 10, 11]);
    // /plan.yml reflects the expanded plan.
    const planFile = await svc.readFile(engagement.id, "/plan.yml");
    const reparsed = parsePlan(planFile.content, KNOWN_PERSONAS);
    expect(reparsed.cells).toHaveLength(12);
  });

  it("materializes the full-pentest preset with the model personas (M-P2c)", async () => {
    const engagement = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: presetPlan("full-pentest"),
    });
    const { cells } = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    // 1 recon + 1 threat-model + 4 triads (3 each) + 1 attack-tree + 1 verify +
    // 1 report (M-P3, the final cell after verify).
    expect(cells).toHaveLength(17);
    // The model personas run as single cells; the code-heavy sweeps expanded.
    const byDir = new Map(cells.map((c) => [c.dir, c]));
    expect(byDir.get("02-threat-model")?.persona).toBe("threat-model");
    expect(byDir.get("15-attack-tree")?.persona).toBe("attack-tree");
    // The SAST triad's worker runs under the sast persona.
    const sastWorker = cells.find((c) => c.dir === "07-sast");
    expect(sastWorker?.persona).toBe("sast");
    // The SAST plan/verify cells are the architect/verifier.
    expect(byDir.get("06-sast-plan")?.persona).toBe("architect");
    expect(byDir.get("08-sast-verify")?.persona).toBe("verifier");
    // The report cell is last (ordinal 17), runs the report persona, and is not
    // a review cell — it composes over the engagement (M-P3).
    const report = cells.find((c) => c.dir === "17-report");
    expect(report?.persona).toBe("report");
    expect(report?.ordinal).toBe(17);
    expect(report?.review).toBe(false);
  });

  it("full-pentest dispatch prompts name each cell's own playbook (M-P2c)", async () => {
    const engagement = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: presetPlan("full-pentest"),
    });
    const { cells } = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    // The dispatch prompt reads the EXPANDED plan (the materialized 17 cells),
    // not the compact 9-cell preset — a materialized cell's ordinal only exists
    // in /plan.yml.
    const planFile = await svc.readFile(engagement.id, "/plan.yml");
    const plan = parsePlan(planFile.content, KNOWN_PERSONAS);
    const threatModel = cells.find((c) => c.dir === "02-threat-model");
    const attackTree = cells.find((c) => c.dir === "15-attack-tree");
    const sastWorker = cells.find((c) => c.dir === "07-sast");
    if (!threatModel || !attackTree || !sastWorker) throw new Error("expected the model cells");
    expect(buildDispatchPrompt(threatModel, plan, [], "P")).toContain(
      "Methodology: read /playbooks/threat-model.md with sec_fs_read",
    );
    expect(buildDispatchPrompt(attackTree, plan, [], "P")).toContain(
      "Methodology: read /playbooks/attack-tree.md with sec_fs_read",
    );
    expect(buildDispatchPrompt(sastWorker, plan, [], "P")).toContain(
      "Methodology: read /playbooks/sast.md with sec_fs_read",
    );
    // The new playbooks are served in the engagement tree, readable and non-empty.
    for (const name of ["threat-model", "attack-tree", "sast"]) {
      const file = await svc.readFile(engagement.id, `/playbooks/${name}.md`);
      expect(file.content.length).toBeGreaterThan(400);
    }
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
    const playbook = await svc.readFile(engagement.id, "/playbooks/authz.md");
    expect(playbook.revision).toBeNull();
    expect(playbook.content).toContain("Broken Access Control");
    await expect(svc.readFile(engagement.id, "/playbooks/nope.md")).rejects.toThrow(
      "No playbook at /playbooks/nope.md. Use sec_fs_list to see the tree.",
    );
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
    // The preset's five cells reference five playbooks; each is a read-only
    // mount alongside /plan.yml and /protocol.md.
    expect(all.map((e) => e.path)).toEqual([
      "/cells/01-recon/notes.md",
      "/plan.yml",
      "/playbooks/authz.md",
      "/playbooks/injection.md",
      "/playbooks/recon.md",
      "/playbooks/secrets-config.md",
      "/playbooks/verify.md",
      "/protocol.md",
    ]);
    const notes = all.find((e) => e.path === path);
    expect(notes).toEqual({ path, revisions: 2, size: 5 });
    const scoped = await svc.listFiles(engagement.id, "/cells/");
    expect(scoped.map((e) => e.path)).toEqual([path]);
    const playbooks = await svc.listFiles(engagement.id, "/playbooks/");
    expect(playbooks.map((e) => e.path)).toEqual([
      "/playbooks/authz.md",
      "/playbooks/injection.md",
      "/playbooks/recon.md",
      "/playbooks/secrets-config.md",
      "/playbooks/verify.md",
    ]);
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

  it("only the triad verifier cell may flip a finding, not the architect or worker (M-P2b)", async () => {
    const engagement = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
    const { cells } = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    // The authz triad: [1]=recon, [2]=authz-plan (architect), [3]=authz-sweep
    // (worker), [4]=authz-verify (verifier).
    const architect = cells[1];
    const worker = cells[2];
    const verifier = cells[3];
    expect(architect.persona).toBe("architect");
    expect(worker.persona).toBe("code-review");
    expect(verifier.persona).toBe("verifier");

    const { finding } = await svc.reportFinding(engagement.id, {
      cellId: worker.id,
      severity: "high",
      title: "IDOR on sessions",
      file: "src/routes/sessions.ts",
      line: 42,
      body: EVIDENCE,
    });

    // The architect (persona architect, review false) cannot flip.
    await expect(
      svc.reviewFinding(engagement.id, {
        findingId: finding.id,
        status: "refuted",
        reason: "the plan says so",
        actor: architect.id,
      }),
    ).rejects.toThrow("Only review cells may flip finding statuses.");
    // The worker cannot flip its own finding.
    await expect(
      svc.reviewFinding(engagement.id, {
        findingId: finding.id,
        status: "refuted",
        reason: "I take it back",
        actor: worker.id,
      }),
    ).rejects.toThrow("Only review cells may flip finding statuses.");
    // The verifier (review: true) refutes it.
    const refuted = await svc.reviewFinding(engagement.id, {
      findingId: finding.id,
      status: "refuted",
      reason: "the taint never reaches the sink: ownership is checked in middleware",
      actor: verifier.id,
    });
    expect(refuted.status).toBe("refuted");
    expect(refuted.statusActor).toBe(verifier.id);
  });

  it("buildDispatchPrompt frames the architect and verifier by role (M-P2b)", async () => {
    const engagement = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
    const { cells } = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    // /plan.yml carries the expanded plan (startEngagement wrote it back).
    const expandedPlan = parsePlan(
      (await svc.readFile(engagement.id, "/plan.yml")).content,
      KNOWN_PERSONAS,
    );
    const architect = cells[1];
    const worker = cells[2];
    const verifier = cells[3];

    const architectPrompt = buildDispatchPrompt(architect, expandedPlan, [], "PROTOCOL");
    expect(architectPrompt).toContain("You are the ARCHITECT of this phase");
    expect(architectPrompt).toContain("falsifiable checklist");
    expect(architectPrompt).toContain("do NOT report findings");

    const verifierPrompt = buildDispatchPrompt(verifier, expandedPlan, [], "PROTOCOL");
    expect(verifierPrompt).toContain("You are the VERIFIER of this phase");
    expect(verifierPrompt).toContain("re-derive every finding's dataflow");
    expect(verifierPrompt).toContain("PASS / CONDITIONAL / FAIL");
    expect(verifierPrompt).toContain("Refute a finding you disprove");

    // The worker (code-review persona) gets neither framing.
    const workerPrompt = buildDispatchPrompt(worker, expandedPlan, [], "PROTOCOL");
    expect(workerPrompt).not.toContain("You are the ARCHITECT");
    expect(workerPrompt).not.toContain("You are the VERIFIER");
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

  // ── Handoffs (fix sessions) ──────────────────────────────────────────────

  it("recordHandoff inserts a row and listHandoffs returns it", async () => {
    const { engagement, cells } = await makeStarted();
    const { finding } = await svc.reportFinding(engagement.id, {
      cellId: cells[0].id,
      severity: "high",
      title: "IDOR on sessions",
      body: EVIDENCE,
    });
    const row = await svc.recordHandoff({
      engagementId: engagement.id,
      findingId: finding.id,
      childSessionId: "child_fix_1",
      title: "Fix: IDOR on sessions",
      task: "patch the ownership check",
      createdBy: "user1",
    });
    expect(row.childSessionId).toBe("child_fix_1");
    expect(row.task).toBe("patch the ownership check");
    const all = await svc.listHandoffs(engagement.id);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(row.id);
  });

  it("listHandoffs returns newest first and filters by findingId", async () => {
    const { engagement, cells } = await makeStarted();
    const a = await svc.reportFinding(engagement.id, {
      cellId: cells[0].id,
      severity: "high",
      title: "finding A",
      body: EVIDENCE,
    });
    const b = await svc.reportFinding(engagement.id, {
      cellId: cells[1].id,
      severity: "low",
      title: "finding B",
      body: EVIDENCE,
    });
    // Two fix sessions for finding A (no unique constraint) plus one for B.
    const first = await svc.recordHandoff({
      engagementId: engagement.id,
      findingId: a.finding.id,
      childSessionId: "child_a1",
      title: "Fix A first",
      createdBy: "user1",
    });
    const second = await svc.recordHandoff({
      engagementId: engagement.id,
      findingId: a.finding.id,
      childSessionId: "child_a2",
      title: "Fix A second",
      createdBy: "user1",
    });
    await svc.recordHandoff({
      engagementId: engagement.id,
      findingId: b.finding.id,
      childSessionId: "child_b1",
      title: "Fix B",
      createdBy: "user1",
    });
    const forA = await svc.listHandoffs(engagement.id, { findingId: a.finding.id });
    expect(forA).toHaveLength(2);
    // Only finding A's handoffs, no unique constraint blocked the second.
    expect(new Set(forA.map((h) => h.id))).toEqual(new Set([first.id, second.id]));
    // Newest first: ordered by (createdAt desc, id desc). Same-ms inserts fall
    // to the id tiebreak, so assert the returned order matches that sort.
    const sorted = [...forA].sort((x, y) =>
      y.createdAt - x.createdAt || (y.id < x.id ? -1 : y.id > x.id ? 1 : 0),
    );
    expect(forA.map((h) => h.id)).toEqual(sorted.map((h) => h.id));
    // A nullable task round-trips as null.
    expect(forA[0].task).toBeNull();
    const all = await svc.listHandoffs(engagement.id);
    expect(all).toHaveLength(3);
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

  // ── Coverage ledger (NOT_ASSESSED, M-P2d) ────────────────────────────────

  it("reportCoverage inserts assessed and not_assessed rows and listCoverage returns them", async () => {
    const { engagement, cells } = await makeStarted();
    const assessed = await svc.reportCoverage(engagement.id, {
      cellId: cells[1].id,
      area: "secrets scan",
      status: "assessed",
      tool: "gitleaks",
    });
    expect(assessed.status).toBe("assessed");
    expect(assessed.reason).toBeNull();
    const gap = await svc.reportCoverage(engagement.id, {
      cellId: cells[1].id,
      area: "semgrep owasp",
      status: "not_assessed",
      tool: "semgrep",
      reason: "OWASP sink rules not scanned because semgrep is missing.",
    });
    expect(gap.status).toBe("not_assessed");
    expect(gap.reason).toContain("semgrep is missing");

    const all = await svc.listCoverage(engagement.id);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.area)).toEqual(["secrets scan", "semgrep owasp"]);
    const scoped = await svc.listCoverage(engagement.id, { cellId: cells[1].id });
    expect(scoped).toHaveLength(2);
    const other = await svc.listCoverage(engagement.id, { cellId: cells[2].id });
    expect(other).toHaveLength(0);
  });

  it("reportCoverage rejects a not_assessed area with no reason", async () => {
    const { engagement, cells } = await makeStarted();
    await expect(
      svc.reportCoverage(engagement.id, {
        cellId: cells[1].id,
        area: "semgrep owasp",
        status: "not_assessed",
        tool: "semgrep",
      }),
    ).rejects.toThrow(/reason naming the consequence/);
  });

  it("reportCoverage rejects an empty area", async () => {
    const { engagement, cells } = await makeStarted();
    await expect(
      svc.reportCoverage(engagement.id, { cellId: cells[1].id, area: "   ", status: "assessed" }),
    ).rejects.toThrow(/Coverage needs an area/);
  });

  it("closeEngagement manifest includes the coverage rollup and the gap list", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.reportCoverage(engagement.id, {
      cellId: cells[1].id,
      area: "secrets scan",
      status: "assessed",
      tool: "gitleaks",
    });
    await svc.reportCoverage(engagement.id, {
      cellId: cells[1].id,
      area: "authz sweep",
      status: "assessed",
    });
    await svc.reportCoverage(engagement.id, {
      cellId: cells[2].id,
      area: "semgrep owasp",
      status: "not_assessed",
      tool: "semgrep",
      reason: "OWASP sink rules not scanned because semgrep is missing.",
    });
    for (const cell of cells) await runCellToCompletion(engagement.id, cell);

    const manifest = await svc.closeEngagement(engagement.id);
    expect(manifest.coverage.assessed).toBe(2);
    expect(manifest.coverage.notAssessed).toBe(1);
    expect(manifest.coverage.gaps).toHaveLength(1);
    expect(manifest.coverage.gaps[0]).toEqual({
      area: "semgrep owasp",
      tool: "semgrep",
      reason: "OWASP sink rules not scanned because semgrep is missing.",
    });
  });

  it("closeEngagement manifest reports an empty coverage rollup when none recorded", async () => {
    const { engagement, cells } = await makeStarted();
    for (const cell of cells) await runCellToCompletion(engagement.id, cell);
    const manifest = await svc.closeEngagement(engagement.id);
    expect(manifest.coverage).toEqual({ assessed: 0, notAssessed: 0, gaps: [] });
  });

  // ── Report artifact (M-P3) ───────────────────────────────────────────────

  it("getReport returns null until writeReport stores the artifact", async () => {
    const { engagement } = await makeStarted();
    // No report cell has run — the columns are null.
    expect(await svc.getReport(engagement.id)).toBeNull();

    const md = "# Report\n\nExec summary: one confirmed high finding.";
    const json = { executiveSummary: "one high", findings: [{ severity: "high", title: "IDOR" }] };
    const written = await svc.writeReport(engagement.id, { markdown: md, json });
    expect(written.markdown).toBe(md);
    expect(written.json).toEqual(json);
    expect(written.generatedAt).toBeGreaterThan(0);

    // getReport now returns the stored content, round-tripping the JSON snapshot.
    const read = await svc.getReport(engagement.id);
    expect(read).not.toBeNull();
    expect(read!.markdown).toBe(md);
    expect(read!.json).toEqual(json);
    expect(read!.generatedAt).toBe(written.generatedAt);
  });

  it("writeReport overwrites a prior report (a re-run replaces the stale artifact)", async () => {
    const { engagement } = await makeStarted();
    await svc.writeReport(engagement.id, { markdown: "# First", json: { v: 1 } });
    await svc.writeReport(engagement.id, { markdown: "# Second", json: { v: 2 } });
    const read = await svc.getReport(engagement.id);
    expect(read!.markdown).toBe("# Second");
    expect(read!.json).toEqual({ v: 2 });
  });

  it("closeEngagement manifest includes the report the report cell wrote", async () => {
    const { engagement, cells } = await makeStarted();
    // The report cell writes the artifact before the runner closes.
    await svc.writeReport(engagement.id, {
      markdown: "# Valet Security report\n\nOne confirmed finding.",
      json: { executiveSummary: "one finding" },
    });
    for (const cell of cells) await runCellToCompletion(engagement.id, cell);

    const manifest = await svc.closeEngagement(engagement.id);
    expect(manifest.report).not.toBeNull();
    expect(manifest.report!.markdown).toContain("Valet Security report");
    expect(manifest.report!.json).toEqual({ executiveSummary: "one finding" });
  });

  it("closeEngagement manifest report is null when no report was written", async () => {
    const { engagement, cells } = await makeStarted();
    for (const cell of cells) await runCellToCompletion(engagement.id, cell);
    const manifest = await svc.closeEngagement(engagement.id);
    expect(manifest.report).toBeNull();
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

  // ── Needs loop / pivot-coordinator (M-P4c) ───────────────────────────────

  /** A two-cell plan whose ordinal-2 sweep declares a payments path glob, so a
   * scope need naming that path auto-resolves. `configTools` declares gitleaks,
   * so a tool need naming it auto-resolves. */
  const SCOPED_PLAN = [
    "cells:",
    "  - ordinal: 1",
    "    persona: code-review",
    "    goal: Map the codebase",
    "  - ordinal: 2",
    "    persona: code-review",
    "    goal: Sweep payments",
    "    paths:",
    "      - packages/payments/**",
    "    reads: [1]",
    "",
  ].join("\n");

  async function makeScopedStarted() {
    const engagement = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: SCOPED_PLAN,
      config: { tools: [{ id: "gitleaks" }] },
    });
    return svc.startEngagement(engagement.id, { resolvedSha: SHA });
  }

  it("reportNeed inserts an open need and listNeeds returns it", async () => {
    const { engagement, cells } = await makeScopedStarted();
    const need = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "credential",
      description: "A staging admin token to reach /admin routes.",
    });
    expect(need.status).toBe("open");
    expect(need.resolution).toBeNull();
    const all = await svc.listNeeds(engagement.id);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(need.id);
    const scoped = await svc.listNeeds(engagement.id, { cellId: cells[1].id });
    expect(scoped).toHaveLength(1);
    const other = await svc.listNeeds(engagement.id, { cellId: cells[0].id });
    expect(other).toHaveLength(0);
  });

  it("reportNeed rejects an empty description", async () => {
    const { engagement, cells } = await makeScopedStarted();
    await expect(
      svc.reportNeed(engagement.id, { cellId: cells[1].id, kind: "scope", description: "  " }),
    ).rejects.toThrow(/must name what is blocked/);
  });

  it("resolveNeeds auto-resolves an in-scope path and a declared tool, leaves a credential for the human", async () => {
    const { engagement, cells } = await makeScopedStarted();
    const scope = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "scope",
      description: "Sweep packages/payments too — it is in scope.",
    });
    const tool = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "tool",
      description: "Run gitleaks for secrets.",
    });
    const cred = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "credential",
      description: "A staging admin token to reach /admin routes.",
    });

    const result = await svc.resolveNeeds(engagement.id);
    expect(result.autoResolved.map((n) => n.id).sort()).toEqual([scope.id, tool.id].sort());
    expect(result.needsHuman.map((n) => n.id)).toEqual([cred.id]);
    expect(result.pendingHuman.map((n) => n.id)).toEqual([cred.id]);

    const rows = await svc.listNeeds(engagement.id);
    const byId = new Map(rows.map((n) => [n.id, n]));
    expect(byId.get(scope.id)?.status).toBe("auto_resolved");
    expect(byId.get(scope.id)?.resolution).toContain("packages/payments");
    expect(byId.get(scope.id)?.resolvedAt).not.toBeNull();
    expect(byId.get(tool.id)?.status).toBe("auto_resolved");
    expect(byId.get(tool.id)?.resolution).toContain("gitleaks");
    // A credential NEVER auto-resolves — the coordinator never grants one.
    expect(byId.get(cred.id)?.status).toBe("needs_human");
    expect(byId.get(cred.id)?.resolution).toBeNull();
  });

  it("resolveNeeds never auto-resolves a decision", async () => {
    const { engagement, cells } = await makeScopedStarted();
    await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "decision",
      description: "May I run a destructive test against staging?",
    });
    const result = await svc.resolveNeeds(engagement.id);
    expect(result.autoResolved).toHaveLength(0);
    expect(result.needsHuman).toHaveLength(1);
  });

  it("resolveEngagementNeeds marks answered and resets ONLY the affected cell to pending (delta re-run)", async () => {
    const { engagement, cells } = await makeScopedStarted();
    // Run cell 1 to completion; cell 2 records a credential need and yields.
    await runCellToCompletion(engagement.id, cells[0]);
    await svc.dispatchCell(engagement.id, { cellId: cells[1].id, spawn });
    const need = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "credential",
      description: "A staging admin token.",
    });
    await svc.writeFile(engagement.id, {
      actorCellId: cells[1].id,
      path: `/cells/${cells[1].dir}/state.yml`,
      content: YIELD_DOC,
    });
    await svc.completeCell(engagement.id, cells[1].id, { settled: true });
    await svc.resolveNeeds(engagement.id);

    const outcome = await svc.resolveEngagementNeeds(engagement.id, [
      { needId: need.id, resolution: "Token: stg_admin_abc123." },
    ]);
    expect(outcome.answered).toHaveLength(1);
    expect(outcome.answered[0].status).toBe("answered");
    expect(outcome.answered[0].resolution).toContain("stg_admin_abc123");
    // Only cell 2 (the one that recorded the need) reset; cell 1 stays completed.
    expect(outcome.resetCells.map((c) => c.id)).toEqual([cells[1].id]);
    const rows = await db
      .select()
      .from(securityCells)
      .where(eq(securityCells.engagementId, engagement.id));
    const byOrdinal = new Map(rows.map((c) => [c.ordinal, c]));
    expect(byOrdinal.get(1)?.status).toBe("completed");
    expect(byOrdinal.get(2)?.status).toBe("pending");
    expect(byOrdinal.get(2)?.mode).toBe("resume");
    expect(byOrdinal.get(2)?.settledAt).toBeNull();
  });

  it("resolveEngagementNeeds dismiss marks dismissed and does NOT reset the cell", async () => {
    const { engagement, cells } = await makeScopedStarted();
    const need = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "decision",
      description: "May I run a destructive test?",
    });
    await svc.resolveNeeds(engagement.id);
    const outcome = await svc.resolveEngagementNeeds(engagement.id, [
      { needId: need.id, resolution: "Not worth it.", dismiss: true },
    ]);
    expect(outcome.answered[0].status).toBe("dismissed");
    expect(outcome.resetCells).toHaveLength(0);
    const rows = await db
      .select()
      .from(securityCells)
      .where(and(eq(securityCells.engagementId, engagement.id), eq(securityCells.id, cells[1].id)));
    expect(rows[0].status).toBe("pending"); // never dispatched, still pending
  });

  it("resolveEngagementNeeds refuses a need not waiting on a human, and an unknown need", async () => {
    const { engagement, cells } = await makeScopedStarted();
    const need = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "credential",
      description: "A token.",
    });
    // Still 'open' — resolveNeeds not yet run.
    await expect(
      svc.resolveEngagementNeeds(engagement.id, [{ needId: need.id, resolution: "x" }]),
    ).rejects.toThrow(/not needs_human/);
    await expect(
      svc.resolveEngagementNeeds(engagement.id, [{ needId: "need_missing", resolution: "x" }]),
    ).rejects.toThrow(/No need need_missing/);
  });

  it("the delta re-dispatch carries the answered need's resolution into the prompt", async () => {
    const { engagement, cells } = await makeScopedStarted();
    await runCellToCompletion(engagement.id, cells[0]);
    await svc.dispatchCell(engagement.id, { cellId: cells[1].id, spawn });
    const need = await svc.reportNeed(engagement.id, {
      cellId: cells[1].id,
      kind: "credential",
      description: "A staging admin token.",
    });
    await svc.writeFile(engagement.id, {
      actorCellId: cells[1].id,
      path: `/cells/${cells[1].dir}/state.yml`,
      content: YIELD_DOC,
    });
    await svc.completeCell(engagement.id, cells[1].id, { settled: true });
    await svc.resolveNeeds(engagement.id);
    await svc.resolveEngagementNeeds(engagement.id, [
      { needId: need.id, resolution: "Token: stg_admin_abc123." },
    ]);
    // Re-dispatch the reset cell; the prompt carries the resolution block.
    const { prompt } = await svc.dispatchCell(engagement.id, { cellId: cells[1].id, spawn });
    expect(prompt).toContain("Resolved needs (continue the blocked work)");
    expect(prompt).toContain("stg_admin_abc123");
    expect(prompt).toContain("A staging admin token.");
  });

  it("buildDispatchPrompt is byte-identical when no needs are resolved", async () => {
    const { engagement, cells } = await makeScopedStarted();
    const planFile = await svc.readFile(engagement.id, "/plan.yml");
    const plan = parsePlan(planFile.content, KNOWN_PERSONAS);
    const withEmpty = buildDispatchPrompt(cells[1], plan, [], "P", false, {}, []);
    const withNone = buildDispatchPrompt(cells[1], plan, [], "P", false, {});
    expect(withEmpty).toBe(withNone);
    expect(withEmpty).not.toContain("Resolved needs");
  });

  // ── Cancel ───────────────────────────────────────────────────────────────

  it("cancelEngagement from planning sets cancelled and fails pending cells", async () => {
    const engagement = await makePlanning();
    const cancelled = await svc.cancelEngagement(engagement.id);
    expect(cancelled.engagement.status).toBe("cancelled");
    expect(cancelled.terminatedChildSessionId).toBeUndefined();
  });

  it("cancelEngagement from running fails the running cell and returns its child", async () => {
    const { engagement, cells } = await makeStarted();
    const { cell } = await svc.dispatchCell(engagement.id, { cellId: cells[0].id, spawn });
    expect(cell.status).toBe("running");
    expect(cell.childSessionId).toBe("child_1");

    const cancelled = await svc.cancelEngagement(engagement.id);
    expect(cancelled.engagement.status).toBe("cancelled");
    expect(cancelled.terminatedChildSessionId).toBe("child_1");

    // Every unsettled cell (the running one AND the pending remainder) is
    // failed; a cancelled engagement holds no live work.
    const after = await db
      .select()
      .from(securityCells)
      .where(eq(securityCells.engagementId, engagement.id));
    expect(after.every((c) => c.status === "failed")).toBe(true);
    expect(after.every((c) => c.settledAt !== null)).toBe(true);
  });

  it("cancelEngagement keeps completed cells terminal and skips yielded/pending only", async () => {
    const { engagement, cells } = await makeStarted();
    await runCellToCompletion(engagement.id, cells[0]); // completed
    await runCellToCompletion(engagement.id, cells[1], YIELD_DOC); // yielded

    const cancelled = await svc.cancelEngagement(engagement.id);
    expect(cancelled.engagement.status).toBe("cancelled");
    expect(cancelled.terminatedChildSessionId).toBeUndefined();

    const after = await db
      .select()
      .from(securityCells)
      .where(eq(securityCells.engagementId, engagement.id));
    const byOrdinal = new Map(after.map((c) => [c.ordinal, c.status]));
    expect(byOrdinal.get(1)).toBe("completed"); // untouched
    expect(byOrdinal.get(2)).toBe("failed"); // yielded → failed
    expect(byOrdinal.get(3)).toBe("failed"); // pending → failed
  });

  it("cancelEngagement refuses a completed engagement", async () => {
    const { engagement, cells } = await makeStarted();
    for (const cell of cells) await runCellToCompletion(engagement.id, cell);
    await svc.closeEngagement(engagement.id);
    await expect(svc.cancelEngagement(engagement.id)).rejects.toThrow(
      "Only a planning or running engagement can be cancelled.",
    );
  });

  it("dispatchCell refuses on a cancelled engagement", async () => {
    const { engagement, cells } = await makeStarted();
    await svc.cancelEngagement(engagement.id);
    await expect(svc.dispatchCell(engagement.id, { cellId: cells[0].id, spawn })).rejects.toThrow(
      "The engagement is cancelled. A closed engagement dispatches nothing.",
    );
  });

  it("closeEngagement refuses a cancelled engagement", async () => {
    const { engagement } = await makeStarted();
    await svc.cancelEngagement(engagement.id);
    await expect(svc.closeEngagement(engagement.id)).rejects.toThrow();
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
    // The cell's methodology playbook is named for the persona to read first.
    expect(prompt).toContain("Methodology: read /playbooks/injection.md with sec_fs_read");
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

  it("buildDispatchPrompt in rescan mode adds recon-inherit / sweep-scoped / verify-reconcile language", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);

    // Recon cell (ordinal 1): inherit the prior map, update only the delta.
    const recon = buildDispatchPrompt(cells[0], plan, [], "P", true);
    expect(recon).toContain("This is a RE-SCAN.");
    expect(recon).toContain("/prior/recon.md");
    expect(recon).toContain("/prior/diff.md");
    expect(recon).toContain("/prior/findings.md");
    expect(recon).toContain("UPDATE it only for the changed files");

    // Sweep cell (ordinal 3): scoped to the changed code.
    const sweep = buildDispatchPrompt(cells[2], plan, [], "P", true);
    expect(sweep).toContain("RE-SCAN scoped to the changed code");
    expect(sweep).toContain("/prior/diff.md");
    expect(sweep).toContain("/prior/findings.md");
    expect(sweep).toContain("Do not re-review unchanged code.");

    // Verify cell (review: true): reconcile the prior findings.
    const verify = buildDispatchPrompt(cells[4], plan, [], "P", true);
    expect(verify).toContain("Reconcile /prior/findings.md");
    expect(verify).toContain("noted as fixed");
    expect(verify).toContain("Attack every open finding");

    // A non-rescan dispatch never mentions /prior/.
    const plain = buildDispatchPrompt(cells[2], plan, [], "P", false);
    expect(plain).not.toContain("/prior/");
    expect(plain).not.toContain("RE-SCAN");
  });

  it("buildDispatchPrompt injects focus + invariants before the protocol (M-F3)", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    const prompt = buildDispatchPrompt(cells[2], plan, [], "PROTOCOL BODY", false, {
      focus: "the multi-tenant data path",
      invariants: [
        "every admin route sits behind requireAdmin",
        "tenant id is always checked in the repository layer",
      ],
    });
    expect(prompt).toContain(
      "Focus of this review (from the engagement): the multi-tenant data path. Weight your checklist toward this",
    );
    expect(prompt).toContain("Treat a VIOLATION of any as a high-signal finding");
    expect(prompt).toContain("- every admin route sits behind requireAdmin");
    expect(prompt).toContain("- tenant id is always checked in the repository layer");
    // The block rides BEFORE the protocol body.
    expect(prompt.indexOf("Focus of this review")).toBeLessThan(prompt.indexOf("PROTOCOL BODY"));
    expect(prompt.indexOf("high-signal finding")).toBeLessThan(prompt.indexOf("PROTOCOL BODY"));
  });

  it("buildDispatchPrompt adds no config block when focus + invariants are absent", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    const bare = buildDispatchPrompt(cells[2], plan, [], "PROTOCOL BODY");
    const withEmpty = buildDispatchPrompt(cells[2], plan, [], "PROTOCOL BODY", false, {
      focus: "   ",
      invariants: ["  ", ""],
    });
    // Empty/whitespace values add nothing — byte-identical to the no-config call.
    expect(withEmpty).toBe(bare);
    expect(bare).not.toContain("Engagement configuration");
    expect(bare).not.toContain("Focus of this review");
    expect(bare).not.toContain("high-signal finding");
  });

  // ── Live personas + authorized scope (M-P4b) ────────────────────────────────

  it("buildDispatchPrompt names the authorized scope for a live persona (M-P4b)", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    // A live cell: clone a materialized cell and set its persona to dast.
    const live: SecurityCellRow = { ...cells[2], persona: "dast" };
    const prompt = buildDispatchPrompt(live, plan, [], "PROTOCOL BODY", false, {
      scopeHosts: ["staging.example.com", "api.staging.example.com"],
    });
    expect(prompt).toContain("--- Authorized scope (live testing) ---");
    expect(prompt).toContain("You are a LIVE persona");
    expect(prompt).toContain("- staging.example.com");
    expect(prompt).toContain("- api.staging.example.com");
    expect(prompt).toContain("A finding or action outside this scope is forbidden");
    // The scope rides before the protocol body.
    expect(prompt.indexOf("Authorized scope")).toBeLessThan(prompt.indexOf("PROTOCOL BODY"));
  });

  it("buildDispatchPrompt tells a live persona to stop when no scope is declared", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    const live: SecurityCellRow = { ...cells[2], persona: "fuzz" };
    const prompt = buildDispatchPrompt(live, plan, [], "PROTOCOL BODY", false, { scopeHosts: [] });
    expect(prompt).toContain("--- Authorized scope (live testing) ---");
    expect(prompt).toContain("No authorized scope is declared");
    expect(prompt).toContain("Do not guess a target");
  });

  it("buildDispatchPrompt adds NO scope block for a non-live persona", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    // cells[2] is a code-review cell — not a live persona.
    const prompt = buildDispatchPrompt(cells[2], plan, [], "PROTOCOL BODY", false, {
      scopeHosts: ["staging.example.com"],
    });
    expect(prompt).not.toContain("Authorized scope (live testing)");
    expect(prompt).not.toContain("LIVE persona");
  });

  // ── Focus + invariants config (M-F3) ───────────────────────────────────────

  it("setEngagementConfig updates focus + invariants while planning and refuses once running", async () => {
    const engagement = await makePlanning();
    const updated = await svc.setEngagementConfig(engagement.id, {
      focus: "auth and tenancy",
      invariants: ["tenant id is always checked in the repository layer", "  ", ""],
    });
    expect(updated.focus).toBe("auth and tenancy");
    // Blank invariants are dropped; the column stores a JSON string[].
    expect(JSON.parse(updated.invariants ?? "[]")).toEqual([
      "tenant id is always checked in the repository layer",
    ]);

    // A focus of "" clears the note; [] clears the list.
    const cleared = await svc.setEngagementConfig(engagement.id, { focus: "", invariants: [] });
    expect(cleared.focus).toBeNull();
    expect(cleared.invariants).toBeNull();

    // Once running, the config is immutable.
    await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    await expect(
      svc.setEngagementConfig(engagement.id, { focus: "too late" }),
    ).rejects.toThrow(/immutable once the engagement is running/);
  });

  it("setEngagementConfig leaves an omitted field untouched", async () => {
    const engagement = await makePlanning();
    await svc.setEngagementConfig(engagement.id, {
      focus: "keep me",
      invariants: ["inv one"],
    });
    // Edit only invariants — focus must survive.
    const after = await svc.setEngagementConfig(engagement.id, { invariants: ["inv two"] });
    expect(after.focus).toBe("keep me");
    expect(JSON.parse(after.invariants ?? "[]")).toEqual(["inv two"]);
  });

  it("dispatchCell carries the engagement's focus + invariants into the prompt (M-F3)", async () => {
    const engagement = await makePlanning();
    await svc.setEngagementConfig(engagement.id, {
      focus: "the webhook verifier",
      invariants: ["all webhooks verify an HMAC signature"],
    });
    const { cells } = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    const { prompt } = await svc.dispatchCell(engagement.id, { cellId: cells[0].id, spawn });
    expect(prompt).toContain("Focus of this review (from the engagement): the webhook verifier");
    expect(prompt).toContain("- all webhooks verify an HMAC signature");
  });

  // ── Threat-category library (M-P2a) ────────────────────────────────────────

  it("buildDispatchPrompt injects the loaded categories' digest before the protocol (M-P2a)", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    const prompt = buildDispatchPrompt(cells[2], plan, [], "PROTOCOL BODY", false, {
      categories: ["authz", "webhooks"],
    });
    expect(prompt).toContain("Threat categories loaded (domain attack surface to check against)");
    // The digest names a category, a pattern, and a CWE.
    expect(prompt).toContain("### Authorization");
    expect(prompt).toContain("idor");
    expect(prompt).toContain("CWE-639");
    expect(prompt).toContain("### Webhooks and Callbacks");
    // The block rides BEFORE the protocol body.
    expect(prompt.indexOf("Threat categories loaded")).toBeLessThan(prompt.indexOf("PROTOCOL BODY"));
  });

  it("buildDispatchPrompt adds no category block when categories are absent or unknown", async () => {
    const { engagement, cells } = await makeStarted();
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    const bare = buildDispatchPrompt(cells[2], plan, [], "PROTOCOL BODY");
    const withEmpty = buildDispatchPrompt(cells[2], plan, [], "PROTOCOL BODY", false, {
      categories: ["", "  ", "not-a-category"],
    });
    // No known category loads — byte-identical to the no-config call.
    expect(withEmpty).toBe(bare);
    expect(bare).not.toContain("Threat categories loaded");
  });

  it("setEngagementConfig updates categories while planning and refuses once running (M-P2a)", async () => {
    const engagement = await makePlanning();
    const updated = await svc.setEngagementConfig(engagement.id, {
      categories: ["authz", "  ", "webhooks"],
    });
    // Blank entries dropped; the column stores a JSON string[].
    expect(JSON.parse(updated.categories ?? "[]")).toEqual(["authz", "webhooks"]);

    const cleared = await svc.setEngagementConfig(engagement.id, { categories: [] });
    expect(cleared.categories).toBeNull();

    await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    await expect(
      svc.setEngagementConfig(engagement.id, { categories: ["authz"] }),
    ).rejects.toThrow(/immutable once the engagement is running/);
  });

  it("dispatchCell carries the engagement's categories into the prompt (M-P2a)", async () => {
    const engagement = await makePlanning();
    await svc.setEngagementConfig(engagement.id, { categories: ["authz"] });
    const { cells } = await svc.startEngagement(engagement.id, { resolvedSha: SHA });
    const { prompt } = await svc.dispatchCell(engagement.id, { cellId: cells[0].id, spawn });
    expect(prompt).toContain("Threat categories loaded");
    expect(prompt).toContain("### Authorization");
    expect(prompt).toContain("CWE-639");
  });

  // ── Re-scan / iterate: carry-forward + diff ────────────────────────────────

  /** A started child engagement whose parent is the given engagement id. */
  async function startedChildOf(parentEngagementId: string) {
    const child = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
      parentEngagementId,
    });
    return svc.startEngagement(child.id, { resolvedSha: SHA });
  }

  it("createEngagement stamps parent_engagement_id on a re-scan", async () => {
    const parent = await makeStarted();
    const child = await svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
      parentEngagementId: parent.engagement.id,
    });
    expect(child.parentEngagementId).toBe(parent.engagement.id);
    // A first review carries no parent.
    const first = await makePlanning();
    expect(first.parentEngagementId).toBeNull();
  });

  it("reportFinding carries a parent's refuted verdict forward as refuted", async () => {
    const parent = await makeStarted();
    const shape = { file: "src/routes/sessions.ts", line: 42, title: "IDOR on sessions" };
    const parentFinding = await svc.reportFinding(parent.engagement.id, {
      cellId: parent.cells[0].id,
      severity: "high",
      ...shape,
      body: EVIDENCE,
    });
    // The parent's review cell refutes it.
    await svc.reviewFinding(parent.engagement.id, {
      findingId: parentFinding.finding.id,
      status: "refuted",
      reason: "middleware enforces ownership before the route runs",
      actor: parent.cells[4].id,
    });

    const child = await startedChildOf(parent.engagement.id);
    // The child reports the SAME fingerprint — carried forward as refuted.
    const carried = await svc.reportFinding(child.engagement.id, {
      cellId: child.cells[0].id,
      severity: "high",
      ...shape,
      body: EVIDENCE,
    });
    expect(carried.finding.status).toBe("refuted");
    expect(carried.finding.statusActor).toBe("carry-forward");
    expect(carried.finding.statusReason).toBe(
      "Carried from the previous review: middleware enforces ownership before the route runs",
    );
    expect(carried.carriedFrom).toEqual({
      parentEngagementId: parent.engagement.id,
      reason: "middleware enforces ownership before the route runs",
    });
  });

  it("reportFinding does NOT carry a parent's open or verified verdict", async () => {
    const parent = await makeStarted();
    const openShape = { file: "src/a.ts", line: 10, title: "open in parent" };
    const verifiedShape = { file: "src/b.ts", line: 20, title: "verified in parent" };
    await svc.reportFinding(parent.engagement.id, {
      cellId: parent.cells[0].id,
      severity: "high",
      ...openShape,
      body: EVIDENCE,
    });
    const verified = await svc.reportFinding(parent.engagement.id, {
      cellId: parent.cells[0].id,
      severity: "high",
      ...verifiedShape,
      body: EVIDENCE,
    });
    await svc.reviewFinding(parent.engagement.id, {
      findingId: verified.finding.id,
      status: "verified",
      reason: "reproduced against the pinned SHA",
      actor: parent.cells[4].id,
    });

    const child = await startedChildOf(parent.engagement.id);
    const carriedOpen = await svc.reportFinding(child.engagement.id, {
      cellId: child.cells[0].id,
      severity: "high",
      ...openShape,
      body: EVIDENCE,
    });
    const carriedVerified = await svc.reportFinding(child.engagement.id, {
      cellId: child.cells[0].id,
      severity: "high",
      ...verifiedShape,
      body: EVIDENCE,
    });
    // A parent open/verified fingerprint resurfaces open for confirmation.
    expect(carriedOpen.finding.status).toBe("open");
    expect(carriedOpen.carriedFrom).toBeNull();
    expect(carriedVerified.finding.status).toBe("open");
    expect(carriedVerified.carriedFrom).toBeNull();
  });

  it("reportFinding opens a first-seen fingerprint in a re-scan", async () => {
    const parent = await makeStarted();
    const child = await startedChildOf(parent.engagement.id);
    const fresh = await svc.reportFinding(child.engagement.id, {
      cellId: child.cells[0].id,
      severity: "medium",
      file: "src/new.ts",
      line: 5,
      title: "new in the re-scan",
      body: EVIDENCE,
    });
    expect(fresh.finding.status).toBe("open");
    expect(fresh.carriedFrom).toBeNull();
  });

  it("diffEngagement is null for a first review", async () => {
    const parent = await makeStarted();
    expect(await svc.diffEngagement(parent.engagement.id)).toBeNull();
  });

  it("diffEngagement counts new/recurring/carried, and fixedCount only once terminal", async () => {
    // Parent findings: A refuted, B open, C verified.
    const parent = await makeStarted();
    const A = { file: "src/a.ts", line: 10, title: "finding A" };
    const B = { file: "src/b.ts", line: 20, title: "finding B" };
    const C = { file: "src/c.ts", line: 30, title: "finding C" };
    const pa = await svc.reportFinding(parent.engagement.id, { cellId: parent.cells[0].id, severity: "high", ...A, body: EVIDENCE });
    await svc.reportFinding(parent.engagement.id, { cellId: parent.cells[0].id, severity: "high", ...B, body: EVIDENCE });
    const pc = await svc.reportFinding(parent.engagement.id, { cellId: parent.cells[0].id, severity: "high", ...C, body: EVIDENCE });
    await svc.reviewFinding(parent.engagement.id, {
      findingId: pa.finding.id,
      status: "refuted",
      reason: "false positive",
      actor: parent.cells[4].id,
    });
    await svc.reviewFinding(parent.engagement.id, {
      findingId: pc.finding.id,
      status: "verified",
      reason: "confirmed",
      actor: parent.cells[4].id,
    });

    // Child reports: A (→ carried refuted), B (recurring, open), D (new).
    // C is absent from the child.
    const child = await startedChildOf(parent.engagement.id);
    const D = { file: "src/d.ts", line: 40, title: "finding D" };
    const carriedA = await svc.reportFinding(child.engagement.id, { cellId: child.cells[0].id, severity: "high", ...A, body: EVIDENCE });
    await svc.reportFinding(child.engagement.id, { cellId: child.cells[0].id, severity: "high", ...B, body: EVIDENCE });
    await svc.reportFinding(child.engagement.id, { cellId: child.cells[0].id, severity: "medium", ...D, body: EVIDENCE });
    expect(carriedA.finding.status).toBe("refuted");

    // While running: recurring = A and B (both in parent), new = D, carried = 1,
    // fixedCount null (the scan has not finished).
    const running = await svc.diffEngagement(child.engagement.id);
    expect(running).not.toBeNull();
    expect(running!.parentEngagementId).toBe(parent.engagement.id);
    expect(running!.parentSessionId).toBe(parent.engagement.sessionId);
    expect(running!.recurringCount).toBe(2);
    expect(running!.newCount).toBe(1);
    expect(running!.carriedRefutedCount).toBe(1);
    expect(running!.fixedCount).toBeNull();

    // Close the child so the diff becomes terminal.
    for (const cell of child.cells) await runCellToCompletion(child.engagement.id, cell);
    await svc.closeEngagement(child.engagement.id);

    const terminal = await svc.diffEngagement(child.engagement.id);
    // fixedCount: parent had C verified and B open; C absent from the child →
    // fixed. B present → not fixed. A was refuted in the parent, so it is not
    // a "live" parent fingerprint and never counts toward fixed. → 1.
    expect(terminal!.fixedCount).toBe(1);
    expect(terminal!.recurringCount).toBe(2);
    expect(terminal!.newCount).toBe(1);
    expect(terminal!.carriedRefutedCount).toBe(1);
  });

  it("parentFingerprints returns the parent's fingerprint set, empty without a parent", async () => {
    const parent = await makeStarted();
    const shape = { file: "src/x.ts", line: 1, title: "X" };
    const pf = await svc.reportFinding(parent.engagement.id, {
      cellId: parent.cells[0].id,
      severity: "low",
      ...shape,
      body: EVIDENCE,
    });
    // No parent → empty set.
    expect((await svc.parentFingerprints(parent.engagement.id)).size).toBe(0);
    const child = await startedChildOf(parent.engagement.id);
    const fps = await svc.parentFingerprints(child.engagement.id);
    expect(fps.has(pf.finding.fingerprint)).toBe(true);
  });

  // ── Re-scan / iterate: diff-scoped sweeps + /prior/ mounts ─────────────────

  const NEW_SHA = "fedcba9876543210fedcba9876543210fedcba98";

  /** A planning child engagement whose parent is the given engagement id. */
  async function planningChildOf(parentEngagementId: string) {
    return svc.createEngagement({
      sessionId: `s_${Math.random().toString(36).slice(2)}`,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
      parentEngagementId,
    });
  }

  it("startEngagement with changedFiles scopes sweep cells only, not recon or verify", async () => {
    const parent = await makeStarted();
    const child = await planningChildOf(parent.engagement.id);
    const started = await svc.startEngagement(child.id, {
      resolvedSha: NEW_SHA,
      baseRef: SHA,
      changedFiles: ["src/routes/sessions.ts", "src/auth/login.ts"],
    });
    // The stored diff context.
    expect(started.engagement.baseRef).toBe(SHA);
    expect(JSON.parse(started.engagement.changedPaths ?? "null")).toEqual([
      "src/routes/sessions.ts",
      "src/auth/login.ts",
    ]);
    // The scoped plan carries the changed-dir globs on the sweeps.
    const plan = parsePlan(started.engagement.plan, KNOWN_PERSONAS);
    const recon = plan.cells.find((c) => c.ordinal === 1);
    const verify = plan.cells.find((c) => c.review === true);
    const sweeps = plan.cells.filter((c) => c.ordinal !== 1 && c.review !== true);
    expect(recon?.paths).toBeUndefined();
    expect(verify?.paths).toBeUndefined();
    expect(sweeps.length).toBeGreaterThan(0);
    for (const sweep of sweeps) {
      expect(sweep.paths).toEqual(["src/auth/**", "src/routes/**"]);
    }
  });

  it("startEngagement with changedFiles=null runs a full scan and stores nulls", async () => {
    const parent = await makeStarted();
    const child = await planningChildOf(parent.engagement.id);
    const started = await svc.startEngagement(child.id, {
      resolvedSha: NEW_SHA,
      baseRef: SHA,
      changedFiles: null,
    });
    expect(started.engagement.changedPaths).toBeNull();
    // No scoping: the plan matches the first-review preset (no injected paths).
    const plan = parsePlan(started.engagement.plan, KNOWN_PERSONAS);
    expect(plan.cells.every((c) => c.paths === undefined)).toBe(true);
  });

  it("a first review ignores changedFiles (no parent) and stays a full scan", async () => {
    const engagement = await makePlanning();
    const started = await svc.startEngagement(engagement.id, {
      resolvedSha: SHA,
      baseRef: "some-base",
      changedFiles: ["src/routes/x.ts"],
    });
    expect(started.engagement.baseRef).toBeNull();
    expect(started.engagement.changedPaths).toBeNull();
    const plan = parsePlan(started.engagement.plan, KNOWN_PERSONAS);
    expect(plan.cells.every((c) => c.paths === undefined)).toBe(true);
  });

  /** Seed the parent with a recon state doc and two findings for the mounts. */
  async function seedParentReasoning() {
    const parent = await makeStarted();
    // Recon (cell 1) writes its map.
    await svc.dispatchCell(parent.engagement.id, { cellId: parent.cells[0].id, spawn });
    await svc.writeFile(parent.engagement.id, {
      actorCellId: parent.cells[0].id,
      path: `/cells/${parent.cells[0].dir}/state.yml`,
      content: [
        "protocol_version: 1",
        "status: done",
        "checklist:",
        "  pending: 0",
        "  done: 5",
        "queue:",
        "  pending: 0",
        "  done: 3",
        "# recon: 12 routes mapped, auth boundary at middleware/auth.ts",
      ].join("\n"),
    });
    await svc.completeCell(parent.engagement.id, parent.cells[0].id, { settled: true });
    // A verified finding and a refuted finding.
    const verified = await svc.reportFinding(parent.engagement.id, {
      cellId: parent.cells[1].id,
      severity: "high",
      file: "src/routes/sessions.ts",
      line: 42,
      title: "IDOR on sessions",
      body: EVIDENCE,
    });
    await svc.reviewFinding(parent.engagement.id, {
      findingId: verified.finding.id,
      status: "verified",
      reason: "reproduced against the pinned SHA",
      actor: parent.cells[4].id,
    });
    const refuted = await svc.reportFinding(parent.engagement.id, {
      cellId: parent.cells[1].id,
      severity: "low",
      file: "src/util/log.ts",
      line: 7,
      title: "log injection",
      body: EVIDENCE,
    });
    await svc.reviewFinding(parent.engagement.id, {
      findingId: refuted.finding.id,
      status: "refuted",
      reason: "the sink escapes newlines",
      actor: parent.cells[4].id,
    });
    return parent;
  }

  it("/prior/diff.md names the SHA range and changed files", async () => {
    const parent = await makeStarted();
    const child = await planningChildOf(parent.engagement.id);
    const started = await svc.startEngagement(child.id, {
      resolvedSha: NEW_SHA,
      baseRef: SHA,
      changedFiles: ["src/routes/sessions.ts"],
    });
    const diff = await svc.readFile(started.engagement.id, "/prior/diff.md");
    expect(diff.content).toContain(SHA);
    expect(diff.content).toContain(NEW_SHA);
    expect(diff.content).toContain("src/routes/sessions.ts");
    expect(diff.content).toContain("1 changed file");
  });

  it("/prior/diff.md notes a full re-scan when no diff was captured", async () => {
    const parent = await makeStarted();
    const child = await planningChildOf(parent.engagement.id);
    const started = await svc.startEngagement(child.id, { resolvedSha: NEW_SHA, changedFiles: null });
    const diff = await svc.readFile(started.engagement.id, "/prior/diff.md");
    expect(diff.content).toContain("Full re-scan: prior commit unavailable, scanning everything.");
  });

  it("/prior/recon.md returns the parent's recon state doc", async () => {
    const parent = await seedParentReasoning();
    const child = await startedChildOf(parent.engagement.id);
    const recon = await svc.readFile(child.engagement.id, "/prior/recon.md");
    expect(recon.content).toContain("12 routes mapped");
    expect(recon.content).toContain("01-recon");
  });

  it("/prior/recon.md notes no prior map when the parent's recon wrote none", async () => {
    const parent = await makeStarted(); // recon never ran
    const child = await startedChildOf(parent.engagement.id);
    const recon = await svc.readFile(child.engagement.id, "/prior/recon.md");
    expect(recon.content).toContain("No prior recon map");
  });

  it("/prior/findings.md digests the parent findings grouped by status", async () => {
    const parent = await seedParentReasoning();
    const child = await startedChildOf(parent.engagement.id);
    const findings = await svc.readFile(child.engagement.id, "/prior/findings.md");
    expect(findings.content).toContain("Verified");
    expect(findings.content).toContain("IDOR on sessions");
    expect(findings.content).toContain("src/routes/sessions.ts:42");
    expect(findings.content).toContain("Refuted");
    expect(findings.content).toContain("log injection");
  });

  it("/prior/* errors on a non-re-scan engagement", async () => {
    const { engagement } = await makeStarted(); // no parent
    await expect(svc.readFile(engagement.id, "/prior/diff.md")).rejects.toThrow(
      "This is not a re-scan; there is no prior engagement.",
    );
    await expect(svc.readFile(engagement.id, "/prior/recon.md")).rejects.toThrow(
      "This is not a re-scan",
    );
    await expect(svc.readFile(engagement.id, "/prior/findings.md")).rejects.toThrow(
      "This is not a re-scan",
    );
  });

  it("listFiles includes /prior/* mounts only on a re-scan", async () => {
    const parent = await makeStarted();
    const first = await svc.listFiles(parent.engagement.id);
    expect(first.some((f) => f.path.startsWith("/prior/"))).toBe(false);

    const child = await startedChildOf(parent.engagement.id);
    const rescan = await svc.listFiles(child.engagement.id);
    const priorPaths = rescan.filter((f) => f.path.startsWith("/prior/")).map((f) => f.path);
    expect(priorPaths.sort()).toEqual(["/prior/diff.md", "/prior/findings.md", "/prior/recon.md"]);
  });
});

// ── Engagement cost (spec §engagement cost) ──────────────────────────────────

describe("getEngagementCost", () => {
  const NOW = 1_700_000_000_000;
  let db: AppDb;
  let pgdb: PgDb;
  let svc: SecurityEngagementService;

  beforeEach(async () => {
    ({ appDb: db, pgdb } = await freshTestPgDb());
    svc = createSecurityEngagementService({ db });
    await pgdb.query("INSERT INTO orgs (id, name, created_at) VALUES ('org-a', 'Org A', $1)", [NOW]);
  });

  /** Seed an agent_sessions row so cost_entries resolves the session to org-a. */
  async function seedSession(id: string): Promise<void> {
    await pgdb.query(
      `INSERT INTO agent_sessions
         (id, user_id, org_id, workspace, status, owner_type, owner_id, created_at, updated_at)
       VALUES ($2, 'u-alice', 'org-a', '/tmp/w', 'active', 'user', 'u-alice', $1, $1)`,
      [NOW, id],
    );
  }

  /** Seed one priced (or unpriced) assistant turn for a session. */
  async function seedTurn(
    entryId: string,
    sessionId: string,
    opts: { total: number; cost: number | null },
  ): Promise<void> {
    const usage = JSON.stringify({ input: opts.total, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.total });
    const cost = opts.cost === null ? null : JSON.stringify({ total: opts.cost });
    await pgdb.query(
      `INSERT INTO engine_entries
         (id, session_id, thread_id, entry_type, role, model, usage, cost, created_at)
       VALUES ($1, $2, 'th', 'message', 'assistant', 'claude', $3, $4, $5)`,
      [entryId, sessionId, usage, cost, NOW],
    );
  }

  /** A started engagement whose runner session id is known and seeded. */
  async function startedWithRunner(runnerSessionId: string) {
    await seedSession(runnerSessionId);
    const engagement = await svc.createEngagement({
      sessionId: runnerSessionId,
      repoFullName: "acme/api",
      plan: codeReviewPresetPlan(),
    });
    return svc.startEngagement(engagement.id, { resolvedSha: SHA });
  }

  it("sums the runner session and a cell child, excluding handoffs and unrelated sessions", async () => {
    const runnerId = "s-runner";
    const { engagement, cells } = await startedWithRunner(runnerId);
    // Dispatch cell 1 with a controlled child session id.
    const childId = "child-cell-1";
    await svc.dispatchCell(engagement.id, {
      cellId: cells[0].id,
      spawn: async () => ({ childSessionId: childId }),
    });

    await seedSession(childId);
    await seedTurn("e-runner", runnerId, { total: 1000, cost: 0.10 });
    await seedTurn("e-cell", childId, { total: 500, cost: 0.05 });

    // A handoff (fix session) child — its cost must NOT count.
    const handoffChild = "child-handoff";
    await seedSession(handoffChild);
    await seedTurn("e-handoff", handoffChild, { total: 9999, cost: 9.99 });
    await svc.recordHandoff({
      engagementId: engagement.id,
      findingId: "fnd-x",
      childSessionId: handoffChild,
      title: "Fix",
      createdBy: "u-alice",
    });

    // An unrelated session — never referenced by this engagement.
    const otherId = "s-other";
    await seedSession(otherId);
    await seedTurn("e-other", otherId, { total: 7777, cost: 7.77 });

    const cost = await svc.getEngagementCost(engagement.id);
    expect(cost.totalTokens).toBe(1500);
    expect(cost.costUsd).toBeCloseTo(0.15, 6);
    expect(cost.priced).toBe(true);
  });

  it("reports priced=false when a counted turn is unpriced", async () => {
    const runnerId = "s-runner-unpriced";
    const { engagement } = await startedWithRunner(runnerId);
    await seedTurn("e-runner-priced", runnerId, { total: 1000, cost: 0.10 });
    await seedTurn("e-runner-unpriced", runnerId, { total: 200, cost: null });

    const cost = await svc.getEngagementCost(engagement.id);
    expect(cost.totalTokens).toBe(1200);
    expect(cost.priced).toBe(false);
  });

  it("returns zeros when no session has spent anything yet", async () => {
    const runnerId = "s-runner-idle";
    const { engagement } = await startedWithRunner(runnerId);
    // Runner + cells exist but no engine_entries → cost_entries has no rows.
    const cost = await svc.getEngagementCost(engagement.id);
    expect(cost).toEqual({ costUsd: 0, totalTokens: 0, priced: true });
  });
});
