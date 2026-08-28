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
import { and, asc, count, desc, eq, gt, ilike, inArray, or, sql } from "drizzle-orm";
import {
  ARCHITECT_PERSONA,
  categoryDigest,
  cellDir,
  expandTriads,
  findingFingerprint,
  hasTriad,
  isKnownPlaybook,
  isLivePersona,
  KNOWN_PERSONAS,
  parsePlan,
  VERIFIER_PERSONA,
  parseStateDoc,
  playbookMarkdown,
  protocolMarkdown,
  ruleExit,
  serializePlan,
  type EngagementPlan,
  type PlanCell,
  type SecurityScope,
  type StateDoc,
  type ToolDecl,
} from "@valet/plugin-security";
import type { AppDb } from "../lib/drizzle.js";
import {
  securityCells,
  securityCoverage,
  securityEngagements,
  securityFiles,
  securityFindingComments,
  securityFindingLinks,
  securityFindings,
  securityHandoffs,
  type SecurityCellRow,
  type SecurityCoverageRow,
  type SecurityEngagementRow,
  type SecurityFindingCommentRow,
  type SecurityFindingRow,
  type SecurityHandoffRow,
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

/** Cap on a finding-comment body (spec §Re-scan / iterate). A note is a short
 * human rationale, not a report. */
export const MAX_FINDING_COMMENT_CHARS = 4000;

/**
 * The checkpoint stride (spec §Context Discipline): a cell-claimed thread
 * that compacts while its latest state doc is older than this is losing
 * work the tree never saw. The compaction hook emits the staleness metric
 * past this age; nothing auto-repairs.
 */
export const STATE_DOC_STALE_MS = 10 * 60_000;

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "open" | "verified" | "refuted";
export type CoverageStatus = "assessed" | "not_assessed";

/** Cap on a coverage area label and its reason (NOT_ASSESSED ledger, M-P2d).
 * An area is a short scope label ("secrets scan"); a reason is one sentence
 * naming the consequence, not a report. */
export const MAX_COVERAGE_AREA_CHARS = 200;
export const MAX_COVERAGE_REASON_CHARS = 1000;

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

/**
 * The persona set a stored plan validates against: the bundled ids ∪ the
 * engagement's repo-declared persona keys (M-P2c, repo wins). A repo config may
 * name its own personas in the plan; validating a stored plan against the
 * bundled set alone would reject it at start/dispatch. Reads the engagement's
 * `configPersonas` column (JSON Record id → path); an absent/invalid value
 * contributes no extra keys.
 */
function knownPersonasForEngagement(engagement: { configPersonas: string | null }): string[] {
  if (!engagement.configPersonas) return [...KNOWN_PERSONAS];
  let map: unknown;
  try {
    map = JSON.parse(engagement.configPersonas);
  } catch {
    return [...KNOWN_PERSONAS];
  }
  if (typeof map !== "object" || map === null || Array.isArray(map)) return [...KNOWN_PERSONAS];
  return [...KNOWN_PERSONAS, ...Object.keys(map as Record<string, unknown>)];
}

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

/** The repo config context stored on an engagement (dynamic-config M-F1). The
 * subset of `SecurityConfig` persisted for later milestones — the plan is
 * seeded separately from the config's steps. */
export interface SecurityConfigContext {
  focus?: string;
  invariants?: string[];
  categories?: string[];
  personas?: Record<string, string>;
  /** Repo-defined persona role markdown, resolved from the clone at create
   * (M-P2c). Keyed by the same ids as `personas` (which holds id → path). The
   * host attaches a repo persona's role from this map. */
  personaMarkdown?: Record<string, string>;
  /** Declared tools the config named (M-P4a). Structured `ToolDecl`s. Stored as
   * JSON on `config_tools`; the host provisions a persona child's tools from it. */
  tools?: ToolDecl[];
  /** The authorized live-testing scope (M-P4b). Stored as JSON on
   * `authorized_scope`; the live-persona dispatch prompt names its hosts and the
   * child sandbox egress allowlist derives from them. */
  scope?: SecurityScope;
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

/** One NOT_ASSESSED gap in the close manifest (M-P2d): a scope area that was
 * not assessed, with the tool involved and the consequence. */
export interface CoverageGap {
  area: string;
  tool: string | null;
  reason: string;
}

/** The coverage rollup in the close manifest (NOT_ASSESSED ledger, M-P2d,
 * spec §Coverage honesty). Counts assessed vs not_assessed, and lists every
 * NOT_ASSESSED area with its reason so the report names the gaps the team
 * should know about. */
export interface CoverageRollup {
  assessed: number;
  notAssessed: number;
  gaps: CoverageGap[];
}

export interface EngagementManifest {
  engagementId: string;
  status: "completed" | "failed";
  repoFullName: string;
  repoRef: string;
  cells: ManifestCell[];
  /** Coverage honesty (M-P2d): the assessed/not_assessed rollup + gap list. */
  coverage: CoverageRollup;
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

/** The re-scan diff against the parent engagement (re-scan / iterate). See
 * `diffEngagement` for the exact semantics; `fixedCount` is null while this
 * engagement runs and a number once it is terminal. */
export interface SecurityDiff {
  parentEngagementId: string;
  /** The parent engagement's session id, so the UI links back to it. Null
   * when the parent row is gone. */
  parentSessionId: string | null;
  /** Distinct fingerprints in this engagement, absent from the parent. */
  newCount: number;
  /** Distinct fingerprints present in both engagements. */
  recurringCount: number;
  /** Parent fingerprints (open or verified) absent here — a fix. Null while
   * running (a scan that has not finished has not looked everywhere). */
  fixedCount: number | null;
  /** Findings this engagement auto-refuted by carry-forward. */
  carriedRefutedCount: number;
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
 *
 * `rescan` is set when the engagement re-scans a prior one (re-scan / iterate).
 * It adds cell-role-specific language that points the persona at the read-only
 * `/prior/` mounts (the prior recon map, the git diff, and the prior findings
 * digest) so the persona re-reasons about the delta instead of the whole repo.
 * A cell is the recon cell when it is the ordinal-1 cell; a review cell is a
 * `review: true` cell (verify); every other cell is a scoped sweep.
 *
 * `config` carries the engagement's focus + invariants (dynamic-config M-F3)
 * and loaded threat categories (M-P2a), seeded from `.valet/security.yml` or
 * edited in the UI. When present, a clearly delimited block rides on EVERY
 * persona dispatch just before the protocol: the focus weights the persona's
 * checklist, a stated invariant turns a confirmed violation into a high-signal
 * finding, and the loaded categories put the domain's known attack surface in
 * front of the persona. An absent focus, empty invariants, and empty categories
 * add nothing — the prompt is byte-identical to before.
 */
export function buildDispatchPrompt(
  cell: SecurityCellRow,
  plan: EngagementPlan,
  readsCells: SecurityCellRow[],
  protocol: string,
  rescan = false,
  config: {
    focus?: string | null;
    invariants?: string[] | null;
    categories?: string[] | null;
    /** The authorized live-testing scope hosts (M-P4b). A live persona's
     * dispatch prompt names these explicitly and forbids acting outside them.
     * A non-live persona ignores the scope. */
    scopeHosts?: string[] | null;
  } = {},
): string {
  const planCell = plan.cells.find((p) => p.ordinal === cell.ordinal);
  const lines: string[] = [
    `You are the "${cell.persona}" persona for security cell ${cell.dir} (ordinal ${cell.ordinal}).`,
    "",
    `Goal: ${cell.goal}`,
    `Mode: ${cell.mode}`,
  ];
  // Triad role framing (M-P2b). The architect plans the phase and declares
  // coverage; it reports NO findings. The verifier audits the worker: it
  // re-derives each finding's dataflow, audits coverage, and refutes what does
  // not hold. Every other persona (the worker, recon, the engagement verify)
  // keeps the default framing. The reads-paths mechanism already points the
  // worker at the architect's plan and the verifier at the worker's state doc.
  if (cell.persona === ARCHITECT_PERSONA) {
    lines.push(
      "",
      "You are the ARCHITECT of this phase. Plan it: detect the surface, write a falsifiable checklist (one row per area, each row naming what to look for and the evidence that proves it), and declare coverage (every area covered or a justified skip).",
      "Write architect_plan.md and seed state.yml to your cell directory. Do NOT run scanners and do NOT report findings — the worker executes your checklist.",
    );
  } else if (cell.persona === VERIFIER_PERSONA) {
    lines.push(
      "",
      "You are the VERIFIER of this phase. Audit the worker cell you read: re-derive every finding's dataflow from the cited source (do not trust the prior artifact), confirm severity, and audit that every checklist item was covered or justifiably skipped.",
      "Write verification.md with per-finding and per-checklist audit rows and a PASS / CONDITIONAL / FAIL verdict. Refute a finding you disprove with sec_finding_review (name what the evidence missed); do NOT verify a finding you merely agree with unless you independently re-derived it.",
    );
  }
  if (cell.mode === "resume") {
    lines.push(
      `Resume: read your own latest state doc at /cells/${cell.dir}/state.yml with sec_fs_read before any other work, and continue from its queue.`,
    );
  }
  if (rescan) {
    const isRecon = cell.ordinal === 1;
    const isReview = cell.review === true;
    lines.push("");
    if (isRecon) {
      lines.push(
        "This is a RE-SCAN. Read /prior/recon.md (the prior map) and /prior/diff.md (what changed since the last review) with sec_fs_read before anything.",
        "Inherit the prior map; UPDATE it only for the changed files — do not re-map unchanged code.",
        "Read /prior/findings.md to know what was already found.",
      );
    } else if (isReview) {
      lines.push(
        "This is a RE-SCAN. Reconcile /prior/findings.md against the current code with sec_fs_read.",
        "A prior verified or open finding whose file changed and no longer applies should be reported here or noted as fixed; carry the rest.",
        "Attack every open finding as usual.",
      );
    } else {
      lines.push(
        "This is a RE-SCAN scoped to the changed code (see /prior/diff.md, read it with sec_fs_read).",
        "The prior findings are in /prior/findings.md — confirm which still apply to the changed files and find issues the diff introduced.",
        "Do not re-review unchanged code.",
      );
    }
  }
  if (planCell?.paths && planCell.paths.length > 0) {
    lines.push(`Scope: limit the sweep to these path globs: ${planCell.paths.join(", ")}`);
  }
  // Authorized live-testing scope (M-P4b). A live persona (dast/fuzz/exploit)
  // operates against a RUNNING target, so its dispatch prompt names the exact
  // hosts it may reach and forbids acting outside them. This is
  // authorization-sensitive: it is the ONLY authorization the persona has. A
  // live persona with no declared scope is told to stop, not to guess a target.
  // A non-live persona ignores the scope entirely (byte-identical prompt).
  if (isLivePersona(cell.persona)) {
    const scopeHosts = (config.scopeHosts ?? []).map((h) => h.trim()).filter((h) => h !== "");
    lines.push("", "--- Authorized scope (live testing) ---");
    if (scopeHosts.length > 0) {
      lines.push(
        "",
        "You are a LIVE persona: you test a RUNNING target. You are authorized to reach ONLY these hosts:",
      );
      for (const host of scopeHosts) lines.push(`- ${host}`);
      lines.push(
        "",
        "Never send a request to any other host. A finding or action outside this scope is forbidden. Respect the declared rate limits, and never run a destructive payload.",
      );
    } else {
      lines.push(
        "",
        "No authorized scope is declared for this engagement. You have NO target and NO authorization to reach any host. Do not guess a target. Record a not_assessed coverage row naming the missing scope, and settle.",
      );
    }
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
  // Engagement focus + known invariants (dynamic-config M-F3). A delimited
  // block just before the protocol so it reads as engagement context, not a
  // per-cell instruction. Only emitted when a value is present.
  const focus = config.focus?.trim();
  const invariants = (config.invariants ?? []).map((inv) => inv.trim()).filter((inv) => inv !== "");
  // Loaded threat categories (M-P2a): the digest of the named categories'
  // threat patterns. `categoryDigest` skips unknown ids and returns "" when
  // none load, so a byte-identical prompt when categories are absent.
  const categories = (config.categories ?? []).filter((id) => id.trim() !== "");
  const digest = categories.length > 0 ? categoryDigest(categories) : "";
  if (focus || invariants.length > 0 || digest !== "") {
    lines.push("", "--- Engagement configuration ---");
    if (focus) {
      lines.push(
        "",
        `Focus of this review (from the engagement): ${focus}. Weight your checklist toward this, but do not skip your cell's core coverage.`,
      );
    }
    if (invariants.length > 0) {
      lines.push(
        "",
        "Known invariants the team asserts hold. Treat a VIOLATION of any as a high-signal finding — a broken invariant is exactly what the team wants to know:",
      );
      for (const inv of invariants) lines.push(`- ${inv}`);
    }
    if (digest !== "") {
      lines.push(
        "",
        "Threat categories loaded (domain attack surface to check against). Each pattern names its CWE/CAPEC and what to look for in the code — work through them for your cell's scope:",
        "",
        digest,
      );
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
    args: {
      sessionId: string;
      repoFullName: string;
      plan: string;
      /** The prior engagement this run re-scans (re-scan / iterate). Sets the
       * new engagement's `parent_engagement_id`, which drives carry-forward
       * refutations in reportFinding and the diff summary. */
      parentEngagementId?: string;
      /** Repo config context (dynamic-config M-F1), parsed from
       * `.valet/security.yml` at create. Present only when a valid repo config
       * seeded this engagement; a preset-seeded engagement omits it and the
       * columns stay null with `has_repo_config` false. Stored for later
       * milestones (M-F3 invariants, M-P2a categories, M-P4 tools); not wired
       * into prompts this milestone. */
      config?: SecurityConfigContext;
    },
    dbh: AppDb = db,
  ): Promise<SecurityEngagementRow> {
    // Fail fast on a malformed plan — a planning-status engagement whose
    // plan cannot parse would strand the runner at sec_start. A repo config may
    // name its own personas in the plan (M-P2c, repo wins); the known set is the
    // bundled ids ∪ the config's persona keys, matching parseSecurityConfig.
    const configPersonaKeys = args.config?.personas ? Object.keys(args.config.personas) : [];
    parsePlan(args.plan, [...KNOWN_PERSONAS, ...configPersonaKeys]);
    const ts = now();
    const config = args.config;
    const inserted = await dbh
      .insert(securityEngagements)
      .values({
        id: `eng_${randomUUID()}`,
        sessionId: args.sessionId,
        status: "planning",
        repoFullName: args.repoFullName,
        plan: args.plan,
        parentEngagementId: args.parentEngagementId ?? null,
        focus: config?.focus ?? null,
        invariants: config?.invariants ? JSON.stringify(config.invariants) : null,
        categories: config?.categories ? JSON.stringify(config.categories) : null,
        configPersonas: config?.personas ? JSON.stringify(config.personas) : null,
        configPersonaMarkdown:
          config?.personaMarkdown && Object.keys(config.personaMarkdown).length > 0
            ? JSON.stringify(config.personaMarkdown)
            : null,
        configTools: config?.tools ? JSON.stringify(config.tools) : null,
        authorizedScope:
          config?.scope && config.scope.hosts.length > 0 ? JSON.stringify(config.scope) : null,
        hasRepoConfig: config !== undefined,
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

  /**
   * Replace the plan while the engagement is still planning. `knownPersonas`
   * defaults to the bundled registry; the structured plan-edit route passes the
   * bundled ids ∪ the engagement's repo-declared persona keys (dynamic-config
   * M-F2), so a config persona stays valid.
   */
  async function setPlan(
    engagementId: string,
    planYaml: string,
    knownPersonas: readonly string[] = KNOWN_PERSONAS,
  ): Promise<SecurityEngagementRow> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status !== "planning") {
      throw new Error("The plan is immutable once the engagement is running.");
    }
    parsePlan(planYaml, knownPersonas);
    const updated = await db
      .update(securityEngagements)
      .set({ plan: planYaml, updatedAt: now() })
      .where(eq(securityEngagements.id, engagementId))
      .returning();
    return updated[0];
  }

  /**
   * Edit the engagement's focus, known invariants, and loaded threat categories
   * while it is still planning (dynamic-config M-F3, M-P2a). Repo config seeds
   * these at create; this lets a user add or change them in the UI before start.
   * Only the passed fields change: a `focus` of `null` clears it, an omitted
   * `focus` leaves it. `invariants` and `categories` are stored as a JSON
   * string[]; an omitted list leaves it, and `[]` clears it. The caller
   * validates category ids against `isKnownCategory` before this runs. Refuses
   * once the engagement runs, matching setPlan's immutability rule.
   */
  async function setEngagementConfig(
    engagementId: string,
    args: { focus?: string | null; invariants?: string[]; categories?: string[] },
  ): Promise<SecurityEngagementRow> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status !== "planning") {
      throw new Error(
        "The focus, invariants, and categories are immutable once the engagement is running.",
      );
    }
    const patch: Partial<typeof securityEngagements.$inferInsert> = { updatedAt: now() };
    if (args.focus !== undefined) {
      const trimmed = args.focus?.trim() ?? "";
      patch.focus = trimmed === "" ? null : trimmed;
    }
    if (args.invariants !== undefined) {
      const cleaned = args.invariants.map((inv) => inv.trim()).filter((inv) => inv !== "");
      patch.invariants = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
    }
    if (args.categories !== undefined) {
      const cleaned = args.categories.map((id) => id.trim()).filter((id) => id !== "");
      patch.categories = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
    }
    const updated = await db
      .update(securityEngagements)
      .set(patch)
      .where(eq(securityEngagements.id, engagementId))
      .returning();
    return updated[0];
  }

  /**
   * Materialize cells from the plan and pin the repo ref. SHA resolution
   * happens in the caller (the sec_start tool); this function only refuses
   * an empty pin.
   *
   * Diff-scoped re-scan (re-scan / iterate): when the engagement has a parent
   * and the caller passes a non-null `changedFiles` list (the GitHub compare
   * of the parent's pinned SHA → the new HEAD), the sweep cells are scoped to
   * the changed directories. Recon (ordinal 1) and review cells stay repo-wide.
   *
   * Scoping REWRITES `engagement.plan`: the changed-dir globs land on the sweep
   * cells' `paths`, and both the materialized `security_cells` and the plan
   * mount (`/plan.yml`) then show the diff plan. `buildDispatchPrompt` already
   * reads `planCell.paths`, so the persona's Scope line follows for free. The
   * base SHA and the changed-path list persist on the engagement row
   * (`base_ref`/`changed_paths`) for the `/prior/diff.md` mount and the UI
   * banner. `changedFiles = null` (a first review, or a re-scan whose compare
   * failed / whose parent had no pinned SHA) runs a FULL scan with no scoping,
   * and the plan is materialized unchanged.
   */
  async function startEngagement(
    engagementId: string,
    args: { resolvedSha: string; baseRef?: string | null; changedFiles?: string[] | null },
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
    const parsed = parsePlan(engagement.plan, knownPersonasForEngagement(engagement));
    // Expand every `triad: true` phase into an architect → worker → verifier
    // triad (M-P2b). Ordinals renumber densely and reads edges remap onto the
    // expanded cells. A plan with no triad cells passes through unchanged, so a
    // preset that declares no triads (or a repo config) materializes as before.
    const plan: EngagementPlan = { cells: expandTriads(parsed.cells) };

    // Diff-scope only a re-scan with a non-empty changed-file list. Derive the
    // changed directories once; a diff too wide to scope usefully falls back to
    // a full scan (globs = null) but still records base_ref + changed_paths.
    const changedFiles =
      engagement.parentEngagementId && args.changedFiles ? args.changedFiles : null;
    const globs = changedFiles ? changedDirGlobs(changedFiles) : null;

    // Inject the globs onto the sweep cells (not recon, not review) and serialize
    // the adjusted plan back. When there are no globs (full scan) the plan is the
    // expanded plan; a first-review preset with no triads is byte-identical to
    // before, and a triad preset materializes the expanded cells.
    const scopedCells: PlanCell[] = plan.cells.map((planCell) => {
      const isSweep = planCell.ordinal !== 1 && planCell.review !== true;
      if (!globs || !isSweep) return planCell;
      return { ...planCell, paths: mergePaths(planCell.paths, globs) };
    });
    // Serialize the expanded (and, on a re-scan, scoped) plan back so /plan.yml
    // and the materialized cells agree. A plan with no triads and no globs keeps
    // the stored plan byte-for-byte; a triad plan re-serializes the expanded
    // cells. `hasTriad(parsed.cells)` is the "did expansion change anything"
    // signal — expandTriads is identity on a plan with no triad cells.
    const planYaml =
      hasTriad(parsed.cells) || globs ? serializePlan(scopedCells) : engagement.plan;

    const ts = now();
    const cellValues = scopedCells.map((planCell) => ({
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
        .set({
          status: "running",
          repoRef: args.resolvedSha,
          plan: planYaml,
          // Persist the diff context for the /prior/diff.md mount and the UI
          // banner. Only a re-scan (has a parent) records a base_ref; a first
          // review never diffs. Both null on a full scan (no parent, or a
          // re-scan whose compare failed / whose parent had no pinned SHA).
          baseRef: engagement.parentEngagementId ? args.baseRef ?? null : null,
          changedPaths: changedFiles ? JSON.stringify(changedFiles) : null,
          updatedAt: ts,
        })
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

    const plan = parsePlan(engagement.plan, knownPersonasForEngagement(engagement));
    const readOrdinals = parseReads(cell.reads);
    const readsCells = cells.filter((c) => readOrdinals.includes(c.ordinal));
    const prompt = buildDispatchPrompt(
      cell,
      plan,
      readsCells,
      protocolMarkdown(),
      engagement.parentEngagementId !== null,
      // Focus + invariants + loaded threat categories ride on every dispatch
      // (dynamic-config M-F3, M-P2a). The invariants and categories columns are
      // JSON string[]; a malformed value adds nothing.
      {
        focus: engagement.focus,
        invariants: parseJsonStringArrayColumn(engagement.invariants),
        categories: parseJsonStringArrayColumn(engagement.categories),
        // Authorized scope (M-P4b): only a live persona reads it, but pass it
        // always — buildDispatchPrompt gates on the persona.
        scopeHosts: parseAuthorizedScopeHosts(engagement.authorizedScope),
      },
    );

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

  /**
   * Cancel a planning or running engagement (spec §Cancel). Human-only at the
   * route; the service holds the transition. Sets the engagement to
   * 'cancelled' and fails every unsettled cell (pending/running/yielded) with
   * a "engagement cancelled" reason in one transaction. A running cell's
   * `child_session_id` returns so the route tears the in-flight child down.
   * A cancelled engagement dispatches nothing (dispatchCell refuses) and
   * never re-closes.
   */
  async function cancelEngagement(
    engagementId: string,
  ): Promise<{ engagement: SecurityEngagementRow; terminatedChildSessionId?: string }> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status !== "planning" && engagement.status !== "running") {
      throw new Error(
        `The engagement is ${engagement.status}. Only a planning or running engagement can be cancelled.`,
      );
    }
    const cells = await loadCells(engagementId);
    const running = cells.find((c) => c.status === "running");
    const terminatedChildSessionId = running?.childSessionId ?? undefined;
    const ts = now();
    const updatedEngagement = await db.transaction(async (tx) => {
      // Fail every unsettled cell with the cancel reason. Completed and
      // already-failed cells keep their terminal status.
      const failed = await tx
        .update(securityCells)
        .set({ status: "failed", settledAt: ts })
        .where(
          and(
            eq(securityCells.engagementId, engagementId),
            inArray(securityCells.status, ["pending", "running", "yielded"]),
          ),
        )
        .returning({ id: securityCells.id });
      for (let i = 0; i < failed.length; i += 1) recordSecurityCellSettled("failed");
      const rows = await tx
        .update(securityEngagements)
        .set({ status: "cancelled", updatedAt: ts })
        .where(eq(securityEngagements.id, engagementId))
        .returning();
      return rows[0];
    });
    return { engagement: updatedEngagement, terminatedChildSessionId };
  }

  /** Close the engagement and compute the manifest. */
  async function closeEngagement(engagementId: string): Promise<EngagementManifest> {
    const engagement = await loadEngagement(engagementId);
    if (engagement.status === "completed" || engagement.status === "failed") {
      throw new Error(`The engagement is already ${engagement.status}. Read the manifest from the thread.`);
    }
    if (engagement.status === "cancelled") {
      throw new Error("The engagement was cancelled. A cancelled engagement never closes.");
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

    // Coverage rollup (NOT_ASSESSED ledger, M-P2d): count assessed vs
    // not_assessed and collect every NOT_ASSESSED area with its reason, so the
    // manifest names the gaps the team should know about.
    const coverageRows = await listCoverage(engagementId);
    const coverage: CoverageRollup = {
      assessed: 0,
      notAssessed: 0,
      gaps: [],
    };
    for (const row of coverageRows) {
      if (row.status === "not_assessed") {
        coverage.notAssessed += 1;
        coverage.gaps.push({ area: row.area, tool: row.tool, reason: row.reason ?? "" });
      } else {
        coverage.assessed += 1;
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
      coverage,
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

  /** The three read-only `/prior/` mounts a re-scan seeds C's tree with (re-scan
   * / iterate): the prior recon map, the git diff, and the prior findings
   * digest. All resolve against the PARENT engagement P. Returns null for a path
   * that is not a `/prior/` mount, so `readFile` falls through to stored rows.
   * Throws a corrective error when the engagement has no parent — `/prior/*` is
   * meaningless on a first review. */
  async function priorMount(
    engagement: SecurityEngagementRow,
    path: string,
  ): Promise<string | null> {
    if (path !== "/prior/diff.md" && path !== "/prior/recon.md" && path !== "/prior/findings.md") {
      return null;
    }
    if (!engagement.parentEngagementId) {
      throw new Error(
        "This is not a re-scan; there is no prior engagement. The /prior/ mounts exist only on a re-scan (a review created with rescanOf).",
      );
    }
    const parentId = engagement.parentEngagementId;
    if (path === "/prior/diff.md") return buildPriorDiffMd(engagement);
    if (path === "/prior/recon.md") return buildPriorReconMd(parentId);
    return buildPriorFindingsMd(parentId);
  }

  /** `/prior/diff.md`: the base→head SHA range and the changed-file list, or a
   * full-re-scan note when no diff was captured (compare failed, or the parent
   * had no pinned SHA). */
  function buildPriorDiffMd(engagement: SecurityEngagementRow): string {
    const changed = parsePathList(engagement.changedPaths);
    if (!engagement.baseRef || changed === null) {
      return [
        "# Prior diff",
        "",
        "Full re-scan: prior commit unavailable, scanning everything.",
        "The changed-file diff could not be captured (the prior review had no pinned commit, or the compare failed), so this re-scan reviews the whole repository. Use /prior/recon.md and /prior/findings.md as your starting point.",
        "",
      ].join("\n");
    }
    const lines = [
      "# Prior diff",
      "",
      `Base (prior review commit): ${engagement.baseRef}`,
      `Head (this review commit): ${engagement.repoRef || "(pinned at start)"}`,
      "",
      `${changed.length} changed file${changed.length === 1 ? "" : "s"} since the prior review:`,
      "",
    ];
    for (const file of changed) lines.push(`- ${file}`);
    lines.push("");
    return lines.join("\n");
  }

  /** `/prior/recon.md`: P's latest recon state doc (P's ordinal-1 cell dir), or
   * a short note when P produced no recon map. */
  async function buildPriorReconMd(parentId: string): Promise<string> {
    const reconCell = (
      await db
        .select({ dir: securityCells.dir })
        .from(securityCells)
        .where(and(eq(securityCells.engagementId, parentId), eq(securityCells.ordinal, 1)))
        .limit(1)
    )[0];
    if (reconCell) {
      const docRow = await latestStateDocRow(parentId, reconCell.dir);
      if (docRow) {
        return [
          "# Prior recon map",
          "",
          `Inherited from the prior review's recon cell (/cells/${reconCell.dir}/state.yml). Update it only for the changed files.`,
          "",
          docRow.content,
          "",
        ].join("\n");
      }
    }
    return [
      "# Prior recon map",
      "",
      "No prior recon map: the prior review's recon cell wrote no state doc. Map the codebase fresh, then focus the sweeps on the changed files in /prior/diff.md.",
      "",
    ].join("\n");
  }

  /** `/prior/findings.md`: a digest of P's findings grouped by status
   * (verified / open / refuted), each with severity, title, file:line, status,
   * and a short body excerpt. A finding that a human commented on during triage
   * carries those notes under a "Notes:" line — the load-bearing carry (spec
   * §Re-scan / iterate): the persona sees the prior human reasoning ("intended —
   * the check is in middleware X"), not just the status. */
  async function buildPriorFindingsMd(parentId: string): Promise<string> {
    const findings = await db
      .select()
      .from(securityFindings)
      .where(eq(securityFindings.engagementId, parentId))
      .orderBy(asc(securityFindings.createdAt), asc(securityFindings.id));
    const lines = ["# Prior findings", ""];
    if (findings.length === 0) {
      lines.push("The prior review produced no findings.", "");
      return lines.join("\n");
    }
    // One grouped query for the page's comments, oldest-first (thread order).
    const commentRows = await db
      .select()
      .from(securityFindingComments)
      .where(eq(securityFindingComments.engagementId, parentId))
      .orderBy(asc(securityFindingComments.createdAt), asc(securityFindingComments.id));
    const commentsByFinding = new Map<string, SecurityFindingCommentRow[]>();
    for (const c of commentRows) {
      const list = commentsByFinding.get(c.findingId) ?? [];
      list.push(c);
      commentsByFinding.set(c.findingId, list);
    }
    const groups: { status: FindingStatus; heading: string }[] = [
      { status: "verified", heading: "Verified (confirmed real)" },
      { status: "open", heading: "Open (not yet triaged)" },
      { status: "refuted", heading: "Refuted (dismissed — carried forward, do not re-triage)" },
    ];
    for (const { status, heading } of groups) {
      const group = findings.filter((f) => f.status === status);
      if (group.length === 0) continue;
      lines.push(`## ${heading} — ${group.length}`, "");
      for (const f of group) {
        const loc = f.file ? `${f.file}${f.line != null ? `:${f.line}` : ""}` : "(no file)";
        lines.push(`- [${f.severity}] ${f.title} — ${loc}`);
        const excerpt = f.body.replace(/\s+/g, " ").trim().slice(0, 280);
        if (excerpt !== "") lines.push(`  ${excerpt}${f.body.length > 280 ? "…" : ""}`);
        // The human triage notes: the persona reads the prior reasoning, not
        // just the verdict. Author is not named — "team note:" is enough.
        const comments = commentsByFinding.get(f.id) ?? [];
        if (comments.length > 0) {
          lines.push("  Notes:");
          for (const c of comments) {
            const note = c.body.replace(/\s+/g, " ").trim();
            if (note !== "") lines.push(`  - team note: ${note}`);
          }
        }
      }
      lines.push("");
    }
    return lines.join("\n");
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
    if (path.startsWith("/prior/")) {
      const content = await priorMount(engagement, path);
      if (content !== null) return { path, revision: null, content };
      throw new Error(`No file at ${path}. Use sec_fs_list to see the tree.`);
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
    // The read-only /prior/ reasoning mounts appear only on a re-scan (re-scan /
    // iterate) — a first review has no prior engagement to seed from. The size
    // is generated content; report 0 rather than build every digest for a list.
    if (engagement.parentEngagementId) {
      for (const name of ["diff", "recon", "findings"]) {
        mounts.push({ path: `/prior/${name}.md`, revisions: 1, size: 0 });
      }
    }
    for (const mount of mounts) {
      if (prefix === undefined || mount.path.startsWith(prefix)) byPath.set(mount.path, mount);
    }
    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Insert a finding; the server computes the fingerprint and returns any
   * siblings sharing it (advisory dedup — the persona decides).
   *
   * Re-scan / iterate: when the engagement has a `parent_engagement_id` and
   * the reported fingerprint matched a REFUTED finding in the parent, the new
   * finding is inserted already `refuted` (carry-forward). Only a dismissal
   * carries — so the reviewer never re-triages a false positive it already
   * dismissed. A prior open or verified fingerprint stays open here, so a real
   * issue resurfaces for confirmation. `carriedFrom` names the source when it
   * carried, else null. */
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
  ): Promise<{
    finding: SecurityFindingRow;
    siblings: SecurityFindingRow[];
    carriedFrom: { parentEngagementId: string; reason: string } | null;
  }> {
    const engagement = await loadEngagement(engagementId);
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

    // Carry-forward: only a parent's REFUTED verdict on the same fingerprint
    // pre-dismisses this finding. A parent open/verified fingerprint does not
    // carry — it must resurface open for confirmation.
    let carriedFrom: { parentEngagementId: string; reason: string } | null = null;
    if (engagement.parentEngagementId) {
      const priorRefuted = await db
        .select()
        .from(securityFindings)
        .where(
          and(
            eq(securityFindings.engagementId, engagement.parentEngagementId),
            eq(securityFindings.fingerprint, fingerprint),
            eq(securityFindings.status, "refuted"),
          ),
        )
        .limit(1);
      const source = priorRefuted[0];
      if (source) {
        carriedFrom = {
          parentEngagementId: engagement.parentEngagementId,
          reason: source.statusReason ?? "",
        };
      }
    }

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
        ...(carriedFrom
          ? {
              status: "refuted" as const,
              statusReason: `Carried from the previous review: ${carriedFrom.reason}`,
              statusActor: "carry-forward",
            }
          : { status: "open" as const }),
        createdAt: now(),
      })
      .returning();
    return { finding: inserted[0], siblings, carriedFrom };
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
   * Record a fix session spawned from a finding (sec_handoff). Insert-only;
   * no unique constraint — a finding may spawn several fix sessions. The
   * findings-list route surfaces these per finding and the child slide-over
   * opens each one.
   */
  async function recordHandoff(args: {
    engagementId: string;
    findingId: string;
    childSessionId: string;
    title: string;
    task?: string;
    createdBy: string;
  }): Promise<SecurityHandoffRow> {
    const inserted = await db
      .insert(securityHandoffs)
      .values({
        id: `hnd_${randomUUID()}`,
        engagementId: args.engagementId,
        findingId: args.findingId,
        childSessionId: args.childSessionId,
        title: args.title,
        task: args.task ?? null,
        createdBy: args.createdBy,
        createdAt: now(),
      })
      .returning();
    return inserted[0];
  }

  /** Fix sessions for the engagement, newest first; optionally one finding. */
  async function listHandoffs(
    engagementId: string,
    options: { findingId?: string } = {},
  ): Promise<SecurityHandoffRow[]> {
    const conditions = [eq(securityHandoffs.engagementId, engagementId)];
    if (options.findingId !== undefined) {
      conditions.push(eq(securityHandoffs.findingId, options.findingId));
    }
    return db
      .select()
      .from(securityHandoffs)
      .where(and(...conditions))
      .orderBy(desc(securityHandoffs.createdAt), desc(securityHandoffs.id));
  }

  /**
   * Add a human note to a finding (spec §Re-scan / iterate). Insert-only; no
   * unique constraint — a finding carries a thread of many notes. The caller
   * confirms the finding belongs to the engagement (the route does); the body
   * is validated non-empty and capped. On a re-scan, these notes ride into
   * `/prior/findings.md`, so the personas see the prior human reasoning.
   */
  async function addFindingComment(
    engagementId: string,
    args: { findingId: string; body: string; authorUserId: string },
  ): Promise<SecurityFindingCommentRow> {
    const body = args.body.trim();
    if (body === "") {
      throw new Error("A note needs a body. Write what you want the next scan to know.");
    }
    if (body.length > MAX_FINDING_COMMENT_CHARS) {
      throw new Error(
        `A note is at most ${MAX_FINDING_COMMENT_CHARS} characters. Trim it to the reasoning that matters.`,
      );
    }
    const inserted = await db
      .insert(securityFindingComments)
      .values({
        id: `cmt_${randomUUID()}`,
        findingId: args.findingId,
        engagementId,
        body,
        authorUserId: args.authorUserId,
        createdAt: now(),
      })
      .returning();
    return inserted[0];
  }

  /**
   * Record one coverage claim for a cell (NOT_ASSESSED ledger, M-P2d, spec
   * §Coverage honesty). Insert-only; no unique constraint — a cell records one
   * row per area it covered or skipped. `area` is required and non-empty;
   * `status` is `assessed` (a check ran) or `not_assessed` (a tool absent). A
   * `not_assessed` row MUST carry a reason — the whole point of the ledger is
   * that an absent tool names its consequence, never a silent gap. `tool` is the
   * scanner involved, or null when no specific tool backs the area. The caller
   * confirms the cell belongs to the engagement (the persona route does).
   */
  async function reportCoverage(
    engagementId: string,
    args: {
      cellId: string;
      area: string;
      status: CoverageStatus;
      tool?: string | null;
      reason?: string | null;
    },
  ): Promise<SecurityCoverageRow> {
    await loadEngagement(engagementId);
    const cell = await loadCell(engagementId, args.cellId);
    const area = args.area.trim();
    if (area === "") {
      throw new Error("Coverage needs an area. Name the scope, e.g. 'secrets scan' or 'semgrep owasp'.");
    }
    if (area.length > MAX_COVERAGE_AREA_CHARS) {
      throw new Error(
        `The coverage area is at most ${MAX_COVERAGE_AREA_CHARS} characters. Use a short scope label.`,
      );
    }
    const reason = args.reason?.trim() ?? "";
    if (args.status === "not_assessed" && reason === "") {
      throw new Error(
        "A not_assessed area needs a reason naming the consequence, e.g. 'secrets not scanned because gitleaks is missing'.",
      );
    }
    if (reason.length > MAX_COVERAGE_REASON_CHARS) {
      throw new Error(
        `The coverage reason is at most ${MAX_COVERAGE_REASON_CHARS} characters. Name the consequence in one sentence.`,
      );
    }
    const tool = args.tool?.trim();
    const inserted = await db
      .insert(securityCoverage)
      .values({
        id: `cov_${randomUUID()}`,
        engagementId,
        cellId: cell.id,
        area,
        status: args.status,
        tool: tool !== undefined && tool !== "" ? tool : null,
        reason: reason !== "" ? reason : null,
        createdAt: now(),
      })
      .returning();
    return inserted[0];
  }

  /** The engagement's coverage rows, oldest-first; optionally one cell. */
  async function listCoverage(
    engagementId: string,
    options: { cellId?: string } = {},
  ): Promise<SecurityCoverageRow[]> {
    const conditions = [eq(securityCoverage.engagementId, engagementId)];
    if (options.cellId !== undefined) conditions.push(eq(securityCoverage.cellId, options.cellId));
    return db
      .select()
      .from(securityCoverage)
      .where(and(...conditions))
      .orderBy(asc(securityCoverage.createdAt), asc(securityCoverage.id));
  }

  /** Notes on the engagement's findings, oldest-first (thread order);
   * optionally one finding. */
  async function listFindingComments(
    engagementId: string,
    options: { findingId?: string } = {},
  ): Promise<SecurityFindingCommentRow[]> {
    const conditions = [eq(securityFindingComments.engagementId, engagementId)];
    if (options.findingId !== undefined) {
      conditions.push(eq(securityFindingComments.findingId, options.findingId));
    }
    return db
      .select()
      .from(securityFindingComments)
      .where(and(...conditions))
      .orderBy(asc(securityFindingComments.createdAt), asc(securityFindingComments.id));
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

  /**
   * Engagement spend: the runner session PLUS every cell's child session,
   * summed from `cost_entries` (spec §engagement cost). Fix-session handoffs
   * (`security_handoffs.child_session_id`) are separate follow-up work and are
   * NOT counted — the review cost is the runner + its cells. `priced` is false
   * when any counted turn is unpriced (`cost_total IS NULL`, an unpriced
   * provider), so the panel shows tokens without a wrong dollar amount. Returns
   * zeros while the engagement has no runner turn or cell children yet.
   */
  async function getEngagementCost(
    engagementId: string,
  ): Promise<{ costUsd: number; totalTokens: number; priced: boolean }> {
    const engagement = await loadEngagement(engagementId);
    const cells = await loadCells(engagementId);
    const ids = [
      engagement.sessionId,
      ...cells
        .map((c) => c.childSessionId)
        .filter((id): id is string => id !== null),
    ];
    // No session ids yet (planning, no runner turn) → zeros. Also guards the
    // empty-list case: `IN ()` is malformed SQL.
    if (ids.length === 0) return { costUsd: 0, totalTokens: 0, priced: true };
    const result = (await db.execute(sql`
      SELECT COALESCE(SUM(cost_total),0) AS cost_usd,
             COALESCE(SUM(total_tokens),0) AS total_tokens,
             COALESCE(bool_or(cost_total IS NULL), false) AS has_unpriced
      FROM cost_entries
      WHERE session_id IN (${sql.join(ids, sql`, `)})`)) as {
      rows: { cost_usd: unknown; total_tokens: unknown; has_unpriced: unknown }[];
    };
    const row = result.rows[0];
    return {
      costUsd: Number(row?.cost_usd ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
      priced: row?.has_unpriced !== true,
    };
  }

  /**
   * The re-scan diff against the parent engagement (re-scan / iterate). Null
   * when this engagement has no `parent_engagement_id` (a first review). The
   * comparison is by distinct fingerprint:
   *   - newCount: fingerprints in this engagement, not in the parent.
   *   - recurringCount: fingerprints in BOTH.
   *   - carriedRefutedCount: this engagement's findings auto-refuted by
   *     carry-forward (`status_actor = 'carry-forward'`).
   *   - fixedCount: fingerprints the parent had OPEN or VERIFIED that are
   *     ABSENT from this engagement. Meaningful ONLY once this engagement is
   *     terminal (completed/failed) — a still-running scan has not looked
   *     everywhere yet, so an absent fingerprint is not yet a fix. Returned
   *     null while running, a number once terminal.
   */
  async function diffEngagement(engagementId: string): Promise<SecurityDiff | null> {
    const engagement = await loadEngagement(engagementId);
    if (!engagement.parentEngagementId) return null;

    const parent = await db
      .select()
      .from(securityEngagements)
      .where(eq(securityEngagements.id, engagement.parentEngagementId))
      .limit(1);
    const parentRow = parent[0];
    // The parent row is gone (deleted). The lineage id is still on this row,
    // but nothing to compare against — report a lineage with zero deltas.
    const parentSessionId = parentRow?.sessionId ?? null;

    const childFindings = await db
      .select()
      .from(securityFindings)
      .where(eq(securityFindings.engagementId, engagementId));
    const parentFindings = parentRow
      ? await db
          .select()
          .from(securityFindings)
          .where(eq(securityFindings.engagementId, engagement.parentEngagementId))
      : [];

    const childFingerprints = new Set(childFindings.map((f) => f.fingerprint));
    const parentFingerprints = new Set(parentFindings.map((f) => f.fingerprint));

    let newCount = 0;
    let recurringCount = 0;
    for (const fp of childFingerprints) {
      if (parentFingerprints.has(fp)) recurringCount += 1;
      else newCount += 1;
    }

    const carriedRefutedCount = childFindings.filter(
      (f) => f.statusActor === "carry-forward",
    ).length;

    // fixedCount only once terminal. A fingerprint the parent had open or
    // verified that no longer appears is a fix — but only if this scan
    // finished. While running, absence is "not looked yet", so null.
    const terminal = engagement.status === "completed" || engagement.status === "failed";
    let fixedCount: number | null = null;
    if (terminal) {
      const parentLive = new Set(
        parentFindings
          .filter((f) => f.status === "open" || f.status === "verified")
          .map((f) => f.fingerprint),
      );
      fixedCount = 0;
      for (const fp of parentLive) {
        if (!childFingerprints.has(fp)) fixedCount += 1;
      }
    }

    return {
      parentEngagementId: engagement.parentEngagementId,
      parentSessionId,
      newCount,
      recurringCount,
      fixedCount,
      carriedRefutedCount,
    };
  }

  /** The distinct fingerprints present in the parent engagement (re-scan /
   * iterate). Empty when this engagement has no parent. The findings route
   * marks a finding `recurring` when its fingerprint is in this set. */
  async function parentFingerprints(engagementId: string): Promise<Set<string>> {
    const engagement = await loadEngagement(engagementId);
    if (!engagement.parentEngagementId) return new Set();
    const rows = await db
      .select({ fingerprint: securityFindings.fingerprint })
      .from(securityFindings)
      .where(eq(securityFindings.engagementId, engagement.parentEngagementId));
    return new Set(rows.map((r) => r.fingerprint));
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
    setEngagementConfig,
    startEngagement,
    dispatchCell,
    completeCell,
    failCell,
    cancelEngagement,
    closeEngagement,
    writeFile,
    readFile,
    listFiles,
    reportFinding,
    reviewFinding,
    listFindings,
    recordHandoff,
    listHandoffs,
    addFindingComment,
    listFindingComments,
    reportCoverage,
    listCoverage,
    stampCellCompaction,
    getRunningCellProgress,
    getEngagementCost,
    diffEngagement,
    parentFingerprints,
  };
}

export type SecurityEngagementService = ReturnType<typeof createSecurityEngagementService>;

// ── Helpers ────────────────────────────────────────────────────────────────

function ordinalLabel(cell: { ordinal: number }): string {
  return String(cell.ordinal).padStart(2, "0");
}

/** Cap on the number of changed-dir globs a diff-scoped sweep carries. Past
 * this the diff is too wide to scope usefully — the caller falls back to a full
 * scan (globs = null) so a sweeping refactor still gets a whole-repo review. */
export const MAX_CHANGED_DIR_GLOBS = 24;

/**
 * Derive changed-directory include globs from a list of changed file paths
 * (re-scan / iterate diff scoping). Keeps up to two path segments: a top-level
 * dir becomes `<dir>/**`, and a one-level-deep dir becomes `<a>/<b>/**`. A
 * changed root-level file (no slash) yields the repo-wide `**` glob, which
 * un-scopes the sweep — a changed root file must still be reviewed. Returns
 * null when the distinct glob count exceeds `MAX_CHANGED_DIR_GLOBS` (fall back
 * to a full scan) or when the list is empty.
 */
export function changedDirGlobs(changedFiles: string[]): string[] | null {
  const globs = new Set<string>();
  for (const raw of changedFiles) {
    const file = raw.trim();
    if (file === "") continue;
    const segments = file.split("/").filter((s) => s !== "");
    if (segments.length <= 1) {
      // A root-level file — its parent is the repo root. Scope to everything.
      globs.add("**");
      continue;
    }
    const depth = Math.min(segments.length - 1, 2);
    globs.add(`${segments.slice(0, depth).join("/")}/**`);
  }
  if (globs.size === 0) return null;
  if (globs.has("**")) return ["**"];
  if (globs.size > MAX_CHANGED_DIR_GLOBS) return null;
  return [...globs].sort();
}

/** Merge a plan cell's existing include globs with the diff globs, deduped.
 * A cell that already scopes to part of the repo keeps that scope AND gains the
 * diff globs (a union — the persona sweeps either). */
function mergePaths(existing: string[] | undefined, globs: string[]): string[] {
  if (!existing || existing.length === 0) return globs;
  const merged = new Set([...existing, ...globs]);
  return [...merged];
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Parse the engagement's `changed_paths` JSON (a string[] or null). Returns
 * null for a null/absent/unparseable value — the /prior/diff.md mount reads
 * that as "no diff captured, full re-scan". */
function parsePathList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    // A malformed value is treated as no diff — the mount falls back to full.
  }
  return null;
}

/** Parse the engagement's `invariants` JSON (a string[] or null), for the
 * dispatch prompt (dynamic-config M-F3). Returns [] for a null/absent/malformed
 * value — a bad column must not throw a dispatch. */
/** Parse a stored JSON string[] column (invariants, categories). A null or
 * malformed value yields [], so a bad column adds nothing to the prompt. */
function parseJsonStringArrayColumn(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    // A malformed value is treated as an empty list.
  }
  return [];
}

/** Parse the engagement's `authorized_scope` JSON (`{ hosts: string[] }` or
 * null) into the host list (M-P4b). Returns [] for a null/absent/malformed
 * value — a live persona with no scope is told to stop, not to guess. */
export function parseAuthorizedScopeHosts(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const hosts = (parsed as Record<string, unknown>).hosts;
      if (Array.isArray(hosts)) return hosts.filter((h): h is string => typeof h === "string");
    }
  } catch {
    // A malformed value is treated as no scope.
  }
  return [];
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
