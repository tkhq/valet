/**
 * AutomationWizard — one flow for the three creation surfaces that used to be
 * separate: an event subscription, a workflow event trigger, and a schedule.
 *
 * Four steps:
 *  1. When   — on an event, or on a schedule.
 *  2. Match  — event: pick one or more keys, then friendly filters.
 *              schedule: a cron expression and a timezone.
 *  3. Then   — notify an assistant (yours / a team's / the org's), or run a
 *              workflow.
 *  4. Review — a plain-language sentence built from the choices, using names
 *              not ids, and a Create button.
 *
 * On submit the wizard writes to the existing store for the branch:
 *  - event + assistant  → POST /api/event-subscriptions (orchestrator target)
 *  - event + workflow    → POST /api/event-subscriptions (workflow target)
 *  - schedule            → POST /api/workflows/schedules
 *
 * The event branch always uses the subscription store, for both target kinds,
 * so one event rule has one home. The subscription target already carries a
 * workflow kind (`EventSubscriptionTargetWire`), so a workflow-targeted event
 * rule needs no separate event-trigger endpoint.
 */
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  ErrorRow,
  Input,
  Label,
  LoadingRow,
} from "~/components/primitives";
import {
  FilterEditor,
  incompleteFilterRow,
  pruneFilterRows,
  toWireFilters,
  type FilterField,
  type UiFilterRow,
} from "~/components/events/filter-editor";
import { useCreateEventSubscription, useEventCatalog } from "~/api/events";
import { useCreateSchedule, useWorkflows } from "~/api/workflows";
import { useTeams } from "~/api/settings";
import { errorText } from "~/lib/error-text";
import { useActiveWorkspace } from "~/components/workspace-clause";

type When = "event" | "schedule";

type TargetChoice =
  | { kind: "orchestrator"; orchestrator: "user" | "org" }
  | { kind: "orchestrator"; orchestrator: "team"; teamId: string }
  | { kind: "workflow"; workflowId: string };

type Step = 1 | 2 | 3 | 4;

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The wizard's first target: the active workspace's assistant. The store
 * stamps the owner off the target, so this is how a rule is born in the
 * workspace the switcher names. */
function initialTarget(scopedTeamId: string | undefined): TargetChoice {
  return scopedTeamId !== undefined
    ? { kind: "orchestrator", orchestrator: "team", teamId: scopedTeamId }
    : { kind: "orchestrator", orchestrator: "user" };
}

