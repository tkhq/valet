/**
 * Valet Security engagement service — the ONE owner of every engagement and
 * cell transition (docs/specs/2026-08-27-valet-security-design.md, §Tools,
 * §The Loop). The runner agent narrates; these functions decide. Nothing
 * outside this file mutates security_* rows.
 *
 * Substrate rules held here:
 *   - The plan is immutable once the engagement runs (setPlan).
 *   - Cells run serially: dispatchCell refuses while another cell runs.
 *   - The engagement tree is append-only revisions; the path prefix IS the
 *     write claim (writeFile).
 *   - Findings are insert-only with forward-only status (reviewFinding).
 *   - Exit conditions are ruled server-side from the persona's own state
 *     doc (completeCell) — a polite-but-wrong runner cannot mark work done.
 *
 * Spawning is a per-call seam (`SpawnCellChild`): the M3 tool layer passes
 * the host ChildSpawner-backed function; tests pass a fake. The service
 * never spawns on its own.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, ilike, or, sql } from "drizzle-orm";
import {
  cellDir,
  findingFingerprint,
  isKnownPlaybook,
  KNOWN_PERSONAS,
  parsePlan,
  parseStateDoc,
  playbookMarkdown,
  protocolMarkdown,
  ruleExit,
  type EngagementPlan,
  type StateDoc,
} from "@valet/plugin-security";
import type { AppDb } from "../lib/drizzle.js";
import {
  securityCells,
  securityEngagements,
  securityFiles,
  securityFindingLinks,
  securityFindings,
  type SecurityCellRow,
  type SecurityEngagementRow,
  type SecurityFindingRow,
} from "../schema/index.js";
import {
  recordSecurityCellsCreated,
  recordSecurityCellSettled,
} from "../observability/security-metrics.js";

// ── Limits (spec §Data Model size guard, §Tools) ──────────────────────────

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_REVISIONS_PER_PATH = 512;
export const MIN_FINDING_BODY_CHARS = 200;
export const MAX_FINDINGS_PER_CELL = 100;

/**
 * The checkpoint stride (spec §Context Discipline): a cell-claimed thread
 * that compacts while its latest state doc is older than this is losing
 * work the tree never saw. The compaction hook emits the staleness metric
 * past this age; nothing auto-repairs.
 */
export const STATE_DOC_STALE_MS = 10 * 60_000;

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "open" | "verified" | "refuted";

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

/** Spawn seam: the M3 tool layer backs this with the host ChildSpawner. */
export type SpawnCellChild = (req: {
  title: string;
  message: string;
  repo: string;
  ref: string;
  /**
   * The child session id `dispatchCell` pre-minted and stamped on the cell
   * BEFORE this spawn runs, so the host's session build sees the claim and
   * attaches the persona toolset + role (M4). The real seam passes it to
   * the ChildSpawner as `sessionId`; a fake may ignore it and return its
   * own id — `dispatchCell` re-stamps whatever the spawn returns.
   */
  childSessionId: string;
  /** The persona role name for the dispatch prompt's turn. */
  role: string;
}) => Promise<{ childSessionId: string }>;

export interface EngagementWithCells {
  engagement: SecurityEngagementRow;
  cells: SecurityCellRow[];
}

export type CompleteCellResult =
  | { outcome: "completed"; cell: SecurityCellRow }
  | { outcome: "yielded"; cell: SecurityCellRow }
  | { outcome: "violation"; violation: string };

export interface ManifestCell {
  ordinal: number;
  dir: string;
  persona: string;
  status: string;
  attempts: number;
  stateDocRevisions: number;
  findings: number;
}

export interface EngagementManifest {
  engagementId: string;
  status: "completed" | "failed";
  repoFullName: string;
  repoRef: string;
  cells: ManifestCell[];
  findings: {
    /** All finding rows, near-duplicates included. */
    total: number;
    /** One count per distinct fingerprint, keyed by the group's highest
     * severity — near-duplicate reports do not inflate the headline. */
    distinctBySeverity: Record<FindingSeverity, number>;
    /** Per finding row (each row's status is an audit fact of its own). */
    statusBreakdown: { open: number; verified: number; refuted: number };
    filedLinks: number;
  };
}

export interface TreeEntry {
  path: string;
  /** Latest revision number; virtual mounts report 1. */
  revisions: number;
  /** Byte size of the latest revision. */
  size: number;
}

export interface TreeFile {
  path: string;
  /** Revision served; null for the virtual mounts (/protocol.md, /plan.yml). */
  revision: number | null;
  content: string;
}

