/**
 * AutomationWizard — one flow for the creation surfaces that used to be
 * separate: an event subscription, a workflow event trigger, and a schedule.
 *
 * The wizard is outcome-first. Step 1 asks what should happen, not which
 * primitive to build. The outcome then picks the steps and the store:
 *
 *  - Reply to Slack mentions → a required multi-channel picker (or the
 *    explicit "Any channel" opt-out), which assistant answers, and a "Keep
 *    following the thread" toggle. POSTs an event subscription on
 *    `slack.app_mention` with an orchestrator target that carries `follow`.
 *    The server scopes the rule to the creator's linked Slack user
 *    (TKAI-299, `events/mention-scope.ts`), so the step says so up front.
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
import { useEffect, useRef, useState } from "react";
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
import type { EventSubscriptionFilterWire } from "@valet/api/wire";
import {
  FilterEditor,
  incompleteFilterRow,
  pruneFilterRows,
  toWireFilters,
  type FilterField,
  type UiFilterRow,
} from "~/components/events/filter-editor";
import { useCreateEventSubscription, useEventCatalog, useFilterOptions } from "~/api/events";
import { useIdentityLinks } from "~/api/queries";
import { useCreateSchedule, useWorkflows } from "~/api/workflows";
import { useTeams } from "~/api/settings";
import { errorText } from "~/lib/error-text";
// The reply outcome always subscribes to this one event key, so the reader
// never sees a raw event picker for it.
import { SLACK_APP_MENTION } from "~/lib/slack-mention";
import { useActiveWorkspace } from "~/components/workspace-clause";

/** One picked channel: the Slack id plus the display label the picker showed. */
interface SelectedChannel {
  id: string;
  label: string;
}

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
  // The reply outcome's own channel selection and follow toggle. Held apart
  // from `filterRows` so the raw-filter machinery stays owned by the other
  // outcomes. `anyChannel` is the explicit opt-out of the channel requirement
  // a mention rule carries (off by default) — shared with the event outcomes,
  // where the same flag rides a raw `slack.app_mention` selection.
  const [replyChannels, setReplyChannels] = useState<SelectedChannel[]>([]);
  const [anyChannel, setAnyChannel] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A checked "Any channel" (or picked channels) must not ride into a
  // different outcome's flow, so an outcome switch resets both.
  function chooseOutcome(next: Outcome) {
    setOutcome(next);
    setAnyChannel(false);
    setReplyChannels([]);
  }

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
  // A mention rule must name channels unless "Any channel" was chosen
  // explicitly — the same rule the server enforces. One predicate for the
  // Next gate and the Create gate, so the two cannot drift.
  const replyScoped = anyChannel || replyChannels.length > 0;

  function canAdvance(): boolean {
    if (step === 1) return true; // An outcome always has a value.
    if (outcome === "reply") {
      return step === 2 && replyScoped;
    }
    if (step === 2) {
      return isSchedule ? cron.trim().length > 0 : keys.size > 0;
    }
    if (step === 3) return targetReady;
    return true;
  }

  const isLastStep = step === plan.count;
  const canCreate =
    name.trim().length > 0 && targetReady && (outcome !== "reply" || replyScoped) && !isPending;

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
      // One channel → `eq` with its display label; several → `in` with the
      // labels carried alongside, so later surfaces show channel names, not
      // raw C… ids. The server adds the creator's Slack user filter itself.
      const channelFilters: EventSubscriptionFilterWire[] = anyChannel
        ? []
        : replyChannels.length === 1
          ? [{ field: "channel", op: "eq", value: replyChannels[0].id, label: replyChannels[0].label }]
          : [
              {
                field: "channel",
                op: "in",
                value: replyChannels.map((ch) => ch.id),
                labels: replyChannels.map((ch) => ch.label),
              },
            ];
      createSubscription.mutate(
        {
          name: name.trim(),
          eventKeys: [SLACK_APP_MENTION],
          filters: channelFilters,
          target: { ...orchestratorTargetFrom(target), follow },
          ...(anyChannel ? { anyChannel: true } : {}),
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
          // The raw picker can select `slack.app_mention` too; the flag only
          // means anything there, and the server ignores it elsewhere.
          ...(anyChannel && keys.has(SLACK_APP_MENTION) ? { anyChannel: true } : {}),
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
      // A scheduled prompt fires an assistant, so it belongs to the active
      // workspace — send the team so it fires the TEAM's assistant, not the
      // caller's. (The workflow target above needs none: it follows the
      // workflow's own owner.)
      createSchedule.mutate(
        {
          ...base,
          target: { kind: "orchestrator", prompt: prompt.trim() },
          ...(scopedTeamId ? { teamId: scopedTeamId } : {}),
        },
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
          {step === 1 && <OutcomeStep outcome={outcome} onChange={chooseOutcome} />}

          {step === 2 && outcome === "reply" && (
            <ReplyStep
              channels={replyChannels}
              onChannelsChange={setReplyChannels}
              anyChannel={anyChannel}
              onAnyChannelChange={setAnyChannel}
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
              anyChannel={anyChannel}
              onAnyChannelChange={setAnyChannel}
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
                filterRows,
                replyChannels,
                anyChannel,
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
 * The reply outcome's one config step: the channels to reply in (required,
 * unless "Any channel" is chosen), which assistant answers, and the follow
 * toggle. No raw event key is shown — the event is always
 * `slack.app_mention`. The server also scopes the rule to the creator's
 * linked Slack user, so the step says so and warns when no link exists.
 */
function ReplyStep({
  channels,
  onChannelsChange,
  anyChannel,
  onAnyChannelChange,
  target,
  onTargetChange,
  scopedTeam,
  follow,
  onFollowChange,
}: {
  channels: SelectedChannel[];
  onChannelsChange: (channels: SelectedChannel[]) => void;
  anyChannel: boolean;
  onAnyChannelChange: (v: boolean) => void;
  target: OrchestratorChoice;
  onTargetChange: (t: TargetChoice) => void;
  scopedTeam: { id: string; name: string } | undefined;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
}) {
  // The server refuses a mention rule from a creator with no linked Slack
  // account, so warn here instead of at the failed create.
  const linksQ = useIdentityLinks();
  const slackLink = linksQ.data?.links.find((l) => l.provider === "slack");
  const slackUnlinked = slackLink !== undefined && !slackLink.linked;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        This rule fires only when <span className="text-ink">you</span> @-mention the app.
        Mentions by other people do not reach your assistant.
      </p>
      {slackUnlinked && (
        <p className="text-xs text-danger-500">
          Your Slack account is not linked, so this rule cannot fire for you yet. Link it in
          Settings → Connected accounts, then create the rule.
        </p>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Channels</p>
        <ChannelMultiSelect channels={channels} onChange={onChannelsChange} disabled={anyChannel} />
        {!anyChannel && (
          <p className="mt-1.5 text-xs text-muted">
            Select one or more channels. The rule replies only there.
          </p>
        )}
        <label className="mt-2 flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={anyChannel}
            onChange={(e) => onAnyChannelChange(e.target.checked)}
          />
          <span>
            Any channel
            <span className="block text-xs text-muted">
              Reply wherever you @-mention the app, in every channel it can see.
            </span>
          </span>
        </label>
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

/**
 * A searchable multi-select over the `slack.channels` option source. Picked
 * channels render as removable chips below the search input. When the source
 * cannot resolve (Slack not connected, provider error), it falls back to a
 * free-text channel-id input so the rule stays creatable.
 */
function ChannelMultiSelect({
  channels,
  onChange,
  disabled,
}: {
  channels: SelectedChannel[];
  onChange: (channels: SelectedChannel[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  // The results are a popover, shown while the search input has focus — the
  // same pattern as the FilterEditor's single-value picker.
  const [open, setOpen] = useState(false);
  // Once the source reports it cannot resolve (Slack not connected, provider
  // error), latch into the free-text fallback and stop querying. Without the
  // latch, each keystroke re-keys the query, `reason` blinks undefined while
  // the refetch is in flight, and the input remounts mid-typing.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const optionsQ = useFilterOptions(
    { source: "slack.channels", q: debounced },
    { enabled: disabled !== true && fallbackReason === null },
  );
  const reason = optionsQ.data?.reason;
  useEffect(() => {
    if (reason !== undefined) setFallbackReason(reason);
  }, [reason]);
  const options = optionsQ.data?.options ?? [];

  function toggle(id: string, label: string) {
    if (channels.some((c) => c.id === id)) onChange(channels.filter((c) => c.id !== id));
    else onChange([...channels, { id, label }]);
  }

  const chips = channels.length > 0 && (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {channels.map((c) => (
        <span
          key={c.id}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-ink-wash/40 px-2 py-0.5 text-xs text-ink"
        >
          {c.label}
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove ${c.label}`}
              onClick={() => onChange(channels.filter((x) => x.id !== c.id))}
              className="text-muted hover:text-ink"
            >
              ✕
            </button>
          )}
        </span>
      ))}
    </div>
  );

  if (fallbackReason !== null && disabled !== true) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Channel id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="C0123456789"
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={query.trim().length === 0}
            onClick={() => {
              const id = query.trim();
              if (id && !channels.some((c) => c.id === id)) onChange([...channels, { id, label: id }]);
              setQuery("");
            }}
          >
            Add channel
          </Button>
        </div>
        <p className="mt-1 text-xs text-muted">{fallbackReason}</p>
        {chips}
      </div>
    );
  }

  return (
    <div className="relative">
      <Input
        aria-label="Channel search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        // Delay the close so a click on an option registers first.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder={channels.length > 0 ? "Add another channel…" : "Search channels…"}
        disabled={disabled}
        className="w-full min-w-0"
      />
      {open && !disabled && (
        <div
          role="listbox"
          aria-label="Channel options"
          className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-md border border-line bg-paper py-1 shadow-lg"
        >
          {optionsQ.isLoading && <p className="px-2 py-1 text-xs text-muted">Loading…</p>}
          {!optionsQ.isLoading && options.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted">No matches</p>
          )}
          {options.map((o) => {
            const picked = channels.some((c) => c.id === o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={picked}
                // Keep the input focused through the click so onBlur does not
                // close the popover before onClick fires.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  toggle(o.id, o.label);
                  setQuery("");
                }}
                className={`block w-full px-2 py-1 text-left text-sm text-ink hover:bg-hover ${
                  picked ? "bg-hover" : ""
                }`}
              >
                {picked ? "✓ " : ""}
                {o.label}
                {o.hint && <span className="ml-1 text-xs text-muted">{o.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
      {chips}
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
  anyChannel,
  onAnyChannelChange,
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
  anyChannel: boolean;
  onAnyChannelChange: (v: boolean) => void;
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
          {/* A `slack.app_mention` rule is scoped to the creator's own
              mentions and needs a channel filter, unless this explicit
              opt-out is set — the same rule the server enforces. */}
          {keys.has(SLACK_APP_MENTION) && (
            <label className="mt-2 flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={anyChannel}
                onChange={(e) => onAnyChannelChange(e.target.checked)}
              />
              <span>
                Any channel
                <span className="block text-xs text-muted">
                  A mention rule fires only for your own @-mentions and needs a channel filter.
                  Check this to listen in every channel the app can see instead.
                </span>
              </span>
            </label>
          )}
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
  replyChannels: SelectedChannel[];
  anyChannel: boolean;
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
    const names = args.replyChannels.map((c) => c.label);
    const where = args.anyChannel
      ? " in any channel the app can see"
      : names.length > 0
        ? ` in ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`}`
        : "";
    const trailing = args.follow ? " Later thread messages reach the assistant too." : "";
    return `When you @-mention the app${where}, ${then}. Mentions by other people do not fire it.${trailing}`;
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
