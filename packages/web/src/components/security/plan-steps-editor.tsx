import type { SecurityPlanCellInput, SecurityPlanCellWire } from "@valet/api/wire";
import { Button, Input, Label } from "~/components/primitives";

/**
 * The controlled review-plan step editor (value + onChange, no data fetching or
 * mutation). The setup page (`/security/new`) owns the draft state and posts it
 * on create. The server is the real gate: it assigns dense ordinals in array
 * order, validates personas and playbooks, and expands triads at start.
 *
 * The persona and playbook lists mirror the bundled registries. A repo-declared
 * persona that a preview seeded still round-trips, because it arrives on the
 * step draft and stays selectable.
 */

/** A persona kind groups the dropdown. See Part 08 §Persona kinds
 * (docs/specs/valet-security/spec/08-ux-flow.md). */
export type PersonaKind = "source" | "live" | "coordination" | "deliverable";

/** Bundled personas, mirrored from plugin-security's `BUNDLED_PERSONAS`. The id
 * feeds the plan; the label shows in the picker; the kind groups the dropdown;
 * `deterministic` flags scanner-driven and pure-decision personas so the
 * editor can badge them with a "D" chip (Part 08 §Persona kinds).
 * The server validates against the real registry ∪ the repo's config personas.
 * Keep this list in sync with `packages/plugin-security/src/lib/personas.ts`. */
export const BUNDLED_PERSONAS: readonly {
  id: string;
  label: string;
  kind: PersonaKind;
  deterministic: boolean;
}[] = [
  // Source-only: reads the clone. No scope required.
  { id: "code-review", label: "Code review", kind: "source", deterministic: false },
  { id: "sast", label: "SAST", kind: "source", deterministic: true },
  { id: "threat-model", label: "Threat model", kind: "source", deterministic: false },
  { id: "attack-tree", label: "Attack tree", kind: "source", deterministic: false },
  // Live: reaches an authorized target. Setup wizard blocks submit if scope is empty.
  { id: "dast", label: "DAST", kind: "live", deterministic: true },
  { id: "fuzz", label: "Fuzz", kind: "live", deterministic: true },
  { id: "exploit", label: "Exploit", kind: "live", deterministic: false },
  // Coordination: attached by other cells' plans; rarely end-user-authored.
  { id: "architect", label: "Architect", kind: "coordination", deterministic: false },
  { id: "verifier", label: "Verifier", kind: "coordination", deterministic: false },
  { id: "pivot-coordinator", label: "Pivot coordinator", kind: "coordination", deterministic: true },
  // Deliverable: terminal cells.
  { id: "report", label: "Report", kind: "deliverable", deterministic: false },
  { id: "reconcile", label: "Reconcile", kind: "deliverable", deterministic: false },
];

/** Look up a persona's deterministic flag by id. Returns false for an id
 * that is not in the bundled list (a repo-declared persona; the server has
 * no marker for it, so the safe default is model-driven). */
export function isPersonaDeterministic(id: string): boolean {
  return BUNDLED_PERSONAS.find((p) => p.id === id)?.deterministic === true;
}

/** The bundled persona ids, for membership checks. */
const BUNDLED_PERSONA_IDS: readonly string[] = BUNDLED_PERSONAS.map((p) => p.id);

/** The live persona ids. When a plan carries any of these, the setup wizard
 * MUST require an authorized scope. See Part 08 §Persona kinds. */
export const LIVE_PERSONA_IDS: readonly string[] = BUNDLED_PERSONAS.filter(
  (p) => p.kind === "live",
).map((p) => p.id);

/** True when a plan draft carries any live persona (`dast`, `fuzz`, `exploit`).
 * The setup wizard uses this to gate the authorized-scope form. */
export function planHasLivePersona(steps: readonly { persona: string }[]): boolean {
  return steps.some((s) => LIVE_PERSONA_IDS.includes(s.persona));
}

/** The dropdown groups. Each group renders under an `<optgroup>`. */
const PERSONA_KIND_LABELS: Record<PersonaKind, string> = {
  source: "Source-only (reads the clone)",
  live: "Live (needs authorized scope)",
  coordination: "Coordination",
  deliverable: "Deliverable",
};

const PERSONA_KIND_ORDER: readonly PersonaKind[] = [
  "source",
  "live",
  "coordination",
  "deliverable",
];

/** Known playbook ids, mirrored from plugin-security's `KNOWN_PLAYBOOKS`. The
 * server is the real gate; this only populates the optional picker. Keep in
 * step with `packages/plugin-security/src/lib/playbooks.ts`. */
const KNOWN_PLAYBOOKS: readonly string[] = [
  "recon",
  "authz",
  "injection",
  "secrets-config",
  "verify",
  "threat-model",
  "attack-tree",
  "sast",
  "report",
  "dast",
  "fuzz",
  "exploit",
  "reconcile",
  "pivot-coordinator",
];

/** The at-most step count the plan allows (mirrors `MAX_PLAN_CELLS`). */
export const MAX_STEPS = 32;

