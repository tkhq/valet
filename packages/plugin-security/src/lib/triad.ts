import { ARCHITECT_PERSONA, VERIFIER_PERSONA } from "./personas.js";
import { NAME_MAX, type PlanCell } from "./plan.js";

/** The longest suffix a triad sibling appends to the base name (`-verify`).
 * The base is capped so every derived name (`${base}-verify`) stays within
 * NAME_MAX — parsePlan enforces the same limit on read-back. */
const TRIAD_SUFFIX_MAX = "-verify".length;

/** Cap a triad's base name so `${base}-plan` and `${base}-verify` both fit
 * within NAME_MAX. Trims a trailing hyphen the slice may leave. */
function triadBase(name: string | undefined): string {
  const base = name ?? "phase";
  const cap = NAME_MAX - TRIAD_SUFFIX_MAX;
  return base.length <= cap ? base : base.slice(0, cap).replace(/-+$/, "");
}

/**
 * Expand every `triad: true` phase cell into an architect → worker → verifier
 * triad (M-P2b, spec §Architect / worker / verifier triad). The reference
 * harness runs each phase as three cells: an architect plans and seeds a
 * falsifiable checklist, the worker executes it, and an independent verifier
 * re-derives the findings and gates PASS/CONDITIONAL/FAIL. This is the
 * reference's core quality mechanism.
 *
 * A phase cell with `triad: true` becomes three ordered cells:
 *   - `<name>-plan`   — persona `architect`; reads = the phase's original reads.
 *   - `<name>`        — the phase's own persona (the worker); reads = the
 *                       architect's new ordinal ∪ the original reads; carries
 *                       the phase's playbook, paths, mode, and goal.
 *   - `<name>-verify` — persona `verifier`, `review: true`; reads = the worker's
 *                       new ordinal, so it audits the worker (and, through it,
 *                       the architect's plan).
 *
 * The architect and verifier inherit the phase goal + playbook context, so they
 * plan and audit against the same framework the worker sweeps under. A non-triad
 * cell (recon, a final engagement verify) passes through unchanged.
 *
 * Ordinals are renumbered densely 1..N over the whole expanded plan, and every
 * `reads` edge is remapped from the OLD ordinal to the surviving cell's NEW
 * ordinal — a triad's original ordinal maps to its WORKER (the cell that does
 * the phase's work), so a later cell that read the phase still reads its output,
 * not the architect's plan. The result is a valid plan: dense ordinals,
 * earlier-only reads, no `triad` flags left.
 */
export function expandTriads(cells: PlanCell[]): PlanCell[] {
  // One emitted cell before its ordinal and reads are finalized. `oldReads`
  // are the source plan's ordinals (remapped in the second pass); `newReads`
  // are already-assigned NEW ordinals from this expansion (an architect or
  // worker ordinal), appended verbatim.
  interface Pending {
    cell: Omit<PlanCell, "ordinal" | "reads">;
    oldReads: number[];
    newReads: number[];
  }
  const pending: Pending[] = [];
  // OLD ordinal → the NEW ordinal a later `reads` edge to it resolves to.
  const remap = new Map<number, number>();

  let nextOrdinal = 1;
  for (const cell of cells) {
    if (cell.triad !== true) {
      const newOrdinal = nextOrdinal++;
      remap.set(cell.ordinal, newOrdinal);
      const { triad: _t, reads, ordinal: _o, ...rest } = cell;
      pending.push({ cell: { ...rest }, oldReads: reads, newReads: [] });
      continue;
    }

    // Triad phase → architect, worker, verifier. The worker keeps the phase's
    // persona, playbook, paths, mode, and goal. A triad phase needs a stable
    // base name for the -plan / -verify siblings; fall back to "phase" when the
    // phase cell has no explicit name.
    const base = triadBase(cell.name);
    const architectOrdinal = nextOrdinal++;
    const workerOrdinal = nextOrdinal++;
    nextOrdinal++; // verifier ordinal (assigned by position below)
    // A later cell that read this phase reads the WORKER's output.
    remap.set(cell.ordinal, workerOrdinal);

    const { triad: _t, reads, ordinal: _o, name: _n, persona, review: _r, ...shared } = cell;

    // Architect: plans the phase; reads the phase's original predecessors.
    pending.push({
      cell: { ...shared, persona: ARCHITECT_PERSONA, name: `${base}-plan`, goal: `Plan this phase: ${cell.goal}` },
      oldReads: reads,
      newReads: [],
    });
    // Worker: the phase's own persona; reads the architect (a new ordinal) plus
    // the phase's original predecessors (old ordinals, remapped later).
    pending.push({
      cell: { ...shared, persona, name: base, goal: cell.goal },
      oldReads: reads,
      newReads: [architectOrdinal],
    });
    // Verifier: audits the worker; reads only the worker (a new ordinal).
    pending.push({
      cell: {
        ...shared,
        persona: VERIFIER_PERSONA,
        name: `${base}-verify`,
        goal: `Verify this phase: ${cell.goal}`,
        review: true,
      },
      oldReads: [],
      newReads: [workerOrdinal],
    });
  }

  // Second pass: assign dense ordinals and remap every `reads` edge.
  return pending.map((p, index) => {
    const ordinal = index + 1;
    const remapped = p.oldReads.map((old) => {
      const to = remap.get(old);
      if (to === undefined) {
        // parsePlan already rejects a reads edge to a missing ordinal; guard
        // for the type only.
        throw new Error(`expandTriads: reads ordinal ${old} has no mapping.`);
      }
      return to;
    });
    const reads = [...new Set([...remapped, ...p.newReads])].sort((a, b) => a - b);
    return { ordinal, reads, ...p.cell };
  });
}

/** True when any cell in the plan declares a triad phase. */
export function hasTriad(cells: PlanCell[]): boolean {
  return cells.some((c) => c.triad === true);
}