export interface CellCompactionStamp {
  cell: SecurityCellRow;
  /** Age of the freshest durable checkpoint at compaction time: the latest
   * state doc revision, or the dispatch when no doc exists yet. */
  stateDocAgeMs: number;
  /** True when `stateDocAgeMs` exceeds `STATE_DOC_STALE_MS`. */
  stale: boolean;
}

export interface CellProgress {
  status: StateDoc["status"];
  checklist: { pending: number; done: number };
  queue: { pending: number; done: number };
}

export interface ListFindingsOptions {
  cellId?: string;
  severity?: FindingSeverity;
  status?: FindingStatus;
  /** Substring match against the finding's file path. */
  path?: string;
  cursor?: string;
  limit?: number;
}

// ── Dispatch prompt (pure, exported for unit tests) ───────────────────────

/**
 * The selective dispatch prompt (spec §Context Discipline, Decision 8): the
 * persona, the goal, mode, path scope, the cell's own directory, ONLY the
 * `reads`-declared cells' state doc paths, and the protocol verbatim. The
 * rest of the tree stays discoverable through sec_fs_list; the prompt does
 * not spend context on it.
 */
export function buildDispatchPrompt(
  cell: SecurityCellRow,
  plan: EngagementPlan,
  readsCells: SecurityCellRow[],
  protocol: string,
): string {
  const planCell = plan.cells.find((p) => p.ordinal === cell.ordinal);
  const lines: string[] = [
    `You are the "${cell.persona}" persona for security cell ${cell.dir} (ordinal ${cell.ordinal}).`,
    "",
    `Goal: ${cell.goal}`,
    `Mode: ${cell.mode}`,
  ];
  if (cell.mode === "resume") {
    lines.push(
      `Resume: read your own latest state doc at /cells/${cell.dir}/state.yml with sec_fs_read before any other work, and continue from its queue.`,
    );
  }
  if (planCell?.paths && planCell.paths.length > 0) {
    lines.push(`Scope: limit the sweep to these path globs: ${planCell.paths.join(", ")}`);
  }
  if (planCell?.playbook) {
    lines.push(
      "",
      `Methodology: read /playbooks/${planCell.playbook}.md with sec_fs_read before you start. ` +
        "It is your framework-grounded checklist for this cell (OWASP, ASVS, WSTG, CWE). Work from it.",
    );
  }
  lines.push(
    "",
    `Your cell directory in the engagement tree is /cells/${cell.dir}/.`,
    `Write your state doc to /cells/${cell.dir}/state.yml with sec_fs_write.`,
  );
  if (readsCells.length > 0) {
    lines.push("", "Read these predecessor state docs with sec_fs_read before you start:");
    for (const r of readsCells) {
      lines.push(`- /cells/${r.dir}/state.yml`);
    }
  }
  lines.push(
    "",
    "The protocol below is the contract you operate under. It is also mounted read-only at /protocol.md.",
    "",
    "---",
    "",
    protocol,
  );
  return lines.join("\n");
}

/** The distinct playbook names a plan's cells reference, in listing order.
 * Tolerant of an unparseable plan (returns none) — listing must not throw. */
function playbooksInPlan(planYaml: string): string[] {
  let plan: EngagementPlan;
  try {
    plan = parsePlan(planYaml, KNOWN_PERSONAS);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const cell of plan.cells) {
    if (cell.playbook && isKnownPlaybook(cell.playbook) && !names.includes(cell.playbook)) {
      names.push(cell.playbook);
    }
  }
  return names;
}

// ── Service ────────────────────────────────────────────────────────────────

export interface SecurityEngagementServiceDeps {
  db: AppDb;
  now?: () => number;
}

