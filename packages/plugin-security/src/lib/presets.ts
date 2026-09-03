import {
  ATTACK_TREE_PERSONA,
  bundledPersonaIds,
  CODE_REVIEW_PERSONA,
  DAST_PERSONA,
  EXPLOIT_PERSONA,
  FUZZ_PERSONA,
  PIVOT_COORDINATOR_PERSONA,
  RECONCILE_PERSONA,
  REPORT_PERSONA,
  SAST_PERSONA,
  THREAT_MODEL_PERSONA,
} from "./personas.js";
import { MAX_PLAN_CELLS, type PlanCell } from "./plan.js";
import { expandTriads } from "./triad.js";

export { CODE_REVIEW_PERSONA };

/** The bundled persona ids gate parsePlan's persona check. Sourced from the
 * persona registry so a new bundled persona lands here for free. */
export const KNOWN_PERSONAS: readonly string[] = bundledPersonaIds();

/** A create-time sweep preset: which cells run for one review. The hub lists
 * these; the create route validates the chosen id with `isKnownPreset` and
 * seeds `presetPlan(id, { paths })`. See the design spec's Decision 5. */
export interface SecurityPreset {
  id: string;
  label: string;
  description: string;
}

/**
 * The three presets the hub offers. `code-review` runs the full five-cell
 * sweep; the other two are subsets for a faster, narrower review. The create
 * route gates the chosen id against this list through `isKnownPreset`.
 */
export const SECURITY_PRESETS: readonly SecurityPreset[] = [
  {
    id: "code-review",
    label: "Full code review",
    description: "Recon, access control, injection, secrets/config, verify (5 cells).",
  },
  {
    id: "secrets-config",
    label: "Secrets & config",
    description: "Recon, secrets/config scanner sweep, verify (3 cells). Fast.",
  },
  {
    id: "access-injection",
    label: "Access control & injection",
    description: "Recon, authz, injection, verify (4 cells).",
  },
  {
    id: "code-audit",
    label: "Code audit",
    description:
      "Recon, threat model, code review, SAST, access control, injection (triads), attack tree, verify, report. Source-only; deeper than a code review, no active testing.",
  },
  {
    id: "live-pentest",
    label: "Live pentest",
    description:
      "Recon, threat model, DAST, fuzz, exploit, verify. Requires an authorized scope in .valet/security.yml or on the setup page.",
  },
  {
    id: "code-audit-plus-live",
    label: "Code audit + live confirmation",
    description:
      "Every persona: threat model, code review, SAST, access control, injection, DAST, fuzz, exploit, pivot coordinator, attack tree, verify. Requires an authorized scope on the setup page.",
  },
] as const;

/** True when `id` names a preset in SECURITY_PRESETS. */
export function isKnownPreset(id: string): boolean {
  return SECURITY_PRESETS.some((p) => p.id === id);
}

/**
 * The `code-review` preset plan: five cells, all the code-review persona
 * with different goals and reads edges (spec §plugin-security). Cell 1
 * maps the repo and seeds the checklist; cells 2-4 sweep with recon's map;
 * cell 5 attacks the findings with review rights. The string round-trips
 * through parsePlan (asserted in presets.test.ts).
 */
/**
 * The first turn a fresh engagement runner receives, so the session starts
 * working the moment it is created instead of waiting on the user to type
 * (the hub queues this whether or not the user added focus notes). The
 * runner has the security-engagement-runner skill, so the message only
 * needs to start it.
 *
 * Two create paths land here. When `alreadyStarted` is false (the legacy
 * planning path), the engagement waits in planning: the runner reads the
 * plan, folds in any focus notes, then opens the `sec_start` approval gate —
 * that gate is the human checkpoint before any spend.
 *
 * When `alreadyStarted` is true (the `/security/new` setup page), the user
 * already approved the plan by clicking "Start review", so the create route
 * called `startEngagement`. The engagement is running and its cells are
 * materialized. The runner must NOT call `sec_start` — that route rejects a
 * running engagement (409) and the approval gate is redundant. The runner
 * reads `sec_status` and drives the dispatch loop straight away.
 */
/** The longest a derived security title may run before the ref is dropped.
 * Keeps the title inside the session-title column and readable in a list. */
const MAX_SECURITY_TITLE_CHARS = 60;

