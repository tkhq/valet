import { type AssistantThreadPolicy, type Appearance, validateAppearance } from "@valet/shared";
import { RunsInField } from "~/components/presence/runs-in-field";
import { defaultWizardThreadPolicy, subjectKindForKeys } from "~/components/presence/thread-policy-copy";
import { AppearanceSettings } from "~/components/presence/appearance-settings";
import { placeFilter, type PreselectedPlace } from "~/components/presence/place-filter";
import { runsInLabel } from "~/components/presence/sentences";
import { AutomationReview } from "./automation-review";
import { wizardDraft, wizardSentence, type WhenService } from "./wizard-preview";
import { parseSlackThreadLink } from "./slack-thread-preset";
import { DeliveryPreferences, type DeliveryPreferencesValue } from "./delivery-preferences";
/**
 * AutomationWizard — one flow for the creation surfaces that used to be
 * separate: an event subscription, a workflow event trigger, and a schedule.
 * UI copy names the result by its flow (spec 2026-10-16, Terminology): an
 * event rule is a **listener**, a schedule is a **routine**.
 *
 * Step 1 asks **When** (a Slack mention, a GitHub or Linear event, or a
 * schedule) and **Do** (reply, follow a Slack thread, work on it, or run a
 * workflow). The pair maps onto one outcome, and the outcome picks the steps
 * and the store. A preview line under the step header reads the draft back
 * as the sentence the Presence lists show (spec Part H):
 *
 *  - Reply to Slack mentions → a required multi-channel picker (or the
 *    explicit "Any channel" opt-out), which assistant answers, a "Keep
 *    following the thread" toggle, and the optional prompt templates. POSTs
 *    an event subscription on `slack.app_mention` with an assistant target
 *    that carries `follow`. The server scopes personal rules to the creator's
 *    linked Slack user (TKAI-299, `events/mention-scope.ts`), so the step says
 *    so up front.
 *  - Run a workflow on an event → the event picker, then a workflow target.
 *  - Send a notification → the event picker, then an assistant target.
 *  - Advanced / custom trigger → the raw event + filter + target flow.
 *  - On a schedule → a cron expression, then an assistant prompt or a
 *    workflow target.
 *
 * On submit the wizard writes to the store for the branch:
 *  - event + assistant  → POST /api/event-subscriptions (assistant target)
 *  - event + workflow    → POST /api/event-subscriptions (workflow target)
 *  - schedule            → POST /api/workflows/schedules
 *
 * The event branch always uses the subscription store, for both target kinds,
 * so one event rule has one home. The subscription target already carries a
 * workflow kind (`EventSubscriptionTargetWire`), so a workflow-targeted event
 * rule needs no separate event-trigger endpoint.
 */
import { EventMatchStep } from "./event-match-step";
import { useSubscriptionMatch, validateSubscriptionFilters } from "./subscription-match";
import { Link } from "@tanstack/react-router";
import type {
  EventSubscriptionAudienceWire,
  EventSubscriptionCollisionsWire,
  EventSubscriptionFilterWire,
} from "@valet/api/wire";
import { useEffect, useRef, useState } from "react";
import { useCreateEventSubscription, useEventCatalog, useFilterOptions } from "~/api/events";
import { useIdentityLinks } from "~/api/queries";
import { useTeams } from "~/api/settings";
import { useCreateSchedule, useWorkflows } from "~/api/workflows";
import { CollisionNotice, collisionsFromError } from "~/components/events/collision-notice";
import {
  NO_CHANNEL_MATCH_HELP,
  type UiFilterRow,
} from "~/components/events/filter-editor";
import {
  PromptFields,
  promptFieldsToTarget,
  type PromptFieldsValue,
} from "~/components/events/prompt-fields";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "~/components/primitives";
import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { errorText } from "~/lib/error-text";
// The reply outcome always subscribes to this one event key, so the reader
// never sees a raw event picker for it.
import { useActiveWorkspace } from "~/components/workspace-clause";
import { SLACK_APP_MENTION } from "~/lib/slack-mention";

/** One picked channel: the Slack id plus the display label the picker showed. */
interface SelectedChannel {
  id: string;
  label: string;
}

/** The outcome the reader picks first. It decides the steps and the store. */
type Outcome = "reply" | "workflow" | "notify" | "advanced" | "schedule" | "thread";

/** The workspace that owns the event rule or scheduled prompt. */
type AssistantChoice =
  | { kind: "assistant"; assistant: "user" }
  | { kind: "assistant"; assistant: "org" }
  | { kind: "assistant"; assistant: "team"; teamId: string };

type TargetChoice = AssistantChoice | { kind: "workflow"; workflowId: string };

type Step = 1 | 2 | 3 | 4;

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The wizard's first target: the active workspace's assistant. The store
 * stamps the owner off the target, so this is how a rule is born in the
 * workspace the switcher names. */
function initialTarget(scopedTeamId: string | undefined): TargetChoice {
  return scopedTeamId !== undefined
    ? { kind: "assistant", assistant: "team", teamId: scopedTeamId }
    : { kind: "assistant", assistant: "user" };
}

/** The workspace key whose assistant threads the Runs in picker lists. The
 * org assistant has no workspace key, so its rules cannot pin a thread here. */
function threadWorkspaceFor(target: TargetChoice): string | undefined {
  if (target.kind !== "assistant") return undefined;
  if (target.assistant === "user") return "user";
  if (target.assistant === "team") return target.teamId;
  return undefined;
}