/** The editor's per-step draft. `pathsText` is the raw comma/space text the
 * user types; it is split on save. `reads` holds earlier step indexes (0-based
 * in the draft, mapped to 1-based ordinals on save). */
export interface StepDraft {
  /** Stable id so a mapped row keeps its state across reorders (mount-time
   * state rule: key by id, never array index). */
  key: string;
  persona: string;
  name: string;
  goal: string;
  playbook: string;
  pathsText: string;
  /** Indexes (0-based) of earlier steps this step reads. */
  reads: number[];
  review: boolean;
  /** Run this phase as an architect → worker → verifier triad. */
  triad: boolean;
}

let keySeq = 0;
function nextKey(): string {
  keySeq += 1;
  return `step-${keySeq}`;
}

/** Map one wire step to an editable draft. */
export function wireToDraft(cell: SecurityPlanCellWire): StepDraft {
  return {
    key: nextKey(),
    persona: cell.persona,
    name: cell.name ?? "",
    goal: cell.goal,
    playbook: cell.playbook ?? "",
    pathsText: (cell.paths ?? []).join(", "),
    // Ordinals are 1-based and dense, so ordinal N maps to draft index N-1.
    reads: cell.reads.map((ord) => ord - 1).filter((i) => i >= 0),
    review: cell.review,
    triad: cell.triad === true,
  };
}

/** A fresh empty draft for the "Add step" action. */
export function emptyDraft(): StepDraft {
  return {
    key: nextKey(),
    persona: BUNDLED_PERSONA_IDS[0],
    name: "",
    goal: "",
    playbook: "",
    pathsText: "",
    reads: [],
    review: false,
    triad: false,
  };
}

/** Split the raw paths text on commas or whitespace, dropping empties. */
function splitPaths(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
}

/** The client-side validation mirror (the server is the real gate): a step's
 * `reads` name only earlier steps, and every step needs a goal. Returns the
 * first message, or null when the draft is valid. */
export function draftError(steps: StepDraft[]): string | null {
  if (steps.length === 0) return "Add at least one step.";
  if (steps.length > MAX_STEPS) return `A plan has at most ${MAX_STEPS} steps.`;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.goal.trim() === "") return `Step ${i + 1} needs a goal.`;
    for (const read of step.reads) {
      if (read >= i) return `Step ${i + 1} may read earlier steps only.`;
    }
  }
  return null;
}

/** Convert the drafts to the structured wire input the create route accepts.
 * Drops `reads` that no longer point at an earlier step after a reorder. */
export function draftToInput(steps: StepDraft[]): SecurityPlanCellInput[] {
  return steps.map((step, i) => {
    const paths = splitPaths(step.pathsText);
    // reads are 0-based draft indexes; the server wants 1-based ordinals, and
    // only earlier ones survive.
    const reads = step.reads.filter((r) => r < i).map((r) => r + 1);
    const input: SecurityPlanCellInput = {
      persona: step.persona,
      goal: step.goal.trim(),
      reads,
    };
    if (step.name.trim() !== "") input.name = step.name.trim();
    if (step.playbook !== "") input.playbook = step.playbook;
    if (paths.length > 0) input.paths = paths;
    if (step.review) input.review = true;
    if (step.triad) input.triad = true;
    return input;
  });
}

/** The controlled step-list editor. The parent owns `value` and applies every
 * `onChange`; this component holds no state and fetches nothing. */
