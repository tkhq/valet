/**
 * AutomationWizard — one flow for the creation surfaces that used to be
 * separate: an event subscription, a workflow event trigger, and a schedule.
 *
 * The wizard is outcome-first. Step 1 asks what should happen, not which
 * primitive to build. The outcome then picks the steps and the store:
 *
 *  - Reply to Slack mentions → a channel picker, which assistant answers, and
 *    a "Keep following the thread" toggle. POSTs an event subscription on
 *    `slack.app_mention` with an orchestrator target that carries `follow`.
 *  - Run a workflow on an event → the event picker, then a workflow target.
 *  - Send a notification → the event picker, then an orchestrator target.
 *  - Advanced / custom trigger → the raw event + filter + target flow.
 *  - On a schedule → a cron expression, then an orchestrator prompt or a
 *    workflow target.
 *
 * On submit the wizard writes to the store for the branch:
 *  - event + assistant  → POST /api/event-subscriptions (orchestrator target)
 *  - event + workflow    → POST /api/event-subscriptions (workflow target)
 *  - schedule            → POST /api/workflows/schedules
 *
 * The event branch always uses the subscription store, for both target kinds,
 * so one event rule has one home. The subscription target already carries a
 * workflow kind (`EventSubscriptionTargetWire`), so a workflow-targeted event
 * rule needs no separate event-trigger endpoint.
 */
import { useEffect, useMemo, useRef, useState } from "react";
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

/** The reply outcome always subscribes to this one event key, so the reader
 * never sees a raw event picker for it. */
const SLACK_APP_MENTION = "slack.app_mention";

/** The channel filter the `slack.app_mention` event declares. Its options
 * source populates the same channel-name picker the FilterEditor uses. */
const SLACK_CHANNEL_FIELD: FilterField = {
  field: "channel",
  description: "Slack channel id where the mention happened",
  options: { source: "slack.channels" },
};

/** The outcome the reader picks first. It decides the steps and the store. */
type Outcome = "reply" | "workflow" | "notify" | "advanced" | "schedule";

type OrchestratorChoice =
  | { kind: "orchestrator"; orchestrator: "user" | "org" }
  | { kind: "orchestrator"; orchestrator: "team"; teamId: string };

type TargetChoice = OrchestratorChoice | { kind: "workflow"; workflowId: string };

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

/** The step labels for one outcome. The reply outcome skips the separate Then
 * step: its single config step holds the assistant choice too. */