/**
 * The auto-title for a security session (#7): "Security review · owner/repo"
 * plus "@ref" when the review pins a non-default ref. Drop "@ref" for the
 * default branch (a null/empty ref). Shorten a 40-hex SHA to 7 chars. If the
 * "@ref" suffix would push the title past MAX_SECURITY_TITLE_CHARS, drop the
 * suffix rather than truncate mid-ref.
 */
export function securitySessionTitle(repoFullName: string, ref?: string | null): string {
  const base = `Security review · ${repoFullName}`;
  const trimmed = ref?.trim();
  if (!trimmed) return base;
  const short = /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed.slice(0, 7) : trimmed;
  const withRef = `${base}@${short}`;
  return withRef.length <= MAX_SECURITY_TITLE_CHARS ? withRef : base;
}

export function securityKickoffPrompt(
  repoFullName: string,
  opts?: { focusNotes?: string; alreadyStarted?: boolean },
): string {
  const notes = opts?.focusNotes?.trim();
  const focusLine = notes
    ? `\n\nFocus notes from the user${
        opts?.alreadyStarted ? " (weigh these as you dispatch cells)" : " (fold these into the plan before you start)"
      }:\n${notes}`
    : "";
  if (opts?.alreadyStarted) {
    return (
      `Begin the security review of ${repoFullName}. ` +
      `The engagement is already running and its cells are materialized — do NOT call sec_start. ` +
      `Call sec_status to read the plan and cell states, then drive the dispatch loop: ` +
      `dispatch each pending cell with sec_dispatch, rule on its state doc, and continue until sec_close.` +
      focusLine
    );
  }
  return (
    `Begin the security review of ${repoFullName}. ` +
    `Call sec_status to read the engagement plan, summarize the cells for me, ` +
    `adjust the plan with sec_plan_set if the focus notes call for it, ` +
    `then call sec_start to request approval and run the engagement loop.` +
    focusLine
  );
}

export function codeReviewPresetPlan(): string {
  // recon → authz / injection / secrets-config (triads) → verify → report. The
  // report cell is the review's deliverable; every preset ends in one.
  return serializePlan(buildPresetCells(PRESET_SWEEPS["code-review"], { report: true }));
}

/** One sweep the presets compose from: a stable name, playbook, and goal.
 * Recon and verify bookend every preset; the middle sweeps vary. A sweep may
 * name its own `persona` (default `code-review`) and whether it expands as a
 * triad (default true for a middle sweep). Model-only sweeps (threat-model,
 * attack-tree) run as single cells. */
interface SweepDef {
  name: string;
  playbook: string;
  goal: string;
  /** The persona the sweep's worker cell runs under. Defaults to code-review. */
  persona?: string;
  /** Whether the sweep expands into an architect → worker → verifier triad.
   * Defaults to true for a middle sweep; a model-only sweep sets it false. */
  triad?: boolean;
}

const RECON: SweepDef = {
  name: "recon",
  playbook: "recon",
  goal: "Map the codebase, seed the checklist from the file inventory, note trust boundaries",
};

const AUTHZ: SweepDef = {
  name: "authz-sweep",
  playbook: "authz",
  goal: "Sweep authorization on every route, mutation, and trust boundary from the recon map",
};

const INJECTION: SweepDef = {
  name: "injection-sweep",
  playbook: "injection",
  goal: "Sweep injection paths across SQL, command, template, path, and deserialization sinks",
};

const SECRETS_CONFIG: SweepDef = {
  name: "secrets-config",
  playbook: "secrets-config",
  goal: "Run the pre-baked scanners (gitleaks) and any repo-local scanners, triage their output, sweep secrets and config",
};

const VERIFY: SweepDef = {
  name: "verify",
  playbook: "verify",
  goal: "Attack every open finding, sec_finding_review each, refute what does not survive",
};

const CODE_REVIEW_SWEEP: SweepDef = {
  name: "code-review",
  playbook: "authz",
  goal: "Read the code by hand for access-control, injection, and logic flaws the scanners miss",
};

const SAST_SWEEP: SweepDef = {
  name: "sast",
  playbook: "sast",
  persona: SAST_PERSONA,
  goal: "Run the pre-baked scanners plus per-language grep packs, triage hits, record coverage per rule pack",
};

/** A live sweep: probe the authorized target with OWASP-aligned checks. Runs
 * as a triad by default (architect scoping the probe matrix, worker running it,
 * verifier auditing each finding). Requires an authorized_scope in the
 * engagement config; the runtime egress gate refuses otherwise. */