function stepPlan(outcome: Outcome): { labels: string[]; count: Step } {
  if (outcome === "reply") {
    return { labels: ["When", "Reply", "Review"], count: 3 };
  }
  if (outcome === "schedule") {
    return { labels: ["When", "Schedule", "Do", "Review"], count: 4 };
  }
  return { labels: ["When", "What", "Do", "Review"], count: 4 };
}

/** The Do choices. `reply` and `thread` are Slack only. */
type DoChoice = "reply" | "thread" | "notify" | "workflow";

const WHEN_CHOICES: { value: WhenService | "schedule"; title: string }[] = [
  { value: "slack", title: "Someone mentions Valet in Slack" },
  { value: "github", title: "Something happens on GitHub" },
  { value: "linear", title: "Something happens in Linear" },
  { value: "schedule", title: "On a schedule" },
];

const DO_CHOICES: { value: DoChoice; title: string; slackOnly: boolean }[] = [
  { value: "reply", title: "Reply", slackOnly: true },
  { value: "thread", title: "Follow a Slack thread", slackOnly: true },
  { value: "notify", title: "Work on it", slackOnly: false },
  { value: "workflow", title: "Run a workflow", slackOnly: false },
];

/** The outcome the wizard opens on. A routine opens on the schedule, a
 * preselected workflow on a workflow rule, and a place outside Slack on a
 * notification, because it cannot take a Slack reply. */
function initialOutcome(
  startOn: "event" | "routine",
  preselectedWorkflowId: string | undefined,
  place: PreselectedPlace | undefined,
): Outcome {
  if (startOn === "routine") return "schedule";
  if (preselectedWorkflowId !== undefined) return "workflow";
  if (place !== undefined && place.service !== "slack") return "notify";
  return "reply";
}

/** The reply step's channels for a preselected Slack channel, else none. */
function placeChannels(place: PreselectedPlace | undefined): SelectedChannel[] {
  const filter = place ? placeFilter(place) : null;
  return filter?.field === "channel" ? [{ id: filter.value, label: filter.label }] : [];
}

/** The event outcomes' first filter row for a preselected place, else none. */
function placeFilterRows(place: PreselectedPlace | undefined): UiFilterRow[] {
  const filter = place ? placeFilter(place) : null;
  if (filter === null) return [];
  return [{ id: crypto.randomUUID(), field: filter.field, op: "eq", value: filter.value, label: filter.label }];
}