function stepPlan(outcome: Outcome): { labels: string[]; count: Step } {
  if (outcome === "reply") {
    return { labels: ["What", "Reply", "Review"], count: 3 };
  }
  return { labels: ["What", "Match", "Then", "Review"], count: 4 };
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

  const [step, setStep] = useState<Step>(1);
  const [outcome, setOutcome] = useState<Outcome>("reply");
  const [name, setName] = useState("");
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [filterRows, setFilterRows] = useState<UiFilterRow[]>([]);
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone());
  const [prompt, setPrompt] = useState("");
  // Seeded from the active workspace at mount, then resynced when the
  // workspace changes (below) unless the reader already picked a target.
  const [target, setTarget] = useState<TargetChoice>(() => initialTarget(scopedTeamId));
  // The reply outcome's own channel picker and follow toggle. Held apart from
  // `filterRows` so the raw-filter machinery stays owned by the other outcomes.
  const [replyChannel, setReplyChannel] = useState<UiFilterRow[]>([]);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A manual target choice wins: once the reader picks a target, a later
  // workspace switch must not overwrite it. The default target seeds from the
  // active workspace, so it must follow a workspace change until then (see
  // CLAUDE.md "Mount-time state from props").
  const userTouched = useRef(false);
  function chooseTarget(next: TargetChoice) {
    userTouched.current = true;
    setTarget(next);
  }
  useEffect(() => {
    if (userTouched.current) return;
    setTarget(initialTarget(scopedTeamId));
  }, [scopedTeamId]);

  const workflows = workflowsQ.data?.workflows ?? [];
  const services = catalogQ.data?.services ?? [];
  const teams = teamsQ.data?.teams ?? [];

  const isPending = createSubscription.isPending || createSchedule.isPending;
  const plan = stepPlan(outcome);

  const isSchedule = outcome === "schedule";
  // Only the advanced outcome shows the raw multi-event picker. The workflow
  // and notify outcomes still pick one event, but never carry a target the
  // outcome forbids.
  const isEventOutcome = outcome === "workflow" || outcome === "notify" || outcome === "advanced";

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
    if (step === 1) return true; // An outcome always has a value.
    if (outcome === "reply") {
      // Reply step: the channel is optional and the assistant target is always
      // set, so there is nothing to block.
      return step === 2;
    }
    if (step === 2) {
      return isSchedule ? cron.trim().length > 0 : keys.size > 0;
    }
    if (step === 3) return targetReady;
    return true;
  }

  const isLastStep = step === plan.count;
  const canCreate = name.trim().length > 0 && targetReady && !isPending;

  function next() {
    setError(null);
    setStep((s) => (Math.min(s + 1, plan.count) as Step));
  }
  function back() {
    setError(null);
    setStep((s) => (Math.max(s - 1, 1) as Step));
  }

  function orchestratorTargetFrom(t: TargetChoice): OrchestratorChoice {
    // The reply and notify outcomes only ever hold an orchestrator target, so
    // this narrows without a cast the type system cannot follow.
    return t.kind === "orchestrator" ? t : { kind: "orchestrator", orchestrator: "user" };
  }

  function submit() {
    if (!canCreate) return;
    setError(null);

    if (outcome === "reply") {
      const channelFilters = toWireFilters(replyChannel);
      createSubscription.mutate(
        {
          name: name.trim(),
          eventKeys: [SLACK_APP_MENTION],
          filters: channelFilters,
          target: { ...orchestratorTargetFrom(target), follow },
        },
        {
          onSuccess: () => onOpenChange(false),
          onError: (err) => setError(errorText(err)),
        },
      );
      return;
    }

    if (isEventOutcome) {
      const incomplete = incompleteFilterRow(filterRows);
      if (incomplete) {
        setError(`Enter a value for the "${incomplete}" filter, or remove the row.`);
        return;
      }
      // The notify outcome speaks to an assistant, never follows a thread.
      const eventTarget: EventSubscriptionTarget =
        outcome === "notify"
          ? { ...orchestratorTargetFrom(target), follow: false }
          : target;
      createSubscription.mutate(
        {
          name: name.trim(),
          eventKeys: [...keys],
          filters: toWireFilters(filterRows),
          target: eventTarget,
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
        description="Pick what should happen, then fill in the details."
        className="max-w-lg"
      >
        <StepHeader step={step} plan={plan} />

        <div className="space-y-4">
          {step === 1 && <OutcomeStep outcome={outcome} onChange={setOutcome} />}

          {step === 2 && outcome === "reply" && (
            <ReplyStep
              channelRows={replyChannel}
              onChannelChange={setReplyChannel}
              target={orchestratorTargetFrom(target)}
              onTargetChange={chooseTarget}
              scopedTeam={scopedTeam}
              follow={follow}
              onFollowChange={setFollow}
            />
          )}

          {step === 2 && isEventOutcome && (
            <EventMatchStep
              services={services}
              catalogLoading={catalogQ.isLoading}
              catalogError={catalogQ.error != null}
              keys={keys}
              onToggleKey={toggleKey}
              filterFields={filterFields}
              filterRows={filterRows}
              onFilterChange={setFilterRows}
              singleEvent={outcome !== "advanced"}
            />
          )}

          {step === 2 && isSchedule && (
            <ScheduleMatchStep
              cron={cron}
              onCronChange={setCron}
              timezone={timezone}
              onTimezoneChange={setTimezone}
            />
          )}

          {step === 3 && (isEventOutcome || isSchedule) && (
            <ThenStep
              target={target}
              onTargetChange={chooseTarget}
              scopedTeam={scopedTeam}
              workflows={workflows}
              isSchedule={isSchedule}
              allowWorkflow={outcome === "workflow" || isSchedule || outcome === "advanced"}
              allowOrchestrator={outcome !== "workflow"}
              prompt={prompt}
              onPromptChange={setPrompt}
            />
          )}

          {isLastStep && (
            <ReviewStep
              name={name}
              onNameChange={setName}
              summary={summarize({
                outcome,
                keys,
                filterRows: outcome === "reply" ? replyChannel : filterRows,
                cron,
                timezone,
                target,
                follow,
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
          {!isLastStep && (
            <Button type="button" onClick={next} disabled={!canAdvance()}>
              Next
            </Button>
          )}
          {isLastStep && (
            <Button type="button" onClick={submit} disabled={!canCreate}>
              {isPending ? "Creating…" : "Create automation"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The subscription target the event branch posts. A workflow target has no
 * follow flag; an orchestrator target may. */
type EventSubscriptionTarget = TargetChoice | (OrchestratorChoice & { follow: boolean });

function StepHeader({ step, plan }: { step: Step; plan: { labels: string[]; count: Step } }) {
  return (
    <p className="text-xs font-medium text-muted">
      Step {step} of {plan.count} — {plan.labels[step - 1]}
    </p>
  );
}

const OUTCOMES: { value: Outcome; title: string; hint: string }[] = [
  {
    value: "reply",
    title: "Reply to Slack mentions",
    hint: "An assistant answers when someone @-mentions the app in Slack.",
  },
  {
    value: "workflow",
    title: "Run a workflow on an event",
    hint: "Start a workflow when a connected integration reports an event.",
  },
  {
    value: "notify",
    title: "Send a notification",
    hint: "Tell an assistant when a connected integration reports an event.",
  },
  {
    value: "schedule",
    title: "On a schedule",
    hint: "Run an assistant or a workflow on a cron schedule you set.",
  },
  {
    value: "advanced",
    title: "Advanced / custom trigger",
    hint: "Pick raw event keys and filters, then any target.",
  },
];

function OutcomeStep({ outcome, onChange }: { outcome: Outcome; onChange: (o: Outcome) => void }) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium text-ink">What should happen?</legend>
      {OUTCOMES.map((o) => (
        <label key={o.value} className="flex items-start gap-2 text-sm text-ink">
          <input
            type="radio"
            name="automation-outcome"
            className="mt-0.5"
            checked={outcome === o.value}
            onChange={() => onChange(o.value)}
          />
          <span>
            {o.title}
            <span className="block text-xs text-muted">{o.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The reply outcome's one config step: an optional channel, which assistant
 * answers, and the follow toggle. No raw event key is shown — the event is
 * always `slack.app_mention`.
 */
function ReplyStep({
  channelRows,
  onChannelChange,
  target,
  onTargetChange,
  scopedTeam,
  follow,
  onFollowChange,
}: {
  channelRows: UiFilterRow[];
  onChannelChange: (rows: UiFilterRow[]) => void;
  target: OrchestratorChoice;
  onTargetChange: (t: TargetChoice) => void;
  scopedTeam: { id: string; name: string } | undefined;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
}) {
  // Reuse the FilterEditor's channel-name picker, locked to the one channel
  // field. It shows channel names, not ids, from the `slack.channels` source.
  const channelFields = useMemo(() => [SLACK_CHANNEL_FIELD], []);
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Channel (optional)</p>
        <FilterEditor fields={channelFields} rows={channelRows} onChange={onChannelChange} />
        <p className="mt-1.5 text-xs text-muted">
          Leave empty to reply in every channel the app can see. Add one channel to reply there
          only.
        </p>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Which assistant answers</p>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="radio"
              name="automation-reply-target"
              checked={target.orchestrator === "user"}
              onChange={() => onTargetChange({ kind: "orchestrator", orchestrator: "user" })}
            />
            Your assistant
          </label>
          {scopedTeam && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="automation-reply-target"
                checked={target.orchestrator === "team"}
                onChange={() =>
                  onTargetChange({ kind: "orchestrator", orchestrator: "team", teamId: scopedTeam.id })
                }
              />
              {scopedTeam.name}&apos;s assistant
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="radio"
              name="automation-reply-target"
              checked={target.orchestrator === "org"}
              onChange={() => onTargetChange({ kind: "orchestrator", orchestrator: "org" })}
            />
            The org assistant
          </label>
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={follow}
          onChange={(e) => onFollowChange(e.target.checked)}
        />
        <span>
          Keep following the thread
          <span className="block text-xs text-muted">
            After the first reply, later messages in that thread reach the assistant without a
            new mention.
          </span>
        </span>
      </label>
    </div>
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
  singleEvent,
}: {
  services: CatalogService[];
  catalogLoading: boolean;
  catalogError: boolean;
  keys: Set<string>;
  onToggleKey: (key: string) => void;
  filterFields: FilterField[];
  filterRows: UiFilterRow[];
  onFilterChange: (rows: UiFilterRow[]) => void;
  singleEvent: boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">
          {singleEvent ? "Run this when this happens" : "Run this when any of these happens"}
        </p>
        {catalogLoading && <LoadingRow label="Loading catalog…" className="py-2 text-xs" />}
        {catalogError && (
          <ErrorRow className="py-2 text-xs">
            Could not load the event catalog. Retry, or check your integrations in Settings.
          </ErrorRow>
        )}
        {!catalogLoading && !catalogError && services.length === 0 && (
          <p className="py-2 text-xs text-muted">
            No plugin publishes events yet. Connect an integration with triggers first.
          </p>
        )}
        <div className="max-h-56 space-y-3 overflow-y-auto">
          {services.map((s) => (
            <div key={s.service}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {s.service.charAt(0).toUpperCase() + s.service.slice(1)}
              </p>
              <div className="space-y-0.5">
                {s.entries.map((entry) => (
                  <label
                    key={entry.key}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={keys.has(entry.key)}
                      onChange={() => onToggleKey(entry.key)}
                    />
                    <span className="min-w-0">
                      {/* Plain language first — what the person recognizes, not
                          the event key (how the system is built). */}
                      <span className="block text-sm text-ink">{entry.description}</span>
                      <span className="block font-mono text-[11px] leading-tight text-muted">{entry.key}</span>
                    </span>
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
  isSchedule,
  allowWorkflow,
  allowOrchestrator,
  prompt,
  onPromptChange,
}: {
  target: TargetChoice;
  onTargetChange: (t: TargetChoice) => void;
  scopedTeam: { id: string; name: string } | undefined;
  workflows: { id: string; name: string }[];
  isSchedule: boolean;
  allowWorkflow: boolean;
  allowOrchestrator: boolean;
  prompt: string;
  onPromptChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {allowOrchestrator && (
        <>
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
        </>
      )}
      {allowWorkflow && (
        <>
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
        </>
      )}

      {/* A scheduled orchestrator run needs a prompt: nothing else tells the
          assistant what to do at the fire. An event rule carries the event as
          its context, so it needs none. */}
      {isSchedule && target.kind === "orchestrator" && (
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
  outcome: Outcome;
  keys: Set<string>;
  filterRows: UiFilterRow[];
  cron: string;
  timezone: string;
  target: TargetChoice;
  follow: boolean;
  workflows: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  scopedTeam: { id: string; name: string } | undefined;
}): string {
  const then = describeTarget(args.target, args.workflows, args.teams, args.scopedTeam);

  if (args.outcome === "reply") {
    const filters = describeFilters(args.filterRows);
    const where = filters ? ` in ${filters}` : "";
    const trailing = args.follow ? " Later thread messages reach the assistant too." : "";
    return `When the app is @-mentioned${where}, ${then}.${trailing}`;
  }

  if (args.outcome === "schedule") {
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