export function createSecurityEngagementService(deps: SecurityEngagementServiceDeps) {
  const { db } = deps;
  const now = deps.now ?? Date.now;

  async function loadEngagement(engagementId: string): Promise<SecurityEngagementRow> {
    const rows = await db
      .select()
      .from(securityEngagements)
      .where(eq(securityEngagements.id, engagementId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error(`No engagement ${engagementId}. Check the id with sec_status.`);
    }
    return row;
  }

  async function loadCells(engagementId: string): Promise<SecurityCellRow[]> {
    return db
      .select()
      .from(securityCells)
      .where(eq(securityCells.engagementId, engagementId))
      .orderBy(asc(securityCells.ordinal));
  }

  async function loadCell(engagementId: string, cellId: string): Promise<SecurityCellRow> {
    const rows = await db
      .select()
      .from(securityCells)
      .where(and(eq(securityCells.engagementId, engagementId), eq(securityCells.id, cellId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error(`No cell ${cellId} in this engagement. Check the id with sec_status.`);
    }
    return row;
  }

  async function latestStateDocRow(engagementId: string, dir: string) {
    const rows = await db
      .select()
      .from(securityFiles)
      .where(
        and(
          eq(securityFiles.engagementId, engagementId),
          eq(securityFiles.path, `/cells/${dir}/state.yml`),
        ),
      )
      .orderBy(desc(securityFiles.revision))
      .limit(1);
    return rows[0];
  }

  /**
   * Seed the engagement row for a new kind='security' session. `dbh` lets
   * the session-create route pass its open transaction so the session row
   * and the engagement land atomically.
   */
  async function createEngagement(
    args: { sessionId: string; repoFullName: string; plan: string },
    dbh: AppDb = db,
  ): Promise<SecurityEngagementRow> {
    // Fail fast on a malformed plan — a planning-status engagement whose
    // plan cannot parse would strand the runner at sec_start.
    parsePlan(args.plan, KNOWN_PERSONAS);
    const ts = now();
    const inserted = await dbh
      .insert(securityEngagements)
      .values({
        id: `eng_${randomUUID()}`,
        sessionId: args.sessionId,
        status: "planning",
        repoFullName: args.repoFullName,
        plan: args.plan,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning();
    return inserted[0];
  }

  async function getEngagement(engagementId: string): Promise<EngagementWithCells | null> {
    const rows = await db
      .select()
      .from(securityEngagements)
      .where(eq(securityEngagements.id, engagementId))
      .limit(1);
    const engagement = rows[0];
    if (!engagement) return null;
    return { engagement, cells: await loadCells(engagement.id) };
  }

  async function getEngagementBySession(sessionId: string): Promise<EngagementWithCells | null> {
    const rows = await db
      .select()
      .from(securityEngagements)
      .where(eq(securityEngagements.sessionId, sessionId))
      .limit(1);
    const engagement = rows[0];
    if (!engagement) return null;
    return { engagement, cells: await loadCells(engagement.id) };
  }

  /** Replace the plan while the engagement is still planning. */
  async function setPlan(engagementId: string, planYaml: string): Promise<SecurityEngagementRow> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status !== "planning") {
      throw new Error("The plan is immutable once the engagement is running.");
    }
    parsePlan(planYaml, KNOWN_PERSONAS);
    const updated = await db
      .update(securityEngagements)
      .set({ plan: planYaml, updatedAt: now() })
      .where(eq(securityEngagements.id, engagementId))
      .returning();
    return updated[0];
  }

  /**
   * Materialize cells from the plan and pin the repo ref. SHA resolution
   * happens in the caller (the sec_start tool); this function only refuses
   * an empty pin.
   */
  async function startEngagement(
    engagementId: string,
    args: { resolvedSha: string },
  ): Promise<EngagementWithCells> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status !== "planning") {
      throw new Error(
        `The engagement is already ${engagement.status}. Only a planning engagement can start.`,
      );
    }
    if (!args.resolvedSha || args.resolvedSha.trim() === "") {
      throw new Error("Pin the repository to a commit SHA before starting.");
    }
    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    const ts = now();
    const cellValues = plan.cells.map((planCell) => ({
      id: `cell_${randomUUID()}`,
      engagementId,
      ordinal: planCell.ordinal,
      persona: planCell.persona,
      mode: planCell.mode,
      goal: planCell.goal,
      dir: cellDir(planCell),
      reads: JSON.stringify(planCell.reads),
      review: planCell.review === true,
      status: "pending" as const,
      attempts: 0,
      createdAt: ts,
    }));
    await db.transaction(async (tx) => {
      await tx.insert(securityCells).values(cellValues);
      await tx
        .update(securityEngagements)
        .set({ status: "running", repoRef: args.resolvedSha, updatedAt: ts })
        .where(eq(securityEngagements.id, engagementId));
    });
    recordSecurityCellsCreated(cellValues.length);
    const result = await getEngagement(engagementId);
    // The transaction above just wrote these rows; absence is impossible.
    if (!result) throw new Error(`No engagement ${engagementId}. Check the id with sec_status.`);
    return result;
  }

  /**
   * Dispatch one cell: claim it (status running, attempts + 1), spawn the
   * persona child through the injected seam, stamp the child on the row.
   * Serial v1: refuses while any OTHER cell is running.
   */
  async function dispatchCell(
    engagementId: string,
    args: { cellId?: string; mode?: "fresh" | "resume"; spawn: SpawnCellChild },
  ): Promise<{ cell: SecurityCellRow; prompt: string }> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status !== "running") {
      throw new Error(
        engagement.status === "planning"
          ? "Start the engagement with sec_start before dispatching cells."
          : `The engagement is ${engagement.status}. A closed engagement dispatches nothing.`,
      );
    }
    const cells = await loadCells(engagementId);

    let target: SecurityCellRow | undefined;
    if (args.cellId !== undefined) {
      target = cells.find((c) => c.id === args.cellId);
      if (!target) {
        throw new Error(`No cell ${args.cellId} in this engagement. Check the id with sec_status.`);
      }
      if (target.status === "completed") {
        throw new Error(
          `Cell ${ordinalLabel(target)} is completed. Completed cells never re-run; dispatch a pending cell instead.`,
        );
      }
    } else {
      target = cells.find((c) => c.status === "pending");
      if (!target) {
        throw new Error(
          "No pending cell to dispatch. Call sec_status, then name a yielded or failed cell to re-dispatch.",
        );
      }
    }

    const runningOther = cells.find((c) => c.status === "running" && c.id !== target.id);
    if (runningOther) {
      throw new Error(
        `Cell ${ordinalLabel(runningOther)} is still running. Complete or fail it before dispatching another.`,
      );
    }

    const effectiveMode = args.mode ?? target.mode;
    const prior = {
      status: target.status,
      attempts: target.attempts,
      mode: target.mode,
      childSessionId: target.childSessionId,
      dispatchedAt: target.dispatchedAt,
    };

    // Pre-mint the child session id (the same `child_` shape children.ts
    // mints — this IS the session id the spawn builds) and stamp it in the
    // claim, BEFORE the spawn: the host's child-session build resolves the
    // cell claim by `child_session_id` to attach the persona toolset + role,
    // so the claim must exist when the build runs (M4).
    const plannedChildSessionId = `child_${randomUUID()}`;

    // Claim first (one atomic UPDATE): a second dispatch racing in sees the
    // running status and refuses. The spawn happens outside a transaction —
    // the real spawner writes its own rows through the same connection.
    const claimed = await db
      .update(securityCells)
      .set({
        status: "running",
        attempts: target.attempts + 1,
        mode: effectiveMode,
        childSessionId: plannedChildSessionId,
        dispatchedAt: now(),
      })
      .where(eq(securityCells.id, target.id))
      .returning();
    const cell = claimed[0];

    const plan = parsePlan(engagement.plan, KNOWN_PERSONAS);
    const readOrdinals = parseReads(cell.reads);
    const readsCells = cells.filter((c) => readOrdinals.includes(c.ordinal));
    const prompt = buildDispatchPrompt(cell, plan, readsCells, protocolMarkdown());

    let childSessionId: string;
    try {
      const spawned = await args.spawn({
        title: `Security cell ${cell.dir}`,
        message: prompt,
        repo: engagement.repoFullName,
        ref: engagement.repoRef,
        childSessionId: plannedChildSessionId,
        role: cell.persona,
      });
      childSessionId = spawned.childSessionId;
    } catch (err) {
      // Undo THIS call's own claim, not a repair of somebody else's state:
      // no child exists, so no dispatch happened and attempts must not
      // count one. The error propagates to the caller unchanged.
      await db
        .update(securityCells)
        .set({
          status: prior.status,
          attempts: prior.attempts,
          mode: prior.mode,
          childSessionId: prior.childSessionId,
          dispatchedAt: prior.dispatchedAt,
        })
        .where(eq(securityCells.id, cell.id));
      throw err;
    }

    const stamped = await db
      .update(securityCells)
      .set({ childSessionId, dispatchedAt: now() })
      .where(eq(securityCells.id, cell.id))
      .returning();
    return { cell: stamped[0], prompt };
  }

  /**
   * Rule on a running cell's exit. The caller (the M3 tool layer) checks
   * the child watch and passes `settled`; the service trusts a true flag
   * but refuses false.
   */
  async function completeCell(
    engagementId: string,
    cellId: string,
    args: { settled: boolean },
  ): Promise<CompleteCellResult> {
    const cell = await loadCell(engagementId, cellId);
    if (cell.status !== "running") {
      throw new Error(
        `Cell ${ordinalLabel(cell)} is ${cell.status}, not running. Only a running cell can complete.`,
      );
    }
    if (!args.settled) {
      throw new Error("The cell's child has not settled. Wait for it to finish.");
    }
    const docRow = await latestStateDocRow(engagementId, cell.dir);
    if (!docRow) {
      return {
        outcome: "violation",
        violation: `No state doc found at /cells/${cell.dir}/state.yml. The persona must write one before completing.`,
      };
    }
    let doc: StateDoc;
    try {
      doc = parseStateDoc(docRow.content);
    } catch (err) {
      // Writes validate state.yml, so a parse failure here means the row
      // predates a protocol change — surface it as a violation to loop on.
      return { outcome: "violation", violation: err instanceof Error ? err.message : String(err) };
    }
    const ruling = ruleExit(doc);
    if (ruling.outcome === "violation") {
      return { outcome: "violation", violation: ruling.violation };
    }
    const status = ruling.outcome === "done" ? ("completed" as const) : ("yielded" as const);
    const updated = await db
      .update(securityCells)
      .set({ status, settledAt: now() })
      .where(eq(securityCells.id, cell.id))
      .returning();
    if (status === "completed") recordSecurityCellSettled("completed");
    return status === "completed"
      ? { outcome: "completed", cell: updated[0] }
      : { outcome: "yielded", cell: updated[0] };
  }

  /** Explicit, agent-invoked failure. Nothing sweeps cells to failed. */
  async function failCell(
    engagementId: string,
    cellId: string,
    reason: string,
  ): Promise<{ cell: SecurityCellRow; reason: string }> {
    const cell = await loadCell(engagementId, cellId);
    if (cell.status !== "running") {
      throw new Error(
        `Cell ${ordinalLabel(cell)} is ${cell.status}, not running. Only a running cell can fail.`,
      );
    }
    if (!reason || reason.trim() === "") {
      throw new Error("Give a reason for the failure so the manifest and re-dispatch carry it.");
    }
    const updated = await db
      .update(securityCells)
      .set({ status: "failed", settledAt: now() })
      .where(eq(securityCells.id, cell.id))
      .returning();
    recordSecurityCellSettled("failed");
    return { cell: updated[0], reason };
  }

  /** Close the engagement and compute the manifest. */
  async function closeEngagement(engagementId: string): Promise<EngagementManifest> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status === "completed" || engagement.status === "failed") {
      throw new Error(`The engagement is already ${engagement.status}. Read the manifest from the thread.`);
    }
    if (engagement.status === "planning") {
      throw new Error("The engagement never started. Call sec_start, run the cells, then close.");
    }
    const cells = await loadCells(engagementId);
    const blocker = cells.find(
      (c) => c.status === "pending" || c.status === "running" || c.status === "yielded",
    );
    if (blocker) {
      throw new Error(
        `Cell ${ordinalLabel(blocker)} is ${blocker.status}. Complete or fail every cell before closing.`,
      );
    }

    const findings = await db
      .select()
      .from(securityFindings)
      .where(eq(securityFindings.engagementId, engagementId));
    const [{ n: filedLinks }] = await db
      .select({ n: count() })
      .from(securityFindingLinks)
      .where(eq(securityFindingLinks.engagementId, engagementId));

    const manifestCells: ManifestCell[] = [];
    for (const cell of cells) {
      const [{ n: revisions }] = await db
        .select({ n: count() })
        .from(securityFiles)
        .where(
          and(
            eq(securityFiles.engagementId, engagementId),
            eq(securityFiles.path, `/cells/${cell.dir}/state.yml`),
          ),
        );
      manifestCells.push({
        ordinal: cell.ordinal,
        dir: cell.dir,
        persona: cell.persona,
        status: cell.status,
        attempts: cell.attempts,
        stateDocRevisions: Number(revisions ?? 0),
        findings: findings.filter((f) => f.cellId === cell.id).length,
      });
    }

    // Distinct fingerprints: one count per group, keyed by the group's
    // highest severity, so five near-duplicate reports read as one.
    const bySeverity: Record<FindingSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    const groups = new Map<string, FindingSeverity>();
    for (const f of findings) {
      const sev = narrowSeverity(f.severity);
      const current = groups.get(f.fingerprint);
      if (current === undefined || SEVERITIES.indexOf(sev) < SEVERITIES.indexOf(current)) {
        groups.set(f.fingerprint, sev);
      }
    }
    for (const sev of groups.values()) bySeverity[sev] += 1;

    const statusBreakdown = { open: 0, verified: 0, refuted: 0 };
    for (const f of findings) {
      if (f.status === "open" || f.status === "verified" || f.status === "refuted") {
        statusBreakdown[f.status] += 1;
      }
    }

    const allCompleted = cells.every((c) => c.status === "completed");
    const finalStatus = allCompleted ? ("completed" as const) : ("failed" as const);
    await db
      .update(securityEngagements)
      .set({ status: finalStatus, updatedAt: now() })
      .where(eq(securityEngagements.id, engagementId));

    return {
      engagementId,
      status: finalStatus,
      repoFullName: engagement.repoFullName,
      repoRef: engagement.repoRef,
      cells: manifestCells,
      findings: {
        total: findings.length,
        distinctBySeverity: bySeverity,
        statusBreakdown,
        filedLinks: Number(filedLinks ?? 0),
      },
    };
  }

  /**
   * Append a revision to the engagement tree. The path prefix IS the write
   * claim: a cell writes only under /cells/<its dir>/.
   */
  async function writeFile(
    engagementId: string,
    args: { actorCellId: string; path: string; content: string },
  ): Promise<{ path: string; revision: number }> {
    await loadEngagement(engagementId);
    const cell = await loadCell(engagementId, args.actorCellId);
    const prefix = `/cells/${cell.dir}/`;
    if (!args.path.startsWith(prefix)) {
      throw new Error(`Write refused: ${args.path} is outside your cell directory ${prefix}.`);
    }
    const size = Buffer.byteLength(args.content, "utf8");
    if (size > MAX_FILE_BYTES) {
      throw new Error(
        `Write refused: the content is ${size} bytes; the limit is ${MAX_FILE_BYTES} (256 KB). The tree holds working state — split or trim the content.`,
      );
    }
    if (basename(args.path) === "state.yml") {
      // Throws the protocol's own corrective message on a bad doc.
      parseStateDoc(args.content);
    }

    const insertNext = async (): Promise<{ path: string; revision: number }> => {
      const latest = await db
        .select({ revision: securityFiles.revision })
        .from(securityFiles)
        .where(and(eq(securityFiles.engagementId, engagementId), eq(securityFiles.path, args.path)))
        .orderBy(desc(securityFiles.revision))
        .limit(1);
      const nextRevision = (latest[0]?.revision ?? 0) + 1;
      if (nextRevision > MAX_REVISIONS_PER_PATH) {
        throw new Error(
          `Write refused: ${args.path} already has ${MAX_REVISIONS_PER_PATH} revisions, the maximum. Consolidate writes — the tree holds working state, not a log.`,
        );
      }
      await db.insert(securityFiles).values({
        id: `file_${randomUUID()}`,
        engagementId,
        cellId: cell.id,
        path: args.path,
        revision: nextRevision,
        content: args.content,
        createdAt: now(),
      });
      return { path: args.path, revision: nextRevision };
    };

    try {
      return await insertNext();
    } catch (err) {
      // Two concurrent writers can compute the same next revision; the
      // unique index (engagement_id, path, revision) rejects the loser.
      // Retry once with a fresh read — a second loss propagates.
      if (isUniqueViolation(err)) return insertNext();
      throw err;
    }
  }

  /** Read a tree path: the virtual mounts first, then stored revisions. */
  async function readFile(
    engagementId: string,
    path: string,
    revision?: number,
  ): Promise<TreeFile> {
    const engagement = await loadEngagement(engagementId);
    if (path === "/protocol.md") return { path, revision: null, content: protocolMarkdown() };
    if (path === "/plan.yml") return { path, revision: null, content: engagement.plan };
    if (path.startsWith("/playbooks/") && path.endsWith(".md")) {
      const name = path.slice("/playbooks/".length, -".md".length);
      if (isKnownPlaybook(name)) return { path, revision: null, content: playbookMarkdown(name) };
      throw new Error(`No playbook at ${path}. Use sec_fs_list to see the tree.`);
    }
    const conditions = [eq(securityFiles.engagementId, engagementId), eq(securityFiles.path, path)];
    if (revision !== undefined) conditions.push(eq(securityFiles.revision, revision));
    const rows = await db
      .select()
      .from(securityFiles)
      .where(and(...conditions))
      .orderBy(desc(securityFiles.revision))
      .limit(1);
    const row = rows[0];
    if (!row) {
      if (revision !== undefined) {
        throw new Error(`No revision ${revision} at ${path}. Use sec_fs_list to see the tree.`);
      }
      throw new Error(`No file at ${path}. Use sec_fs_list to see the tree.`);
    }
    return { path: row.path, revision: row.revision, content: row.content };
  }

  /** List tree paths (latest revision + size), virtual mounts included. */
  async function listFiles(engagementId: string, prefix?: string): Promise<TreeEntry[]> {
    const engagement = await loadEngagement(engagementId);
    const rows = await db
      .select({
        path: securityFiles.path,
        revision: securityFiles.revision,
        size: sql<number>`length(${securityFiles.content})`,
      })
      .from(securityFiles)
      .where(
        prefix !== undefined
          ? and(
              eq(securityFiles.engagementId, engagementId),
              sql`${securityFiles.path} LIKE ${`${prefix}%`}`,
            )
          : eq(securityFiles.engagementId, engagementId),
      );
    const byPath = new Map<string, TreeEntry>();
    for (const row of rows) {
      const existing = byPath.get(row.path);
      if (!existing || row.revision > existing.revisions) {
        byPath.set(row.path, { path: row.path, revisions: row.revision, size: Number(row.size) });
      }
    }
    const mounts: TreeEntry[] = [
      { path: "/plan.yml", revisions: 1, size: Buffer.byteLength(engagement.plan, "utf8") },
      { path: "/protocol.md", revisions: 1, size: Buffer.byteLength(protocolMarkdown(), "utf8") },
    ];
    // Only the playbooks this plan references appear in the tree, so the
    // listing reflects the engagement rather than every bundled playbook.
    for (const name of playbooksInPlan(engagement.plan)) {
      mounts.push({
        path: `/playbooks/${name}.md`,
        revisions: 1,
        size: Buffer.byteLength(playbookMarkdown(name), "utf8"),
      });
    }
    for (const mount of mounts) {
      if (prefix === undefined || mount.path.startsWith(prefix)) byPath.set(mount.path, mount);
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Insert a finding; the server computes the fingerprint and returns any
   * siblings sharing it (advisory dedup — the persona decides). */
  async function reportFinding(
    engagementId: string,
    args: {
      cellId: string;
      severity: FindingSeverity;
      title: string;
      file?: string;
      line?: number;
      body: string;
    },
  ): Promise<{ finding: SecurityFindingRow; siblings: SecurityFindingRow[] }> {
    await loadEngagement(engagementId);
    const cell = await loadCell(engagementId, args.cellId);
    if (args.body.length < MIN_FINDING_BODY_CHARS) {
      throw new Error(
        "Finding body must carry evidence: a code excerpt and the reasoning from source to impact (at least 200 characters).",
      );
    }
    const [{ n: existing }] = await db
      .select({ n: count() })
      .from(securityFindings)
      .where(and(eq(securityFindings.engagementId, engagementId), eq(securityFindings.cellId, cell.id)));
    if (Number(existing ?? 0) >= MAX_FINDINGS_PER_CELL) {
      throw new Error(
        "Finding cap reached (100 per cell). Consolidate related findings instead of enumerating.",
      );
    }
    const fingerprint = findingFingerprint({ file: args.file, line: args.line, title: args.title });
    const siblings = await db
      .select()
      .from(securityFindings)
      .where(
        and(
          eq(securityFindings.engagementId, engagementId),
          eq(securityFindings.fingerprint, fingerprint),
        ),
      );
    const inserted = await db
      .insert(securityFindings)
      .values({
        id: `fnd_${randomUUID()}`,
        engagementId,
        cellId: cell.id,
        fingerprint,
        severity: args.severity,
        title: args.title,
        file: args.file ?? null,
        line: args.line ?? null,
        body: args.body,
        status: "open",
        createdAt: now(),
      })
      .returning();
    return { finding: inserted[0], siblings };
  }

  /**
   * Forward-only status flip. Actors: `user:<id>` (the human review route)
   * or a cell id — and only a review cell may flip (spec threat 8: a
   * prompt-injected sweep persona must not refute its peers' findings).
   */
  async function reviewFinding(
    engagementId: string,
    args: { findingId: string; status: "verified" | "refuted"; reason: string; actor: string },
  ): Promise<SecurityFindingRow> {
    await loadEngagement(engagementId);
    const rows = await db
      .select()
      .from(securityFindings)
      .where(
        and(
          eq(securityFindings.engagementId, engagementId),
          eq(securityFindings.id, args.findingId),
        ),
      )
      .limit(1);
    const finding = rows[0];
    if (!finding) {
      throw new Error(`No finding ${args.findingId} in this engagement. List findings with sec_findings_list.`);
    }
    if (!args.reason || args.reason.trim() === "") {
      throw new Error(
        `A ${args.status} ruling needs a reason. Name what the evidence shows or what it missed.`,
      );
    }
    if (finding.status !== "open") {
      throw new Error(`Finding ${finding.id} is already ${finding.status}. Status flips are forward-only.`);
    }
    if (!args.actor.startsWith("user:")) {
      const cells = await db
        .select()
        .from(securityCells)
        .where(and(eq(securityCells.engagementId, engagementId), eq(securityCells.id, args.actor)))
        .limit(1);
      const actorCell = cells[0];
      if (!actorCell || !actorCell.review) {
        throw new Error("Only review cells may flip finding statuses.");
      }
    }
    const updated = await db
      .update(securityFindings)
      .set({ status: args.status, statusReason: args.reason, statusActor: args.actor })
      .where(eq(securityFindings.id, finding.id))
      .returning();
    return updated[0];
  }

  async function listFindings(
    engagementId: string,
    options: ListFindingsOptions = {},
  ): Promise<{ findings: SecurityFindingRow[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const conditions = [eq(securityFindings.engagementId, engagementId)];
    if (options.cellId !== undefined) conditions.push(eq(securityFindings.cellId, options.cellId));
    if (options.severity !== undefined) conditions.push(eq(securityFindings.severity, options.severity));
    if (options.status !== undefined) conditions.push(eq(securityFindings.status, options.status));
    if (options.path !== undefined && options.path !== "") {
      conditions.push(ilike(securityFindings.file, `%${escapeLike(options.path)}%`));
    }
    if (options.cursor !== undefined) {
      const parsed = parseCursor(options.cursor);
      const after = or(
        gt(securityFindings.createdAt, parsed.createdAt),
        and(eq(securityFindings.createdAt, parsed.createdAt), gt(securityFindings.id, parsed.id)),
      );
      // `or` with two defined operands never returns undefined; guard for
      // the type only.
      if (after) conditions.push(after);
    }
    const rows = await db
      .select()
      .from(securityFindings)
      .where(and(...conditions))
      .orderBy(asc(securityFindings.createdAt), asc(securityFindings.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor =
      rows.length > limit && page.length > 0
        ? `${page[page.length - 1].createdAt}:${page[page.length - 1].id}`
        : null;
    return { findings: page, nextCursor };
  }

  /**
   * Stamp a compaction on the running cell that claims `childSessionId`
   * (M5, spec §Context Discipline). Alert, don't auto-repair: this stamps
   * `compacted_at` and measures state-doc staleness for the caller to
   * report — it never mutates cell status, re-dispatches, or kills
   * anything. Returns null when no running cell claims the session (an
   * unclaimed session's compaction is not a security event).
   */
  async function stampCellCompaction(childSessionId: string): Promise<CellCompactionStamp | null> {
    const rows = await db
      .select()
      .from(securityCells)
      .where(
        and(eq(securityCells.childSessionId, childSessionId), eq(securityCells.status, "running")),
      )
      .limit(1);
    const claimed = rows[0];
    if (!claimed) return null;
    const ts = now();
    const updated = await db
      .update(securityCells)
      .set({ compactedAt: ts })
      .where(eq(securityCells.id, claimed.id))
      .returning();
    const cell = updated[0];
    const docRow = await latestStateDocRow(cell.engagementId, cell.dir);
    // No state doc yet → measure from the dispatch: a persona that compacts
    // without ever checkpointing is the staleness worst case, not a fresh one.
    const reference = docRow?.createdAt ?? cell.dispatchedAt ?? cell.createdAt;
    const stateDocAgeMs = Math.max(0, ts - reference);
    return { cell, stateDocAgeMs, stale: stateDocAgeMs > STATE_DOC_STALE_MS };
  }

  /** Tolerant progress read for the cell rail: null when nothing useful. */
  async function getRunningCellProgress(engagementId: string): Promise<CellProgress | null> {
    const cells = await loadCells(engagementId);
    const running = cells.find((c) => c.status === "running");
    if (!running) return null;
    const docRow = await latestStateDocRow(engagementId, running.dir);
    if (!docRow) return null;
    try {
      const doc = parseStateDoc(docRow.content);
      return { status: doc.status, checklist: doc.checklist, queue: doc.queue };
    } catch {
      // Rail display only — a stale/unparseable doc renders as no progress,
      // never as an error.
      return null;
    }
  }

  return {
    createEngagement,
    getEngagement,
    getEngagementBySession,
    setPlan,
    startEngagement,
    dispatchCell,
    completeCell,
    failCell,
    closeEngagement,
    writeFile,
    readFile,
    listFiles,
    reportFinding,
    reviewFinding,
    listFindings,
    stampCellCompaction,
    getRunningCellProgress,
  };
}

export type SecurityEngagementService = ReturnType<typeof createSecurityEngagementService>;

// ── Helpers ────────────────────────────────────────────────────────────────

function ordinalLabel(cell: { ordinal: number }): string {
  return String(cell.ordinal).padStart(2, "0");
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function parseReads(reads: string): number[] {
  try {
    const parsed: unknown = JSON.parse(reads);
    if (Array.isArray(parsed)) return parsed.filter((n): n is number => typeof n === "number");
  } catch {
    // Stamped by startEngagement from a validated plan; fall through.
  }
  return [];
}

function narrowSeverity(value: string): FindingSeverity {
  return (SEVERITIES as readonly string[]).includes(value) ? (value as FindingSeverity) : "info";
}

function parseCursor(cursor: string): { createdAt: number; id: string } {
  const idx = cursor.indexOf(":");
  const createdAt = idx > 0 ? Number(cursor.slice(0, idx)) : Number.NaN;
  const id = idx > 0 ? cursor.slice(idx + 1) : "";
  if (!Number.isFinite(createdAt) || id === "") {
    throw new Error("Invalid cursor. Pass the nextCursor value from the previous page, or omit it.");
  }
  return { createdAt, id };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as Record<string, unknown>;
  if (rec.code === "23505") return true;
  const message = typeof rec.message === "string" ? rec.message : "";
  return message.includes("duplicate key");
}