export function AutomationWizard({
  open,
  onOpenChange,
  replyTeam,
  onCloseAutoFocus,
  preselectedPlace,
  preselectedWorkflowId,
  startOn = "event",
}: {
  replyTeam?: { id: string; name: string };
  onCloseAutoFocus?: (event: Event) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens on one place: its service is the only one the event picker
   * offers, and its channel, repository, or Linear team is the first filter.
   * The wizard reads it at mount; a new place needs a new wizard. */
  preselectedPlace?: PreselectedPlace;
  /** Opens on "Run a workflow on an event" with this workflow as the target.
   * Read at mount, like `preselectedPlace`. */
  preselectedWorkflowId?: string;
  /** The flow the wizard opens on: an event (a line of presence) or a
   * routine (a schedule). Read at mount. */
  startOn?: "event" | "routine";
}) {
  const catalogQ = useEventCatalog();
  const allServices = catalogQ.data?.services ?? [];
  // The When step's service. A place fixes it; the schedule and the raw
  // outcome do not read it.
  const [service, setService] = useState<WhenService>(preselectedPlace?.service ?? "slack");
  const workflowsQ = useWorkflows();
  const createSubscription = useCreateEventSubscription();
  const createSchedule = useCreateSchedule();
  const ws = useActiveWorkspace();
  const teamsQ = useTeams();
  const scopedTeam = replyTeam ?? (ws?.kind === "team" ? ws.team : undefined);
  const scopedTeamId = scopedTeam?.id;

  // A routine opens on its schedule step (spec Part E step 3).
  const [step, setStep] = useState<Step>(replyTeam || startOn === "routine" ? 2 : 1);
  // Read at mount, like the preselections it derives from.
  const [outcome, setOutcome] = useState<Outcome>(() => initialOutcome(startOn, preselectedWorkflowId, preselectedPlace));
  // The event picker offers the place's service, else the When step's
  // service for a notification or a workflow. The raw outcome offers all.
  const pickerService = preselectedPlace?.service ?? (outcome === "notify" || outcome === "workflow" ? service : undefined);
  const services = pickerService !== undefined ? allServices.filter((s) => s.service === pickerService) : allServices;
  const [threadLink, setThreadLink] = useState("");
  const threadPreset = parseSlackThreadLink(threadLink);
  const [appearance, setAppearance] = useState<Appearance>({});
  const [name, setName] = useState("");
  // The place's filter row, made once: the match keeps it across event
  // changes and puts it back when a later event has its field again.
  const [placeRows] = useState(() => placeFilterRows(preselectedPlace));
  const { keys, setKeys, filterRows, setFilterRows, filterFields, toggleKey } = useSubscriptionMatch(
    services,
    [],
    () => placeRows,
    placeRows,
  );
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(defaultTimezone());
  const [prompt, setPrompt] = useState("");
  // The assistant target's optional prompt templates. Empty by default, so a
  // reader who never opens the fields creates the rule the wizard always did.
  const [promptTemplates, setPromptTemplates] = useState<PromptFieldsValue>({
    systemPrompt: "",
    userPromptTemplate: "",
  });
  // Seeded from the active workspace at mount, then resynced when the
  // workspace changes (below) unless the reader already picked a target.
  const [target, setTarget] = useState<TargetChoice>(() =>
    preselectedWorkflowId !== undefined ? { kind: "workflow", workflowId: preselectedWorkflowId } : initialTarget(scopedTeamId));
  // The reply outcome's own channel selection and follow toggle. Held apart
  // from `filterRows` so the raw-filter machinery stays owned by the other
  // outcomes. `anyChannel` is the explicit opt-out of the channel requirement
  // a mention rule carries (off by default) — shared with the event outcomes,
  // where the same flag rides a raw `slack.app_mention` selection.
  const [replyChannels, setReplyChannels] = useState<SelectedChannel[]>(() => placeChannels(preselectedPlace));
  const [anyChannel, setAnyChannel] = useState(false);
  // Who may invoke a team assistant by mention. A bot invited into a channel
  // answers everyone in that channel by default; team-only stays one click
  // away. Read only for a team reply target, so a personal or org rule posts
  // no audience at all.
  const [audience, setAudience] = useState<EventSubscriptionAudienceWire>("organization");
  const [follow, setFollow] = useState(true);
  // The reader's Runs in choice, or undefined while the wizard default holds.
  // The default follows the outcome and the picked events, so it is derived,
  // not stored. A pick remembers its workspace: an existing thread of one
  // assistant is not valid after the target moves to another.
  const [threadChoice, setThreadChoice] = useState<{ policy: AssistantThreadPolicy | null; workspace: string | undefined; title?: string } | undefined>(undefined);
  // Runs in reads as a sentence until the reader selects Change. Once open,
  // the field stays open for the wizard's life.
  const [runsInOpen, setRunsInOpen] = useState(false);
  const [deliveryPreferences, setDeliveryPreferences] = useState<DeliveryPreferencesValue>({ deliveryPolicy: "always", pauseOnOverlap: true });
  const [error, setError] = useState<string | null>(null);
  // The collision report of the last create attempt (TKAI-294).
  // `committed: false` — the server refused (409): show the colliding rules
  // and offer an explicit "Create anyway". `committed: true` — the rule was
  // saved but overlaps existing ones: show the warning, then Done.
  const [collisions, setCollisions] = useState<{
    report: EventSubscriptionCollisionsWire;
    committed: boolean;
  } | null>(null);

  // A checked "Any channel" (or picked channels) must not ride into a
  // different outcome's flow, so an outcome switch resets both. The channels
  // go back to the preselected place's channel, when there is one. Picked
  // events reset too, because another outcome can offer other services.
  // A workflow outcome holds a workflow target, and the assistant outcomes
  // hold an assistant target, so the preview and the create agree.
  function chooseOutcome(next: Outcome) {
    if (next === outcome) return;
    setOutcome(next);
    setThreadChoice(undefined);
    setAnyChannel(false);
    setReplyChannels(placeChannels(preselectedPlace));
    setKeys(new Set());
    setFilterRows(placeRows);
    if (next === "workflow" && target.kind !== "workflow") {
      userTouched.current = true;
      setTarget({ kind: "workflow", workflowId: workflows[0]?.id ?? "" });
    } else if ((next === "reply" || next === "thread" || next === "notify") && target.kind === "workflow") {
      userTouched.current = false;
      setTarget(initialTarget(scopedTeamId));
    }
  }

  // When: a service keeps a Do choice that the service offers, else takes
  // the service's first one. A preselected workflow keeps Run a workflow.
  function chooseWhen(next: WhenService | "schedule") {
    if (next === "schedule") {
      chooseOutcome("schedule");
      return;
    }
    if (next !== service) {
      setService(next);
      setKeys(new Set());
      setFilterRows(placeRows);
    }
    const kept =
      outcome === "notify" || outcome === "workflow" || (next === "slack" && (outcome === "reply" || outcome === "thread"));
    if (preselectedWorkflowId !== undefined) chooseOutcome("workflow");
    else if (!kept) chooseOutcome(next === "slack" ? "reply" : "notify");
  }

  // A manual target choice wins: once the reader picks a target, a later
  // workspace switch must not overwrite it. The default target seeds from the
  // active workspace, so it must follow a workspace change until then (see
  // CLAUDE.md "Mount-time state from props"). One exception: a picked team
  // target whose team is no longer the active workspace is stale. The Then
  // step would show no team radio while the create still posts that team, so
  // the target drops back to the workspace seed and follows it again.
  // A preselected workflow is a choice made for the reader, so it wins too.
  const userTouched = useRef(preselectedWorkflowId !== undefined);
  function chooseTarget(next: TargetChoice) {
    userTouched.current = true;
    setTarget(next);
  }
  useEffect(() => {
    setTarget((held) => {
      const stale =
        held.kind === "assistant" && held.assistant === "team" && held.teamId !== scopedTeamId;
      if (userTouched.current && !stale) return held;
      userTouched.current = false;
      return initialTarget(scopedTeamId);
    });
  }, [scopedTeamId]);

  const workflows = workflowsQ.data?.workflows ?? [];
  const teams = teamsQ.data?.teams ?? [];

  const isPending = createSubscription.isPending || createSchedule.isPending;
  const plan = stepPlan(outcome);

  const isSchedule = outcome === "schedule";
  // Only the advanced outcome shows the raw multi-event picker. The workflow
  // and notify outcomes still pick one event, but never carry a target the
  // outcome forbids.
  const isEventOutcome = outcome === "workflow" || outcome === "notify" || outcome === "advanced" || outcome === "thread";

  // Runs in: the subject kind the selected events name, the wizard default,
  // and the policy the create posts. A subject choice falls back to the
  // default once the events no longer name a subject, and an existing-thread
  // choice falls back once the target is another assistant.
  const threadWorkspace = threadWorkspaceFor(target);
  const subjectKind = isSchedule ? null : outcome === "reply" ? "channel" : subjectKindForKeys([...keys]);
  const defaultThread = defaultWizardThreadPolicy(outcome, subjectKind);
  const choiceStale = threadChoice !== undefined && (
    (threadChoice.policy?.mode === "subject" && subjectKind === null) ||
    ((threadChoice.policy === null || threadChoice.policy.mode === "existing") && threadChoice.workspace !== threadWorkspace)
  );
  const threadPolicy: AssistantThreadPolicy | null =
    threadChoice === undefined || choiceStale ? defaultThread : threadChoice.policy;
  const threadReady = target.kind !== "assistant" || threadPolicy !== null;
  const ruleKind = isSchedule ? "routine" : "presence";
  // The picked thread's title names an existing pin in the sentences.
  const pinTitle = threadPolicy?.mode === "existing" ? threadChoice?.title : undefined;
  const runsIn = (idPrefix: string) => runsInOpen ? (
    <RunsInField
      idPrefix={idPrefix}
      value={threadPolicy}
      onChange={(policy, title) => setThreadChoice({ policy, workspace: threadWorkspace, ...(title !== undefined ? { title } : {}) })}
      subjectKind={subjectKind}
      ruleKind={ruleKind}
      workspace={threadWorkspace}
      eventKeys={outcome === "reply" ? [SLACK_APP_MENTION] : isSchedule ? [] : [...keys]}
    />
  ) : (
    <div className="flex items-center gap-2 text-sm text-ink">
      <span>Runs in: {threadPolicy !== null ? runsInLabel(threadPolicy, subjectKind, ruleKind, pinTitle) : "Pick a thread."}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => setRunsInOpen(true)}>Change</Button>
    </div>
  );

  // The preview: what Create stores, read back as the Presence sentence.
  const previewSentence = wizardSentence(
    wizardDraft({
      outcome,
      service,
      keys: [...keys],
      filterRows,
      replyChannels,
      anyChannel,
      target: outcome === "reply" ? assistantTargetFrom(target) : target,
      appearance,
      name,
      cron,
      timezone,
      prompt,
      thread: threadPolicy,
      follow,
      threadLink,
    }),
    catalogQ.data?.services,
    workflows,
    pinTitle !== undefined && threadPolicy?.mode === "existing" ? { [threadPolicy.threadId]: { title: pinTitle } } : {},
  );

  const workflowChosen = target.kind === "workflow" && target.workflowId.length > 0;
  const targetReady = replyTeam
    ? target.kind === "assistant" && target.assistant === "team" && target.teamId === replyTeam.id
    : target.kind === "assistant" || workflowChosen;

  // Which step the reader is on decides whether Next is allowed. Each gate
  // matches what the step collects, so the reader cannot skip an empty field.
  // A mention rule must name channels unless "Any channel" was chosen
  // explicitly — the same rule the server enforces. One predicate for the
  // Next gate and the Create gate, so the two cannot drift.
  const replyScoped = anyChannel || replyChannels.length > 0;

  function canAdvance(): boolean {
    if (step === 1) return true; // An outcome always has a value.
    if (outcome === "reply") {
      return step === 2 && replyScoped && threadReady && (!replyTeam || targetReady);
    }
    if (step === 2) {
      if (outcome === "thread") return threadPreset !== null;
      return isSchedule ? cron.trim().length > 0 : keys.size > 0;
    }
    if (step === 3) return targetReady && threadReady;
    return true;
  }

  const isLastStep = step === plan.count;
  const canCreate =
    name.trim().length > 0 && targetReady && threadReady && (outcome !== "reply" || replyScoped) && !isPending;

  function next() {
    setError(null);
    setCollisions(null);
    if (step === 2 && outcome === "thread" && threadPreset) {
      setKeys(new Set(["slack.message"]));
      setFilterRows([
        { id: "thread-channel", field: "channel", op: "eq", value: threadPreset.channel },
        { id: "thread-timestamp", field: "thread_ts", op: "eq", value: threadPreset.threadTs },
      ]);
    }
    setStep((s) => (Math.min(s + 1, plan.count) as Step));
  }
  function back() {
    setError(null);
    setCollisions(null);
    setStep((s) => (Math.max(s - 1, replyTeam ? 2 : 1) as Step));
  }

  function assistantTargetFrom(t: TargetChoice): AssistantChoice {
    // The reply and notify outcomes only ever hold an assistant target, so
    // this narrows without a cast the type system cannot follow.
    return t.kind === "assistant" ? t : { kind: "assistant", assistant: "user" };
  }

  const mentionTargetFrom = assistantTargetFrom;

  function submit(allowCollision = false) {
    if (!canCreate) return;
    const appearanceError = isSchedule ? null : validateAppearance(appearance);
    if (appearanceError) { setError(appearanceError); return; }
    const appearanceFields = Object.keys(appearance).length > 0 ? { appearance } : {};
    setError(null);
    // `canCreate` already refuses a null policy on an assistant target.
    const threadField = threadPolicy !== null ? { thread: threadPolicy } : {};

    // Shared by both subscription branches: a 409 collision renders the
    // colliding rules with a "Create anyway" path; a committed write that
    // still overlaps renders the warning before the dialog closes.
    const subscriptionHandlers = {
      onSuccess: (resp: { collisions?: EventSubscriptionCollisionsWire }) => {
        if (resp.collisions !== undefined) {
          setCollisions({ report: resp.collisions, committed: true });
          return;
        }
        onOpenChange(false);
      },
      onError: (err: Error) => {
        const report = collisionsFromError(err);
        if (report !== null) {
          setCollisions({ report, committed: false });
          return;
        }
        setCollisions(null);
        setError(errorText(err));
      },
    };

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
      const mentionTarget = mentionTargetFrom(target);
      createSubscription.mutate(
        {
          name: name.trim(),
          eventKeys: [SLACK_APP_MENTION],
          filters: channelFilters,
          // The reply step collects the same optional templates the Then step
          // collects for the other assistant outcomes. Empty fields are left
          // off, so the rule posts the target it always did.
          target: { ...mentionTarget, ...appearanceFields, follow, ...threadField, ...promptFieldsToTarget(promptTemplates), ...(mentionTarget.assistant === "user" ? deliveryPreferences : {}) },
          // Only a team assistant has an audience; the server refuses one
          // on any other target.
          ...(mentionTarget.assistant === "team" ? { audience } : {}),
          ...(anyChannel ? { anyChannel: true } : {}),
          ...(allowCollision ? { allowCollision: true } : {}),
        },
        subscriptionHandlers,
      );
      return;
    }

    if (isEventOutcome) {
      const match = validateSubscriptionFilters(filterRows, { mention: keys.has(SLACK_APP_MENTION), anyChannel });
      if (match.error !== undefined) {
        setError(match.error);
        return;
      }
      const { filters } = match;
      // The notify outcome speaks to an assistant, never follows a thread.
      // An assistant target carries the prompt templates; a workflow target
      // has its own prompt configuration on its nodes, and the server refuses
      // these fields there.
      const templates = promptFieldsToTarget(promptTemplates);
      const eventTarget: EventSubscriptionTarget =
        outcome === "notify"
          ? { ...assistantTargetFrom(target), follow: false, ...threadField, ...templates, ...(target.kind === "assistant" && target.assistant === "user" ? deliveryPreferences : {}) }
          : target.kind === "assistant"
            ? { ...target, ...(outcome === "thread" ? { follow: false } : {}), ...threadField, ...templates, ...(target.assistant === "user" ? deliveryPreferences : {}) }
            : target;
      createSubscription.mutate(
        {
          name: name.trim(),
          eventKeys: [...keys],
          filters,
          target: { ...eventTarget, ...appearanceFields },
          // The raw picker can select `slack.app_mention` too; the flag only
          // means anything there, and the server ignores it elsewhere.
          ...(anyChannel && keys.has(SLACK_APP_MENTION) ? { anyChannel: true } : {}),
          ...(allowCollision ? { allowCollision: true } : {}),
        },
        subscriptionHandlers,
      );
      return;
    }

    // Schedule branch. The schedule store takes a workflow OR an assistant
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
      // A scheduled prompt fires an assistant, so `teamId` follows the RADIO,
      // not the workspace. It used to follow the workspace, which quietly
      // overrode a reader who picked "your assistant" inside a team; the
      // wizard opens on the team radio there, so the default is unchanged.
      // (The workflow target above needs no team: it follows the workflow's
      // own owner.)
      createSchedule.mutate(
        {
          ...base,
          target: {
            kind: "assistant",
            prompt: prompt.trim(),
          },
          ...threadField,
          ...(target.assistant === "team" ? { teamId: target.teamId } : {}),
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
        onCloseAutoFocus={onCloseAutoFocus}
        title={replyTeam ? "Set up Slack replies" : isSchedule ? "New routine" : "Listen for…"}
        description={replyTeam ? `Choose where ${replyTeam.name} replies and which assistant answers.` : "Choose when Valet acts and what it does."}
        className="max-w-lg"
      >
        {replyTeam ? <p className="mb-4 text-xs text-muted">Step {step - 1} of 2 · {step === 2 ? "Reply" : "Review"}</p> : <StepHeader step={step} plan={plan} />}
        <p aria-live="polite" data-testid="wizard-preview" className="mb-4 mt-2 rounded-md bg-ink-wash px-3 py-2 text-sm text-ink">
          {previewSentence}
        </p>

        <div className="space-y-4">
          {step === 1 && (
            <WhenDoStep
              outcome={outcome}
              service={service}
              fixedService={preselectedPlace?.service}
              fixedWorkflow={preselectedWorkflowId !== undefined}
              onWhenChange={chooseWhen}
              onDoChange={chooseOutcome}
              onAdvanced={() => chooseOutcome("advanced")}
            />
          )}

          {step === 2 && outcome === "reply" && (
            <ReplyStep
              fixedTeam={!!replyTeam}
              channels={replyChannels}
              onChannelsChange={setReplyChannels}
              anyChannel={anyChannel}
              onAnyChannelChange={setAnyChannel}
              target={mentionTargetFrom(target)}
              onTargetChange={chooseTarget}
              scopedTeam={scopedTeam}
              audience={audience}
              onAudienceChange={setAudience}
              follow={follow}
              onFollowChange={setFollow}
              promptTemplates={promptTemplates}
              onPromptTemplatesChange={setPromptTemplates}
            />
          )}
          {step === 2 && outcome === "reply" && runsIn("automation-reply")}

          {step === 2 && outcome === "thread" && <div className="space-y-2">
            <Label htmlFor="slack-thread-link">Slack thread link</Label>
            <Input id="slack-thread-link" value={threadLink} onChange={(event) => setThreadLink(event.target.value)} placeholder="https://your-team.slack.com/archives/…" />
            <p className="text-xs text-muted">In Slack, copy a message link. Only future human replies in that thread will match. Valet must have access to the channel.</p>
            {threadLink && !threadPreset && <p role="alert" className="text-xs text-danger-500">Paste a Slack message link from Copy link.</p>}
          </div>}
          {step === 2 && isEventOutcome && outcome !== "thread" && (
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
              allowAssistant={outcome !== "workflow"}
              prompt={prompt}
              onPromptChange={setPrompt}
              promptTemplates={promptTemplates}
              onPromptTemplatesChange={setPromptTemplates}
            />
          )}
          {step === 3 && (isEventOutcome || isSchedule) && target.kind === "assistant" && runsIn("automation-outcome")}

          {isLastStep && !isSchedule && target.kind === "assistant" && target.assistant === "user" && (
            <DeliveryPreferences value={deliveryPreferences} onChange={setDeliveryPreferences} />
          )}

          {isLastStep && !isSchedule && (
            <details className="rounded-md border border-line px-3 py-2">
              <summary className="cursor-pointer text-sm font-medium text-ink">Appears as</summary>
              <div className="pt-2">
                <AppearanceSettings value={appearance} onChange={setAppearance} subscription />
              </div>
            </details>
          )}

          {isLastStep && (
            <ReviewStep
              routine={isSchedule}
              name={name}
              onNameChange={setName}
              following={outcome === "reply" ? follow : outcome === "thread" ? false : undefined}
              reviewAudience={outcome === "reply" && target.kind === "assistant" && target.assistant === "team" ? audience : undefined}
              workflowId={target.kind === "workflow" ? target.workflowId : undefined}
              when={isSchedule ? `${cron} (${timezone})` : outcome === "reply" ? "Slack @-mention" : [...keys].join(", ")}
              scope={outcome === "reply" ? (anyChannel ? "Any accessible channel" : replyChannels.map(c => c.label).join(", ")) : isSchedule ? (scopedTeam?.name ?? "Personal") : describeFilters(filterRows) || "All matching events"}
              destination={describeTarget(target, workflows, teams, scopedTeam)}
              summary={previewSentence}
            />
          )}

          {collisions !== null && (
            <CollisionNotice report={collisions.report} committed={collisions.committed} />
          )}
          {replyTeam && collisions && !collisions.committed && <p className="text-sm text-muted">Valet already listens for this. <Link to="/presence" className="underline">Open Presence</Link> to manage it.</p>}
          {error && <p role="alert" className="text-xs text-danger-500">{error}</p>}
        </div>

        <DialogFooter>
          {collisions?.committed === true ? (
            // The rule was saved; the notice above is the last word. No Back
            // — resubmitting the same form would create a duplicate.
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              {step > (replyTeam ? 2 : 1) && (
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
                <Button type="button" onClick={() => submit()} disabled={!canCreate}>
                  {isPending ? "Creating…" : "Create"}
                </Button>
              )}
              {!replyTeam && isLastStep && collisions !== null && collisions.report.blocking.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => submit(true)}
                  disabled={!canCreate}
                >
                  Create anyway
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The subscription target the event branch posts. A workflow target has no
 * follow flag and no prompt templates; an assistant target may have both. */
type EventSubscriptionTarget =
  | { kind: "workflow"; workflowId: string }
  | (AssistantChoice & {
      deliveryPolicy?: DeliveryPreferencesValue["deliveryPolicy"];
      pauseOnOverlap?: boolean;
      follow?: boolean;
      thread?: AssistantThreadPolicy;
      systemPrompt?: string;
      userPromptTemplate?: string;
    });

function StepHeader({ step, plan }: { step: Step; plan: { labels: string[]; count: Step } }) {
  return (
    <p className="text-xs font-medium text-muted">
      Step {step} of {plan.count} — {plan.labels[step - 1]}
    </p>
  );
}

/** Step 1: When, then Do. Advanced picks raw events under a disclosure. */
function WhenDoStep({ outcome, service, fixedService, fixedWorkflow, onWhenChange, onDoChange, onAdvanced }: {
  outcome: Outcome;
  service: WhenService;
  /** A place's service: the only When choice, selected. */
  fixedService: WhenService | undefined;
  /** A preselected workflow fixes Do on Run a workflow. */
  fixedWorkflow: boolean;
  onWhenChange: (next: WhenService | "schedule") => void;
  onDoChange: (next: Outcome) => void;
  onAdvanced: () => void;
}) {
  const when = outcome === "schedule" ? "schedule" : outcome === "advanced" ? null : service;
  const whenChoices = fixedService !== undefined ? WHEN_CHOICES.filter((c) => c.value === fixedService) : WHEN_CHOICES;
  const doChoices = DO_CHOICES.filter((c) => service === "slack" || !c.slackOnly);
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-ink">When</legend>
        {whenChoices.map((c) => (
          <label key={c.value} className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <input type="radio" name="wizard-when" checked={when === c.value} onChange={() => onWhenChange(c.value)} />
            {c.title}
          </label>
        ))}
      </fieldset>
      {when !== "schedule" && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-ink">Do</legend>
          {doChoices.map((c) => (
            <label key={c.value} className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
              <input
                type="radio"
                name="wizard-do"
                checked={outcome === c.value}
                disabled={fixedWorkflow && c.value !== "workflow"}
                onChange={() => onDoChange(c.value)}
              />
              {c.title}
            </label>
          ))}
        </fieldset>
      )}
      <details open={outcome === "advanced"} className="text-sm text-ink">
        <summary className="cursor-pointer text-sm text-muted">Advanced: pick events and filters</summary>
        <div className="mt-2 space-y-1">
          <p className="text-xs text-muted">Pick raw event keys and filters, then what Valet does.</p>
          <Button type="button" variant="secondary" size="sm" aria-pressed={outcome === "advanced"} onClick={onAdvanced}>
            Pick raw events
          </Button>
        </div>
      </details>
    </div>
  );
}

/**
 * The reply outcome's one config step: the channels to reply in (required,
 * unless "Any channel" is chosen), which assistant answers, the follow
 * toggle, and the optional prompt templates. No raw event key is shown. The
 * event is always `slack.app_mention`. Personal rules need the creator's
 * linked Slack user.
 *
 * Team assistant rules accept mentions from linked, current team members.
 */
function ReplyStep({
  fixedTeam = false,
  channels,
  onChannelsChange,
  anyChannel,
  onAnyChannelChange,
  target,
  onTargetChange,
  scopedTeam,
  audience,
  onAudienceChange,
  follow,
  onFollowChange,
  promptTemplates,
  onPromptTemplatesChange,
}: {
  fixedTeam?: boolean;
  channels: SelectedChannel[];
  onChannelsChange: (channels: SelectedChannel[]) => void;
  anyChannel: boolean;
  onAnyChannelChange: (v: boolean) => void;
  target: AssistantChoice;
  onTargetChange: (t: TargetChoice) => void;
  scopedTeam: { id: string; name: string } | undefined;
  audience: EventSubscriptionAudienceWire;
  onAudienceChange: (v: EventSubscriptionAudienceWire) => void;
  follow: boolean;
  onFollowChange: (v: boolean) => void;
  promptTemplates: PromptFieldsValue;
  onPromptTemplatesChange: (v: PromptFieldsValue) => void;
}) {
  // The server refuses a mention rule from a creator with no linked Slack
  // account, so warn here instead of at the failed create.
  const linksQ = useIdentityLinks();
  const slackLink = linksQ.data?.links.find((l) => l.provider === "slack");
  const slackUnlinked = slackLink !== undefined && !slackLink.linked;
  const reach = target.assistant === "org" ? "the org assistant" : "your assistant";
  const teamName = scopedTeam?.name ?? "the team";
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        {target.assistant === "team"
          ? "Valet replies with the organization’s Slack bot. The team owns and administers the assistant. Choose below who may invoke it by mention. A full member of your Slack workspace with no linked account runs as the person who set this up. Guests and people from other organizations are denied."
          : <>Valet replies only when <span className="text-ink">you</span> @-mention the app.
            Mentions by other people do not reach {reach}.</>}
      </p>
      {slackUnlinked && target.assistant !== "team" && (
        <p className="text-xs text-danger-500">
          Your Slack account is not linked, so Valet cannot reply to you yet. Link it in
          Integrations → Slack, then select Create.
        </p>
      )}

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Channels</p>
        <ChannelMultiSelect channels={channels} onChange={onChannelsChange} disabled={anyChannel} />
        {!anyChannel && (
          <p className="mt-1.5 text-xs text-muted">
            Select one or more channels. Valet replies only there.
          </p>
        )}
        {!fixedTeam && <label className="mt-2 flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={anyChannel}
            onChange={(e) => onAnyChannelChange(e.target.checked)}
          />
          <span>
            Any channel
            <span className="block text-xs text-muted">
              Reply to eligible @-mentions in every channel the app can see.
            </span>
          </span>
        </label>}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">Workspace</p>
        <div className="space-y-1.5">
          {!fixedTeam && <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <input
              type="radio"
              name="automation-reply-target"
              checked={target.assistant === "user"}
              onChange={() => onTargetChange({ kind: "assistant", assistant: "user" })}
            />
            Personal workspace
          </label>}

          {scopedTeam && (
            <div>
              <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
                <input type="radio" name="automation-reply-target" disabled={fixedTeam}
                  checked={target.assistant === "team"}
                  onChange={() => onTargetChange({ kind: "assistant", assistant: "team", teamId: scopedTeam.id })} />
                {scopedTeam.name}
              </label>

            </div>
          )}
          {!fixedTeam && <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <input
              type="radio"
              name="automation-reply-target"
              checked={target.assistant === "org"}
              onChange={() => onTargetChange({ kind: "assistant", assistant: "org" })}
            />
            The org assistant
          </label>}
        </div>
      </div>

      {target.assistant === "team" && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Who can mention it</p>
          <div className="space-y-1.5">
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
              <input
                type="radio"
                name="automation-reply-audience"
                checked={audience === "organization"}
                onChange={() => onAudienceChange("organization")}
              />
              Anyone in the organization
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
              <input
                type="radio"
                name="automation-reply-audience"
                checked={audience === "team"}
                onChange={() => onAudienceChange("team")}
              />
              Only members of {teamName}
            </label>
          </div>
          <p className="mt-1.5 text-xs text-muted">
            Either way, the assistant answers explicit mentions in the selected channels, and
            everyone in those channels sees the replies. While it keeps following a thread, it
            also reads later messages in a thread it has answered, from anyone in that thread.
            A sender outside the team cannot see or change the assistant's threads, settings,
            or credentials, but whatever they ask it to do runs with the team's access and
            tools. It answers questions and runs its tools. It does not run or change the
            team's workflows for senders outside the team.
          </p>
        </div>
      )}

      <label className="flex min-h-11 items-start gap-2 text-sm text-ink sm:min-h-0">
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
            new mention, whoever sends them.
          </span>
        </span>
      </label>

      <PromptFields
        idPrefix="automation-reply"
        value={promptTemplates}
        onChange={onPromptTemplatesChange}
        followsThread={follow}
      />
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
  // Debounce ~200ms so a keystroke burst is one lookup.
  const debounced = useDebouncedValue(query, 200);
  // The results are a popover, shown while the search input has focus — the
  // same pattern as the FilterEditor's single-value picker.
  const [open, setOpen] = useState(false);
  // Once the source reports it cannot resolve (Slack not connected, provider
  // error), latch into the free-text fallback and stop querying. Without the
  // latch, each keystroke re-keys the query, `reason` blinks undefined while
  // the refetch is in flight, and the input remounts mid-typing.
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);

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
              className="min-h-11 min-w-11 text-muted hover:text-ink sm:min-h-0 sm:min-w-0"
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
            // Same rule as the filter picker: a rejected lookup is empty too,
            // and inviting the app would not fix an outage. `reason` is read
            // inline rather than from the latched state, because that state is
            // set in an effect and lands one render late. Without the inline
            // read, an unconnected Slack painted the invite advice for one
            // frame before the fallback replaced it.
            <p className="px-2 py-1 text-xs text-muted">
              {optionsQ.data === undefined
                ? "Could not load the channels. Check your connection and try again."
                : optionsQ.data.reason !== undefined
                  ? optionsQ.data.reason
                  : NO_CHANNEL_MATCH_HELP}
            </p>
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
                className={`block min-h-11 w-full break-words px-2 py-1 text-left sm:min-h-0 text-sm text-ink hover:bg-hover ${
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
  allowAssistant,
  prompt,
  onPromptChange,
  promptTemplates,
  onPromptTemplatesChange,
}: {
  target: TargetChoice;
  onTargetChange: (t: TargetChoice) => void;
  scopedTeam: { id: string; name: string } | undefined;
  workflows: { id: string; name: string }[];
  isSchedule: boolean;
  allowWorkflow: boolean;
  allowAssistant: boolean;
  prompt: string;
  onPromptChange: (v: string) => void;
  promptTemplates: PromptFieldsValue;
  onPromptTemplatesChange: (v: PromptFieldsValue) => void;
}) {
  return (
    <div className="space-y-1.5">
      {allowAssistant && (
        <>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <input
              type="radio"
              name="automation-target"
              checked={target.kind === "assistant" && target.assistant === "user"}
              onChange={() => onTargetChange({ kind: "assistant", assistant: "user" })}
            />
            Notify your personal workspace
          </label>

          {/* Only the active workspace's team is offered. Targeting a different
              team is a workspace change, not a form field. */}
          {scopedTeam && (
            <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
              <input
                type="radio"
                name="automation-target"
                checked={target.kind === "assistant" && target.assistant === "team"}
                onChange={() =>
                  onTargetChange({ kind: "assistant", assistant: "team", teamId: scopedTeam.id })
                }
              />
              Notify {scopedTeam.name}
            </label>
          )}

          <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
            <input
              type="radio"
              name="automation-target"
              checked={target.kind === "assistant" && target.assistant === "org"}
              onChange={() => onTargetChange({ kind: "assistant", assistant: "org" })}
            />
            Notify the organization
          </label>
        </>
      )}
      {allowWorkflow && (
        <>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
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
                className="w-full min-w-0 truncate min-h-11 rounded border border-line bg-paper px-2 py-1.5 sm:min-h-0 text-sm text-ink"
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

      {/* A scheduled assistant run needs a prompt: nothing else tells the
          assistant what to do at the fire. An event rule carries the event as
          its context, so it needs none. */}
      {isSchedule && target.kind === "assistant" && (
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

      {/* An event rule that notifies an assistant may shape what the assistant
          reads. A schedule carries its own prompt above, and a workflow target
          keeps its prompts on its nodes. */}
      {!isSchedule && allowAssistant && target.kind === "assistant" && (
        <PromptFields
          idPrefix="automation"
          value={promptTemplates}
          onChange={onPromptTemplatesChange}
        />
      )}
    </div>
  );
}

function ReviewStep({
  routine,
  name,
  onNameChange,
  summary, when, scope, destination, workflowId, following, reviewAudience,
}: {
  routine: boolean;
  following?: boolean; reviewAudience?: string;
  when: string; scope: string; destination: string; workflowId?: string;
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
          placeholder={routine ? "Routine name" : "Name"}
          aria-label={routine ? "Routine name" : "Name"}
        />
      </div>
      <AutomationReview follow={following} audience={reviewAudience} workflowId={workflowId} when={when} scope={scope} result={summary} destination={destination} />
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
  if (target.assistant === "org") return "notify the org assistant";
  if (target.assistant === "team") {
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