export function AutomationWizard({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const catalogQ = useEventCatalog();
  const workflowsQ = useWorkflows();
  const createSubscription = useCreateEventSubscription();
  const createSchedule = useCreateSchedule();
  const ws = useActiveWorkspace();
  const teamsQ = useTeams();
  const scopedTeam = ws?.kind === "team" ? ws.team : undefined;
  const scopedTeamId = scopedTeam?.id;

  // Computed once, at mount. The panel mounts this wizard only while open, so
  // mount time is open time — nothing rewrites the target afterwards.
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [when, setWhen] = useState<When>("event");
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [filterRows, setFilterRows] = useState<UiFilterRow[]>([]);
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone());
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState<TargetChoice>(() => initialTarget(scopedTeamId));
  const [error, setError] = useState<string | null>(null);

  const workflows = workflowsQ.data?.workflows ?? [];
  const services = catalogQ.data?.services ?? [];
  const teams = teamsQ.data?.teams ?? [];

  const isPending = createSubscription.isPending || createSchedule.isPending;

  // Filter fields the selected events declare, unioned and deduped by field —
  // a filter is valid when any selected event declares it (the same rule the
  // server's validateSubscription applies).
  function unionFilterFields(selected: Set<string>): FilterField[] {
    const out: FilterField[] = [];
    const seen = new Set<string>();
    for (const s of services) {
      for (const entry of s.entries) {
        if (!selected.has(entry.key)) continue;
        for (const f of entry.filters ?? []) {
          if (seen.has(f.field)) continue;
          seen.add(f.field);
          out.push({ field: f.field, description: f.description, options: f.options });
        }
      }
    }
    return out;
  }
  const filterFields = unionFilterFields(keys);

  function toggleKey(key: string) {
    const next = new Set(keys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setKeys(next);
    // Drop filters whose field none of the now-selected events declare, so an
    // orphaned filter cannot 400 on submit.
    setFilterRows((rows) => pruneFilterRows(rows, unionFilterFields(next)));
  }

  const workflowChosen = target.kind === "workflow" && target.workflowId.length > 0;
  const targetReady = target.kind === "orchestrator" || workflowChosen;

  // Which step the reader is on decides whether Next is allowed. Each gate
  // matches what the step collects, so the reader cannot skip an empty field.
  function canAdvance(): boolean {
    if (step === 1) return true; // `when` always has a value.
    if (step === 2) {
      return when === "event" ? keys.size > 0 : cron.trim().length > 0;
    }
    if (step === 3) return targetReady;
    return true;
  }

  const canCreate = name.trim().length > 0 && targetReady && !isPending;

  function next() {
    setError(null);
    setStep((s) => (Math.min(s + 1, 4) as Step));
  }
  function back() {
    setError(null);
    setStep((s) => (Math.max(s - 1, 1) as Step));
  }

  function submit() {
    if (!canCreate) return;
    setError(null);

    if (when === "event") {
      const incomplete = incompleteFilterRow(filterRows);
      if (incomplete) {
        setError(`Enter a value for the "${incomplete}" filter, or remove the row.`);
        return;
      }
      createSubscription.mutate(
        {
          name: name.trim(),
          eventKeys: [...keys],
          filters: toWireFilters(filterRows),
          target,
        },
        {
          onSuccess: () => onOpenChange(false),
          onError: (err) => setError(errorText(err)),
        },
      );
      return;
    }

    // Schedule branch. The schedule store takes a workflow OR an orchestrator
    // prompt target — the same two kinds the Then step offers.
    const base = { name: name.trim(), cron: cron.trim(), timezone: timezone.trim() };
    if (target.kind === "workflow") {
      createSchedule.mutate(
        { ...base, target: { kind: "workflow", workflowId: target.workflowId } },
        {
          onSuccess: () => onOpenChange(false),
          onError: (err) => setError(errorText(err)),
        },
      );
    } else {
      createSchedule.mutate(
        { ...base, target: { kind: "orchestrator", prompt: prompt.trim() } },
        {
          onSuccess: () => onOpenChange(false),
          onError: (err) => setError(errorText(err)),
        },
      );
    }
  }

  // No reset machinery: closing unmounts the wizard, so the next open starts
  // from a fresh mount.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New automation"
        description="Set up an event rule or a schedule in one flow."
        className="max-w-lg"
      >
        <StepHeader step={step} />

        <div className="space-y-4">
          {step === 1 && <WhenStep when={when} onChange={setWhen} />}

          {step === 2 && when === "event" && (
            <EventMatchStep
              services={services}
              catalogLoading={catalogQ.isLoading}
              catalogError={catalogQ.error != null}
              keys={keys}
              onToggleKey={toggleKey}
              filterFields={filterFields}
              filterRows={filterRows}
              onFilterChange={setFilterRows}
            />
          )}

          {step === 2 && when === "schedule" && (
            <ScheduleMatchStep
              cron={cron}
              onCronChange={setCron}
              timezone={timezone}
              onTimezoneChange={setTimezone}
            />
          )}

          {step === 3 && (
            <ThenStep
              target={target}
              onTargetChange={setTarget}
              scopedTeam={scopedTeam}
              workflows={workflows}
              when={when}
              prompt={prompt}
              onPromptChange={setPrompt}
            />
          )}

          {step === 4 && (
            <ReviewStep
              name={name}
              onNameChange={setName}
              summary={summarize({
                when,
                keys,
                filterRows,
                cron,
                timezone,
                target,
                workflows,
                teams,
                scopedTeam,
              })}
            />
          )}

          {error && <p className="text-xs text-danger-500">{error}</p>}
        </div>

        <DialogFooter>
          {step > 1 && (
            <Button type="button" variant="secondary" onClick={back} disabled={isPending}>
              Back
            </Button>
          )}
          {step < 4 && (
            <Button type="button" onClick={next} disabled={!canAdvance()}>
              Next
            </Button>
          )}
          {step === 4 && (
            <Button type="button" onClick={submit} disabled={!canCreate}>
              {isPending ? "Creating…" : "Create automation"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const STEP_LABELS: Record<Step, string> = {
  1: "When",
  2: "Match",
  3: "Then",
  4: "Review",
};

function StepHeader({ step }: { step: Step }) {
  return (
    <p className="text-xs font-medium text-muted">
      Step {step} of 4 — {STEP_LABELS[step]}
    </p>
  );
}

function WhenStep({ when, onChange }: { when: When; onChange: (w: When) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium text-ink">Start on</legend>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="radio"
          name="automation-when"
          className="mt-0.5"
          checked={when === "event"}
          onChange={() => onChange("event")}
        />
        <span>
          On an event
          <span className="block text-xs text-muted">
            Run when a connected integration reports a matching event.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="radio"
          name="automation-when"
          className="mt-0.5"
          checked={when === "schedule"}
          onChange={() => onChange("schedule")}
        />
        <span>
          On a schedule
          <span className="block text-xs text-muted">Run on a cron schedule you set.</span>
        </span>
      </label>
    </fieldset>
  );
}

interface CatalogService {
  service: string;
  entries: { key: string; description: string; filters?: FilterField[] }[];
}

function EventMatchStep({
  services,
  catalogLoading,
  catalogError,
  keys,
  onToggleKey,
  filterFields,
  filterRows,
  onFilterChange,
}: {
  services: CatalogService[];
  catalogLoading: boolean;
  catalogError: boolean;
  keys: Set<string>;
  onToggleKey: (key: string) => void;
  filterFields: FilterField[];
  filterRows: UiFilterRow[];
  onFilterChange: (rows: UiFilterRow[]) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Events</p>
        {catalogLoading && <LoadingRow label="Loading catalog…" className="py-2 text-xs" />}
        {catalogError && (
          <ErrorRow className="py-2 text-xs">Failed to load the event catalog.</ErrorRow>
        )}
        {!catalogLoading && !catalogError && services.length === 0 && (
          <p className="py-2 text-xs text-muted">
            No plugin publishes events yet. Connect an integration with triggers first.
          </p>
        )}
        <div className="max-h-56 space-y-3 overflow-y-auto">
          {services.map((s) => (
            <div key={s.service}>
              <p className="mb-1 text-xs font-medium text-ink">{s.service}</p>
              <div className="space-y-1">
                {s.entries.map((entry) => (
                  <label
                    key={entry.key}
                    className="flex items-start gap-2 text-sm text-ink"
                    title={entry.description}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={keys.has(entry.key)}
                      onChange={() => onToggleKey(entry.key)}
                    />
                    <span className="font-mono text-xs">{entry.key}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {keys.size > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Filters</p>
          <FilterEditor fields={filterFields} rows={filterRows} onChange={onFilterChange} />
          <p className="mt-1.5 text-xs text-muted">
            A rule matches only when every filter matches. Add none to match every selected event.
          </p>
        </div>
      )}
    </div>
  );
}

function ScheduleMatchStep({
  cron,
  onCronChange,
  timezone,
  onTimezoneChange,
}: {
  cron: string;
  onCronChange: (v: string) => void;
  timezone: string;
  onTimezoneChange: (v: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-1">
        <Label htmlFor="automation-cron">Cron</Label>
        <Input
          id="automation-cron"
          value={cron}
          onChange={(e) => onCronChange(e.target.value)}
          placeholder="0 9 * * 1-5"
        />
        <p className="text-xs text-muted">
          Five fields: minute hour day-of-month month day-of-week.
        </p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="automation-timezone">Timezone</Label>
        <Input
          id="automation-timezone"
          value={timezone}
          onChange={(e) => onTimezoneChange(e.target.value)}
          placeholder="UTC"
        />
      </div>
    </div>
  );
}

function ThenStep({
  target,
  onTargetChange,
  scopedTeam,
  workflows,
  when,
  prompt,
  onPromptChange,
}: {
  target: TargetChoice;
  onTargetChange: (t: TargetChoice) => void;
  scopedTeam: { id: string; name: string } | undefined;
  workflows: { id: string; name: string }[];
  when: When;
  prompt: string;
  onPromptChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="radio"
          name="automation-target"
          checked={target.kind === "orchestrator" && target.orchestrator === "user"}
          onChange={() => onTargetChange({ kind: "orchestrator", orchestrator: "user" })}
        />
        Notify your assistant
      </label>
      {/* Only the active workspace's team is offered. Targeting a different
          team is a workspace change, not a form field. */}
      {scopedTeam && (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="radio"
            name="automation-target"
            checked={target.kind === "orchestrator" && target.orchestrator === "team"}
            onChange={() =>
              onTargetChange({ kind: "orchestrator", orchestrator: "team", teamId: scopedTeam.id })
            }
          />
          Notify {scopedTeam.name}&apos;s assistant
        </label>
      )}
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="radio"
          name="automation-target"
          checked={target.kind === "orchestrator" && target.orchestrator === "org"}
          onChange={() => onTargetChange({ kind: "orchestrator", orchestrator: "org" })}
        />
        Notify the org assistant
      </label>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="radio"
          name="automation-target"
          checked={target.kind === "workflow"}
          disabled={workflows.length === 0}
          onChange={() => onTargetChange({ kind: "workflow", workflowId: workflows[0]?.id ?? "" })}
        />
        Run a workflow
      </label>
      {target.kind === "workflow" && (
        <div className="ml-6">
          <select
            aria-label="Workflow"
            value={target.workflowId}
            onChange={(e) => onTargetChange({ kind: "workflow", workflowId: e.target.value })}
            className="w-full min-w-0 truncate rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
          >
            <option value="">— select workflow —</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {workflows.length === 0 && (
        <p className="ml-6 text-xs text-muted">
          You have no workflows yet — create one on the Workflows page to use this target.
        </p>
      )}

      {/* A scheduled orchestrator run needs a prompt: nothing else tells the
          assistant what to do at the fire. An event rule carries the event as
          its context, so it needs none. */}
      {when === "schedule" && target.kind === "orchestrator" && (
        <div className="grid gap-1 pt-2">
          <Label htmlFor="automation-prompt">Prompt</Label>
          <Input
            id="automation-prompt"
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            placeholder="Summarize overnight changes"
          />
        </div>
      )}
    </div>
  );
}

function ReviewStep({
  name,
  onNameChange,
  summary,
}: {
  name: string;
  onNameChange: (v: string) => void;
  summary: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-1">
        <Label htmlFor="automation-name">Name</Label>
        <Input
          id="automation-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Automation name"
          aria-label="Automation name"
        />
      </div>
      <div className="rounded border border-line bg-ink-wash/40 px-3 py-2">
        <p className="text-xs font-medium text-muted">Summary</p>
        <p className="mt-1 text-sm text-ink">{summary}</p>
      </div>
    </div>
  );
}

// ── Summary sentence ───────────────────────────────────────────────────────

/** The target as a name, never an id. */
function describeTarget(
  target: TargetChoice,
  workflows: { id: string; name: string }[],
  teams: { id: string; name: string }[],
  scopedTeam: { id: string; name: string } | undefined,
): string {
  if (target.kind === "workflow") {
    const name = workflows.find((w) => w.id === target.workflowId)?.name;
    return name !== undefined ? `run the ${name} workflow` : "run a workflow";
  }
  if (target.orchestrator === "org") return "notify the org assistant";
  if (target.orchestrator === "team") {
    const name =
      teams.find((t) => t.id === target.teamId)?.name ?? scopedTeam?.name ?? "the team";
    return `notify ${name}'s assistant`;
  }
  return "notify your assistant";
}

/** The filters as names, never ids: each row carries a `label` for a picked
 * value, so a resolved id reads as "Alice", not "U123". */
function describeFilters(rows: UiFilterRow[]): string {
  const parts: string[] = [];
  for (const row of rows) {
    if (!row.field) continue;
    const shown = row.label?.trim() || row.value.trim();
    if (!shown) continue;
    parts.push(`${row.field} ${opWord(row.op)} ${shown}`);
  }
  return parts.join(", and ");
}

function opWord(op: UiFilterRow["op"]): string {
  switch (op) {
    case "eq":
      return "is";
    case "in":
      return "is one of";
    case "prefix":
      return "starts with";
    case "contains":
      return "contains";
    case "regex":
      return "matches";
  }
}

/**
 * The plain-language sentence the Review step shows. Built from names, so a
 * reader confirms the rule without reading an id.
 */
export function summarize(args: {
  when: When;
  keys: Set<string>;
  filterRows: UiFilterRow[];
  cron: string;
  timezone: string;
  target: TargetChoice;
  workflows: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  scopedTeam: { id: string; name: string } | undefined;
}): string {
  const then = describeTarget(args.target, args.workflows, args.teams, args.scopedTeam);
  if (args.when === "schedule") {
    const cron = args.cron.trim() || "the schedule";
    return `On the cron schedule "${cron}" (${args.timezone.trim() || "UTC"}), ${then}.`;
  }
  const keys = [...args.keys];
  const keyText =
    keys.length === 0
      ? "a matching event"
      : keys.length === 1
        ? keys[0]
        : `${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]}`;
  const filters = describeFilters(args.filterRows);
  const where = filters ? ` where ${filters}` : "";
  return `When ${keyText} arrives${where}, ${then}.`;
}