const DAST: SweepDef = {
  name: "dast",
  playbook: "dast",
  persona: DAST_PERSONA,
  goal: "Probe the authorized target: unauth surface, authz per endpoint per actor, injection, XSS, SSRF, headers, CORS, business logic",
};

/** A live sweep: mutation and coverage-guided fuzz against the authorized
 * target. Same scope discipline as dast. */
const FUZZ: SweepDef = {
  name: "fuzz",
  playbook: "fuzz",
  persona: FUZZ_PERSONA,
  goal: "Fuzz reachable endpoints and input points (web, api, library where applicable); triage anomalies into evidence-backed findings",
};

/** A live sweep: chain confirmed findings to a non-destructive PoC (READ then
 * RESTORE). Runs as a single cell (not a triad); its verifier lives inside the
 * later verify cell. */
const EXPLOIT: SweepDef = {
  name: "exploit",
  playbook: "exploit",
  persona: EXPLOIT_PERSONA,
  triad: false,
  goal: "Drive each confirmed finding to a non-destructive PoC against the authorized target; never modify data outside READ/RESTORE",
};

/** A coordination sweep: the pivot-coordinator persona (v1 spec, Part 05).
 * Aggregates needs from live cells, classifies auto vs human, executes the
 * L3 auto-catalog patterns, surfaces one consolidated human ask, and (on
 * resolve) writes /pivot.yml and delta_targets for post-pivot-delta cells.
 * Runs as a single cell, not a triad. Its runtime dispatch (delta
 * re-materialization) lands in follow-up PR A; today the cell settles
 * cleanly once every need it read has been resolved. */
const PIVOT_COORDINATOR_SWEEP: SweepDef = {
  name: "pivot-coordinator",
  playbook: "pivot-coordinator",
  persona: PIVOT_COORDINATOR_PERSONA,
  triad: false,
  goal: "Aggregate needs from live cells, classify auto vs human, execute the L3 auto-catalog, surface one consolidated human ask, and compute delta_targets on resolve",
};

/** A model-only sweep: enumerate threats over STRIDE and the loaded categories.
 * Runs early (right after recon) as a single cell, not a triad. */
const THREAT_MODEL: SweepDef = {
  name: "threat-model",
  playbook: "threat-model",
  persona: THREAT_MODEL_PERSONA,
  triad: false,
  goal: "Enumerate threats over STRIDE and the loaded categories, map each to a recon entry point or trust boundary",
};

/** A model-only sweep: compose attack chains from the confirmed findings.
 * Runs late (just before verify) as a single cell, not a triad. */
const ATTACK_TREE: SweepDef = {
  name: "attack-tree",
  playbook: "attack-tree",
  persona: ATTACK_TREE_PERSONA,
  triad: false,
  goal: "Compose attack chains from the confirmed findings and the threat model; surface multi-step paths",
};

/** The report cell (M-P3). Runs as the FINAL cell, AFTER verify: it reads the
 * whole engagement (recon, the findings with their verdicts, the coverage
 * ledger, handoffs) and writes the markdown report + JSON snapshot with
 * `sec_report_write`. `review: false` — it composes, it does not flip statuses.
 * A single cell, never a triad. Appended by `buildPresetCells` when `opts.report`
 * is set, so it reads every prior ordinal including verify. */
const REPORT: SweepDef = {
  name: "report",
  playbook: "report",
  persona: REPORT_PERSONA,
  triad: false,
  goal: "Read the whole engagement — recon, confirmed findings, coverage ledger, verify verdict — and write the report artifact",
};

/** The reconcile cell of a re-scan (re-scan v2). Runs as cell 2, right after
 * recon and before the diff-scoped sweeps. It reads `/prior/findings.md` and the
 * carried findings, re-checks each against the current code, and marks a carried
 * finding fixed or leaves it recurring. It reports NO new findings and runs as a
 * single cell, never a triad. It stays repo-wide (no diff globs) — it re-checks
 * every carried finding wherever it lives, not only the changed files. */
const RECONCILE: SweepDef = {
  name: "reconcile",
  playbook: "reconcile",
  persona: RECONCILE_PERSONA,
  triad: false,
  goal: "Re-check every carried finding against the current code; mark fixed what the change resolved, leave the rest recurring; report nothing new",
};

/** The middle sweeps of each preset, in order. Recon (cell 1) and verify (last
 * cell) bookend every preset and are added by `buildPresetCells`. */
