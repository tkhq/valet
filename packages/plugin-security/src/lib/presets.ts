import { bundledPersonaIds, CODE_REVIEW_PERSONA } from "./personas.js";
import type { PlanCell } from "./plan.js";

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
 * needs to start it: read the plan, fold in any focus notes, then open the
 * `sec_start` approval gate — that gate is the human checkpoint before any
 * spend, so kicking straight to it is safe.
 */
export function securityKickoffPrompt(repoFullName: string, focusNotes?: string): string {
  const notes = focusNotes?.trim();
  const focusLine = notes
    ? `\n\nFocus notes from the user (fold these into the plan before you start):\n${notes}`
    : "";
  return (
    `Begin the security review of ${repoFullName}. ` +
    `Call sec_status to read the engagement plan, summarize the cells for me, ` +
    `adjust the plan with sec_plan_set if the focus notes call for it, ` +
    `then call sec_start to request approval and run the engagement loop.` +
    focusLine
  );
}

export function codeReviewPresetPlan(): string {
  return `cells:
  - ordinal: 1
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: recon
    playbook: recon
    goal: Map the codebase, seed the checklist from the file inventory, note trust boundaries
    reads: []
  - ordinal: 2
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: authz-sweep
    playbook: authz
    goal: Sweep authorization on every route, mutation, and trust boundary from the recon map
    reads: [1]
  - ordinal: 3
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: injection-sweep
    playbook: injection
    goal: Sweep injection paths across SQL, command, template, path, and deserialization sinks
    reads: [1]
  - ordinal: 4
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: secrets-config
    playbook: secrets-config
    goal: Run the pre-baked scanners (gitleaks) and any repo-local scanners, triage their output, sweep secrets and config
    reads: [1]
  - ordinal: 5
    persona: ${CODE_REVIEW_PERSONA}
    mode: fresh
    name: verify
    playbook: verify
    goal: Attack every open finding, sec_finding_review each, refute what does not survive
    reads: [1, 2, 3, 4]
    review: true
`;
}

/** One sweep the presets compose from: a stable name, playbook, and goal.
 * Recon and verify bookend every preset; the middle sweeps vary. */
interface SweepDef {
  name: string;
  playbook: string;
  goal: string;
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

/** The middle sweeps of each preset, in order. Recon (cell 1) and verify (last
 * cell) bookend every preset and are added by `buildPresetCells`. */
const PRESET_SWEEPS: Record<string, SweepDef[]> = {
  "code-review": [AUTHZ, INJECTION, SECRETS_CONFIG],
  "secrets-config": [SECRETS_CONFIG],
  "access-injection": [AUTHZ, INJECTION],
};

/**
 * Escape a scalar for a YAML double-quoted string. Goals and paths are plain
 * text, so only the backslash and the double quote need escaping.
 */
function yamlQuote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
  }
  return lines.join("\n") + "\n";
}

/**
 * Build the ordered cells of a preset. Recon is always cell 1 (reads nothing),
 * each middle sweep reads recon [1], and verify is the last cell (reads every
 * prior ordinal, `review: true`). When `opts.paths` is set, the include globs
 * scope only the middle sweeps — recon and verify stay repo-wide.
 */
function buildPresetCells(sweeps: SweepDef[], opts?: { paths?: string[] }): PlanCell[] {
  const paths = opts?.paths && opts.paths.length > 0 ? opts.paths : undefined;
  const cells: PlanCell[] = [];

  cells.push({ ordinal: 1, persona: CODE_REVIEW_PERSONA, mode: "fresh", ...RECON, reads: [] });

  sweeps.forEach((sweep, i) => {
    cells.push({
      ordinal: i + 2,
      persona: CODE_REVIEW_PERSONA,
      mode: "fresh",
      ...sweep,
      reads: [1],
      ...(paths ? { paths } : {}),
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

  return cells;
}

/**
 * The plan YAML for a preset id. Throws on an unknown id. Without paths, the
 * `code-review` case delegates to `codeReviewPresetPlan` (the exact string the
 * create route and existing tests expect). With `opts.paths`, the globs scope
 * the middle sweeps (authz, injection, secrets-config); recon and verify stay
 * repo-wide. Every returned string round-trips through `parsePlan`.
 */
export function presetPlan(id: string, opts?: { paths?: string[] }): string {
  const sweeps = PRESET_SWEEPS[id];
  if (sweeps === undefined) {
    const known = SECURITY_PRESETS.map((p) => p.id).join(", ");
    throw new Error(`Unknown security preset "${id}". Known presets: ${known}.`);
  }
  const hasPaths = opts?.paths && opts.paths.length > 0;
  if (id === "code-review" && !hasPaths) return codeReviewPresetPlan();
  return serializePlan(buildPresetCells(sweeps, opts));
}