export function PlanStepsEditor({
  value,
  onChange,
}: {
  value: StepDraft[];
  onChange: (next: StepDraft[]) => void;
}) {
  function updateStep(index: number, patch: Partial<StepDraft>) {
    onChange(value.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  function addStep() {
    onChange([...value, emptyDraft()]);
  }

  function removeStep(index: number) {
    // Drop the step, then renumber every read that pointed past it: a read
    // index above the removed one shifts down by one, and a read OF the
    // removed step is dropped.
    const next = value
      .filter((_, i) => i !== index)
      .map((step) => ({
        ...step,
        reads: step.reads.filter((r) => r !== index).map((r) => (r > index ? r - 1 : r)),
      }));
    onChange(next);
  }

  function move(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target], next[index]];
    // A reorder can invalidate reads (a read must name an earlier step). Drop
    // any read that no longer points at an earlier index; the server would
    // reject it anyway.
    const cleaned = next.map((step, i) => ({
      ...step,
      reads: step.reads.filter((r) => r < i),
    }));
    onChange(cleaned);
  }

  const error = draftError(value);

  return (
    <div data-testid="plan-steps-editor">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-ink">Plan</h3>
        <span className="text-[11px] text-muted">
          {value.length} step{value.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted">
        Edit the review steps. The plan freezes when the review starts.
      </p>

      <div className="mt-3 flex flex-col gap-3">
        {value.map((step, index) => (
          <StepRow
            key={step.key}
            index={index}
            step={step}
            stepCount={value.length}
            onChange={(patch) => updateStep(index, patch)}
            onRemove={() => removeStep(index)}
            onMoveUp={() => move(index, -1)}
            onMoveDown={() => move(index, 1)}
          />
        ))}
      </div>

      <div className="mt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={addStep}
          disabled={value.length >= MAX_STEPS}
        >
          Add step
        </Button>
      </div>

      {error && (
        <p className="mt-2 text-[11px] text-danger-600" data-testid="plan-error">
          {error}
        </p>
      )}
    </div>
  );
}

function StepRow({
  index,
  step,
  stepCount,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  index: number;
  step: StepDraft;
  stepCount: number;
  onChange: (patch: Partial<StepDraft>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const selectClass = "h-8 rounded border border-line bg-paper px-2 text-xs text-ink";
  return (
    <div className="rounded border border-line p-2" data-testid="plan-step">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted">Step {index + 1}</span>
          {isPersonaDeterministic(step.persona) && (
            <span
              className="rounded bg-moss-500/15 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-moss-600"
              title="Deterministic persona: scanner-driven or pure L0 decision. Two runs on the same input produce the same result."
              data-testid={`step-deterministic-${index}`}
            >
              D
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onMoveUp}
            disabled={index === 0}
            aria-label={`Move step ${index + 1} up`}
          >
            ↑
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onMoveDown}
            disabled={index === stepCount - 1}
            aria-label={`Move step ${index + 1} down`}
          >
            ↓
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRemove}
            aria-label={`Remove step ${index + 1}`}
          >
            Remove
          </Button>
        </div>
      </div>

      <div className="mt-2 grid gap-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`${step.key}-persona`}>Persona</Label>
            <select
              id={`${step.key}-persona`}
              value={step.persona}
              onChange={(e) => onChange({ persona: e.target.value })}
              className={selectClass}
            >
              {/* A repo-declared persona already on the step stays selectable
                  even though it is not in the bundled list. */}
              {!BUNDLED_PERSONA_IDS.includes(step.persona) && (
                <option value={step.persona}>{step.persona}</option>
              )}
              {/* Bundled personas group by kind so a user reading top-to-bottom
                  sees the shape of a pentest (Part 08 §Persona kinds). A "D · "
                  prefix in the option marks a deterministic persona (scanner
                  or L0 decision), so the user can spot the reproducible steps
                  at a glance in the dropdown itself. */}
              {PERSONA_KIND_ORDER.map((kind) => {
                const personas = BUNDLED_PERSONAS.filter((p) => p.kind === kind);
                if (personas.length === 0) return null;
                return (
                  <optgroup key={kind} label={PERSONA_KIND_LABELS[kind]}>
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.deterministic ? `D · ${p.label}` : p.label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${step.key}-playbook`}>Playbook (optional)</Label>
            <select
              id={`${step.key}-playbook`}
              value={step.playbook}
              onChange={(e) => onChange({ playbook: e.target.value })}
              className={selectClass}
            >
              <option value="">None</option>
              {KNOWN_PLAYBOOKS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-1">
          <Label htmlFor={`${step.key}-name`}>Name (optional)</Label>
          <Input
            id={`${step.key}-name`}
            value={step.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. authz-sweep"
            className="h-8 text-xs"
          />
        </div>

        <div className="grid gap-1">
          <Label htmlFor={`${step.key}-goal`}>Goal</Label>
          <textarea
            id={`${step.key}-goal`}
            value={step.goal}
            onChange={(e) => onChange({ goal: e.target.value })}
            placeholder="What this step must accomplish"
            className="min-h-[3rem] rounded border border-line bg-paper px-2 py-1 text-xs text-ink"
          />
        </div>

        <div className="grid gap-1">
          <Label htmlFor={`${step.key}-paths`}>Paths (optional)</Label>
          <Input
            id={`${step.key}-paths`}
            value={step.pathsText}
            onChange={(e) => onChange({ pathsText: e.target.value })}
            placeholder="e.g. packages/api, src/auth"
            className="h-8 text-xs"
          />
        </div>

        {index > 0 && (
          <div className="grid gap-1">
            <span className="text-xs text-muted">Reads earlier steps</span>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: index }, (_, earlier) => (
                <label key={earlier} className="inline-flex items-center gap-1 text-[11px] text-ink">
                  <input
                    type="checkbox"
                    checked={step.reads.includes(earlier)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...step.reads, earlier]
                        : step.reads.filter((r) => r !== earlier);
                      onChange({ reads: next });
                    }}
                  />
                  Step {earlier + 1}
                </label>
              ))}
            </div>
          </div>
        )}

        <label className="inline-flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={step.triad}
            onChange={(e) => onChange({ triad: e.target.checked })}
          />
          Run as architect → worker → verifier triad
        </label>

        <label className="inline-flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={step.review}
            onChange={(e) => onChange({ review: e.target.checked })}
          />
          Review step (may verify or refute findings)
        </label>
      </div>
    </div>
  );
}