const PRESET_SWEEPS: Record<string, SweepDef[]> = {
  "code-review": [AUTHZ, INJECTION, SECRETS_CONFIG],
  "secrets-config": [SECRETS_CONFIG],
  "access-injection": [AUTHZ, INJECTION],
  // The code audit: threat model early (single cell), then the code-heavy
  // triads (code review, SAST, access control, injection), then attack tree
  // (single cell) composing the chains, then the engagement verify, then the
  // report cell. Recon and verify bookend as always. Source-only; no active
  // testing (see live-pentest for that). Post-triad expansion the plan stays
  // under MAX_PLAN_CELLS (asserted in presets.test.ts).
  "code-audit": [THREAT_MODEL, CODE_REVIEW_SWEEP, SAST_SWEEP, AUTHZ, INJECTION, ATTACK_TREE],
  // The live pentest: threat model early (single cell), then the live triads
  // (DAST, fuzz), then exploit as a single cell, then engagement verify + report.
  // Recon and verify bookend as always. Every live persona in the plan requires
  // an authorized_scope; the setup wizard blocks a submit without one, and the
  // runtime egress gate refuses a live persona whose scope is empty.
  // Post-triad expansion: 1 recon + 1 threat-model + 2 x 3 (dast+fuzz) + 1 exploit
  // + 1 verify + 1 report = 11 cells, within MAX_PLAN_CELLS.
  "live-pentest": [THREAT_MODEL, DAST, FUZZ, EXPLOIT],
  // The code audit + live confirmation: every persona in the plan. Recon
  // opens, threat model runs early (single cell), then the code-heavy triads
  // (code review, SAST, access control, injection), then the live triads
  // (DAST, fuzz), then exploit as a single cell, then the pivot-coordinator
  // aggregates any needs the live cells surfaced, then attack tree composes
  // the chains, then engagement verify. Requires an authorized scope; the
  // setup wizard blocks a submit without one. Post-triad expansion:
  //   1 recon + 1 threat-model + 4*3 code-heavy triads + 2*3 live triads
  //   + 1 exploit + 1 pivot-coordinator + 1 attack-tree + 1 verify
  //   + optional report = 23 or 24 cells, within MAX_PLAN_CELLS (32).
  "code-audit-plus-live": [
    THREAT_MODEL,
    CODE_REVIEW_SWEEP,
    SAST_SWEEP,
    AUTHZ,
    INJECTION,
    DAST,
    FUZZ,
    EXPLOIT,
    PIVOT_COORDINATOR_SWEEP,
    ATTACK_TREE,
  ],
};

/** The default `Include report` checkbox state per preset when the caller
 * does not pass an explicit `includeReport`. Historical shape: the wider
 * presets (`code-review`, `code-audit`, `live-pentest`) defaulted a report
 * on, the narrow / fast presets (`secrets-config`, `access-injection`) did
 * not. v1 UX-flow spec (Part 08) makes the report a user choice, but keeps
 * these defaults so existing behavior does not regress. Callers who own the
 * "Include a written report" checkbox pass an explicit boolean. */
export function presetReportDefault(id: string): boolean {
  return new Set(["code-review", "code-audit", "live-pentest", "code-audit-plus-live"]).has(id);
}

/**
 * Escape a scalar for a YAML double-quoted string. Escape the backslash FIRST,
 * then the quote, then the control characters. A `.valet/security.yml` step
 * often writes a folded (`>`) goal, so `cell.goal` can hold real newlines and
 * tabs; an unescaped newline breaks the double-quoted scalar and makes the
 * re-parse throw "missing closing quote". Escaping them keeps serialize → parse
 * a round trip.
 */
function yamlQuote(text: string): string {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

/**
 * Serialize a plan's cells to the same YAML field layout `codeReviewPresetPlan`
 * emits, so the output round-trips through `parsePlan`. Optional fields
 * (`name`, `playbook`, `paths`, `review`) appear only when set.
 */
export function serializePlan(cells: PlanCell[]): string {
  const lines: string[] = ["cells:"];
  for (const cell of cells) {
    lines.push(`  - ordinal: ${cell.ordinal}`);
    lines.push(`    persona: ${cell.persona}`);
    lines.push(`    mode: ${cell.mode}`);
    if (cell.name !== undefined) lines.push(`    name: ${cell.name}`);
    if (cell.playbook !== undefined) lines.push(`    playbook: ${cell.playbook}`);
    lines.push(`    goal: ${yamlQuote(cell.goal)}`);
    lines.push(`    reads: [${cell.reads.join(", ")}]`);
    if (cell.paths !== undefined && cell.paths.length > 0) {
      lines.push(`    paths: [${cell.paths.map(yamlQuote).join(", ")}]`);
    }
    if (cell.review === true) lines.push(`    review: true`);
    if (cell.triad === true) lines.push(`    triad: true`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Build the ordered cells of a preset. Recon is always cell 1 (reads nothing),
 * each middle sweep reads recon [1], and verify is the last cell (reads every
 * prior ordinal, `review: true`). When `opts.paths` is set, the include globs
 * scope only the middle sweeps — recon and verify stay repo-wide.
 *
 * Each middle sweep carries `triad: true`: at `startEngagement` `expandTriads`
 * replaces it with three cells (architect → worker → verifier). The preset
 * plan itself stays compact (one cell per phase); the expansion is the
 * materialization step. Recon and the final verify stay single cells.
 */
function buildPresetCells(sweeps: SweepDef[], opts?: { paths?: string[]; report?: boolean }): PlanCell[] {
  const paths = opts?.paths && opts.paths.length > 0 ? opts.paths : undefined;
  const cells: PlanCell[] = [];

  cells.push({ ordinal: 1, persona: CODE_REVIEW_PERSONA, mode: "fresh", ...RECON, reads: [] });

  sweeps.forEach((sweep, i) => {
    const { persona: sweepPersona, triad: sweepTriad, ...sweepFields } = sweep;
    // A middle sweep expands as an architect → worker → verifier triad (M-P2b)
    // unless it opts out (a model-only sweep — threat-model, attack-tree — runs
    // as a single cell). `startEngagement` expands a triad cell into three cells
    // at materialization; recon (cell 1) and verify (the last cell) stay single.
    const isTriad = sweepTriad ?? true;
    cells.push({
      ordinal: i + 2,
      persona: sweepPersona ?? CODE_REVIEW_PERSONA,
      mode: "fresh",
      ...sweepFields,
      reads: [1],
      ...(paths ? { paths } : {}),
      ...(isTriad ? { triad: true } : {}),
    });
  });

  const verifyOrdinal = sweeps.length + 2;
  cells.push({
    ordinal: verifyOrdinal,
    persona: CODE_REVIEW_PERSONA,
    mode: "fresh",
    ...VERIFY,
    reads: Array.from({ length: verifyOrdinal - 1 }, (_, i) => i + 1),
    review: true,
  });

  // The report cell (M-P3) runs as the FINAL cell, after verify. It reads every
  // prior ordinal (including verify) so it composes over the whole engagement.
  // `review: false` and never a triad — it writes the report artifact, it does
  // not flip finding statuses. The middle-sweep path globs never reach it:
  // report reads the tree, not the clone.
  if (opts?.report) {
    const reportOrdinal = verifyOrdinal + 1;
    const { persona: reportPersona, triad: _reportTriad, ...reportFields } = REPORT;
    cells.push({
      ordinal: reportOrdinal,
      persona: reportPersona ?? REPORT_PERSONA,
      mode: "fresh",
      ...reportFields,
      reads: Array.from({ length: reportOrdinal - 1 }, (_, i) => i + 1),
    });
  }

  return cells;
}

/**
 * Build the ordered cells of a re-scan plan (re-scan v2): recon (cell 1) →
 * reconcile (cell 2) → the diff-scoped sweeps → verify → report (when the base
 * preset has one). This is the incremental algorithm:
 *   - recon reads `/prior/recon.md` and `/prior/diff.md` and updates the map for
 *     the changed files only;
 *   - reconcile reads `/prior/findings.md` and the carried findings and rules
 *     each carried finding fixed or recurring;
 *   - the sweeps sweep the changed code for NEW vulnerabilities (the service
 *     scopes them to the changed dirs at start);
 *   - verify attacks every open finding; report (optional) writes the artifact.
 *
 * The sweeps are the base preset's middle sweeps (so a re-scan of a
 * `code-review` review runs authz / injection / secrets-config), each carrying
 * `triad: true` and reading recon. Recon, reconcile, and verify stay repo-wide;
 * the service's diff scoping targets only the sweep cells. Every returned string
 * round-trips through `parsePlan`.
 */
function buildRescanCells(sweeps: SweepDef[], opts?: { report?: boolean }): PlanCell[] {
  const cells: PlanCell[] = [];

  // Cell 1: recon (reads nothing). Reads /prior/recon.md + /prior/diff.md.
  cells.push({ ordinal: 1, persona: CODE_REVIEW_PERSONA, mode: "fresh", ...RECON, reads: [] });

  // Cell 2: reconcile (reads recon). Single cell, repo-wide, reports nothing new.
  const { persona: reconcilePersona, triad: _reconcileTriad, ...reconcileFields } = RECONCILE;
  cells.push({
    ordinal: 2,
    persona: reconcilePersona ?? RECONCILE_PERSONA,
    mode: "fresh",
    ...reconcileFields,
    reads: [1],
  });

  // The diff-scoped sweeps: the base preset's middle sweeps, each reading recon.
  sweeps.forEach((sweep, i) => {
    const { persona: sweepPersona, triad: sweepTriad, ...sweepFields } = sweep;
    const isTriad = sweepTriad ?? true;
    cells.push({
      ordinal: i + 3,
      persona: sweepPersona ?? CODE_REVIEW_PERSONA,
      mode: "fresh",
      ...sweepFields,
      reads: [1],
      ...(isTriad ? { triad: true } : {}),
    });
  });

  // Verify: attacks every open finding, reads every prior ordinal.
  const verifyOrdinal = sweeps.length + 3;
  cells.push({
    ordinal: verifyOrdinal,
    persona: CODE_REVIEW_PERSONA,
    mode: "fresh",
    ...VERIFY,
    reads: Array.from({ length: verifyOrdinal - 1 }, (_, i) => i + 1),
    review: true,
  });

  // Report (optional): reads every prior ordinal including verify.
  if (opts?.report) {
    const reportOrdinal = verifyOrdinal + 1;
    const { persona: reportPersona, triad: _reportTriad, ...reportFields } = REPORT;
    cells.push({
      ordinal: reportOrdinal,
      persona: reportPersona ?? REPORT_PERSONA,
      mode: "fresh",
      ...reportFields,
      reads: Array.from({ length: reportOrdinal - 1 }, (_, i) => i + 1),
    });
  }

  return cells;
}

/**
 * The re-scan plan YAML for a base preset id (re-scan v2). Throws on an unknown
 * id. The plan is recon → reconcile → the base preset's sweeps → verify →
 * report (when the base preset has one). The service seeds a re-scan
 * engagement's plan from this instead of reusing the parent's flat plan, so a
 * re-scan runs the reconcile pass over the carried findings. Round-trips through
 * `parsePlan`.
 */
export function rescanPlan(id: string, opts?: { includeReport?: boolean }): string {
  const sweeps = PRESET_SWEEPS[id];
  if (sweeps === undefined) {
    const known = SECURITY_PRESETS.map((p) => p.id).join(", ");
    throw new Error(`Unknown security preset "${id}". Known presets: ${known}.`);
  }
  const includeReport = opts?.includeReport ?? presetReportDefault(id);
  return serializePlan(buildRescanCells(sweeps, { report: includeReport }));
}

/**
 * The plan YAML for a preset id. Throws on an unknown id. Without paths, the
 * `code-review` case delegates to `codeReviewPresetPlan` (the exact string the
 * create route and existing tests expect). With `opts.paths`, the globs scope
 * the middle sweeps (authz, injection, secrets-config); recon and verify stay
 * repo-wide. Every returned string round-trips through `parsePlan`.
 */
export function presetPlan(
  id: string,
  opts?: { paths?: string[]; includeReport?: boolean },
): string {
  const sweeps = PRESET_SWEEPS[id];
  if (sweeps === undefined) {
    const known = SECURITY_PRESETS.map((p) => p.id).join(", ");
    throw new Error(`Unknown security preset "${id}". Known presets: ${known}.`);
  }
  const hasPaths = opts?.paths && opts.paths.length > 0;
  const includeReport = opts?.includeReport ?? presetReportDefault(id);
  // codeReviewPresetPlan is the byte-identical seed for the `code-review`
  // preset when no paths override and the default report choice holds. Any
  // deviation goes through buildPresetCells so the plan text reflects the
  // user's choice.
  if (id === "code-review" && !hasPaths && includeReport) return codeReviewPresetPlan();
  return serializePlan(
    buildPresetCells(sweeps, {
      ...(opts?.paths ? { paths: opts.paths } : {}),
      report: includeReport,
    }),
  );
}
