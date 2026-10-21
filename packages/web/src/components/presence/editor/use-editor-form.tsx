/**
 * The state of one editor form (docs/specs/2026-10-16-presence-hub-design.md
 * Part H): the draft, its sections, the sentence it stores, and Create or
 * Save. Two surfaces render it. The sheet (`LineEditor`) creates, reviews,
 * and quick-edits from a row; the inline form (`InlineEditor`) edits a line
 * or a routine on its own page.
 *
 * The form reads the mode once, at mount, so the patch diffs against that
 * copy. A new mode needs a new mount (CLAUDE.md, mount-time state).
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { EventSubscriptionCollisionsWire, EventSubscriptionWire } from "@valet/api/wire";
import { useCreateEventSubscription, useEventCatalog, useEventSubscriptions, usePatchEventSubscription } from "~/api/events";
import { usePlugins } from "~/api/integrations";
import { usePinnedThreadTitle } from "~/api/rule";
import { useOrg, useTeams } from "~/api/settings";
import { useCreateSchedule, useUpdateSchedule, useWorkflows } from "~/api/workflows";
import { collisionsFromError } from "~/components/events/collision-notice";
import { EVENT_SERVICES, connectedServices } from "~/components/events/when-do-step";
import { wizardSentenceParts, wizardWhenParts } from "~/components/events/wizard-preview";
import { useActiveWorkspace } from "~/components/workspace-clause";
import { errorText } from "~/lib/error-text";
import { browserTimeZone } from "~/lib/time-zones";
import { teamName, type TeamLike } from "../presence-rows";
import { SERVICE_NAMES } from "../service-mark";
import { Sentence } from "../sentence";
import {
  partsText,
  presenceSentenceParts,
  presenceWhenParts,
  routineSentenceParts,
  scheduleInWords,
  text,
  type SentencePart,
  type ThreadTitles,
  type WorkflowNames,
} from "../sentences";
import { useSentenceNames } from "../use-sentence-names";
import { AppearsSection, appearsSummary } from "./appears-section";
import { DoSection, type AssistantOption } from "./do-section";
import {
  applyLinePatch,
  applyRoutinePatch,
  bodyFromDraft,
  draftForMode,
  draftKey,
  draftThread,
  draftWorkspace,
  exampleSteps,
  isEmptyBody,
  lineFromCreate,
  routineFromCreate,
  saveBlocker,
  scheduleCron,
  setService,
  suggestedName,
  type Draft,
  type EditorBody,
  type EditorMode,
} from "./draft";
import { NameSection } from "./name-section";
import { Section, type SectionId } from "./section";
import type { SidePaneProps, StaleProposal } from "./side-pane";
import { WhenSection } from "./when-section";
import { WhereSection, whereSummaryParts } from "./where-section";

/** What a Create or Save stored: a line or a routine, by its id. */
export interface EditorSaved {
  kind: "line" | "routine";
  id: string;
}

function lowerFirst(parts: readonly SentencePart[]): SentencePart[] {
  const [first, ...rest] = parts;
  if (first === undefined || first.kind !== "text") return [...parts];
  return [text(first.text.charAt(0).toLowerCase() + first.text.slice(1)), ...rest];
}

/** The line or routine the body stores, as the sentence parts it reads. */
function sentenceOf(
  body: EditorBody,
  draft: Draft,
  mode: EditorMode,
  context: { catalog: Parameters<typeof presenceSentenceParts>[1]; workflows: WorkflowNames; threads: ThreadTitles; names: ReturnType<typeof useSentenceNames> },
): SentencePart[] {
  const { catalog, workflows, threads, names } = context;
  switch (body.kind) {
    case "create-line":
      return wizardSentenceParts({ kind: "presence", sub: lineFromCreate(body.body), service: draft.service === "schedule" ? "slack" : draft.service }, catalog, workflows, threads);
    case "patch-line":
      return mode.kind === "edit" || mode.kind === "review"
        ? presenceSentenceParts(applyLinePatch(mode.line, body.body), catalog, workflows, threads, names)
        : [];
    case "create-routine":
      return wizardSentenceParts({ kind: "routine", routine: routineFromCreate(body.body) }, catalog, workflows, threads);
    case "patch-routine":
      return mode.kind === "edit-routine" ? routineSentenceParts(applyRoutinePatch(mode.routine, body.body), workflows, threads) : [];
  }
}

/** The team whose line also covers this personal line's events, by name. */
function overlapTeamName(
  draft: Draft,
  mode: EditorMode,
  subs: readonly EventSubscriptionWire[],
  teams: readonly TeamLike[] | undefined,
): string | undefined {
  if (draft.service === "schedule" || draft.doKind === "workflow" || draft.assistant !== "user") return undefined;
  if ((mode.kind === "edit" || mode.kind === "review") && mode.line.ownerType !== "user") return undefined;
  const mine = new Set((teams ?? []).filter((t) => t.callerRole !== null).map((t) => t.id));
  const self = mode.kind === "edit" || mode.kind === "review" ? mode.line.id : undefined;
  const other = subs.find((o) =>
    o.id !== self && o.ownerType === "team" && o.enabled && o.target.kind === "assistant" && mine.has(o.ownerId) &&
    o.eventKeys.some((key) => draft.events.has(key)));
  return other === undefined ? undefined : teamName(teams, other.ownerId);
}

/** Which sections show their body, and the toggle a section row offers. */
export interface SectionLayout {
  isOpen(id: SectionId): boolean;
  /** Omitted when every section stays open: the rows then offer no toggle. */
  toggle?(id: SectionId): void;
}

export interface EditorFormOptions {
  onSaved?(result: EditorSaved): void;
  /** The form is done: a discard, an empty save, or Done after an overlap. */
  onFinish(): void;
  /** True for the inline form, which stays open and clean after a save. */
  inline?: boolean;
}

export interface EditorForm {
  mode: EditorMode;
  dirty: boolean;
  /** True after a save that stored the line but reported overlaps. */
  frozen: boolean;
  pending: boolean;
  routine: boolean;
  heading: string;
  sentence: SentencePart[];
  sideProps: SidePaneProps;
  /** Asks to close: a pending request finishes first, and a dirty draft asks first. */
  requestClose(): void;
  formRef: RefObject<HTMLFieldSetElement | null>;
  sections(layout: SectionLayout, disabled?: boolean): ReactNode;
}

export function useEditorForm(openedMode: EditorMode, { onSaved, onFinish, inline = false }: EditorFormOptions): EditorForm {
  // The mode as it was at mount. Launchers pass the live query row, which a
  // refetch replaces while the form is open. The draft seeds from this copy,
  // so the patch diffs against it too; a diff against a newer row would send
  // the old value of a field another tab changed.
  const [mode] = useState(openedMode);
  const catalogQ = useEventCatalog();
  const services = catalogQ.data?.services ?? [];
  const pluginsQ = usePlugins();
  const connected = connectedServices(pluginsQ.isError ? undefined : pluginsQ.data?.plugins);
  const workflowsQ = useWorkflows();
  const workflows = workflowsQ.data?.workflows ?? [];
  const names = useSentenceNames();
  const ws = useActiveWorkspace();
  const orgQ = useOrg();
  const teamsQ = useTeams();
  const teams = teamsQ.data?.teams;
  const subsQ = useEventSubscriptions();
  const createLine = useCreateEventSubscription();
  const patchLine = usePatchEventSubscription();
  const createRoutine = useCreateSchedule();
  const updateRoutine = useUpdateSchedule();
  // A preselected team (the team Slack setup) wins over the active workspace.
  const fixedTeam = mode.kind === "create" ? mode.preselected?.team : undefined;
  const scopedTeam = fixedTeam ?? (ws?.kind === "team" ? ws.team : undefined);

  const storedPolicy = mode.kind === "edit" || mode.kind === "review"
    ? (mode.line.target.kind === "assistant" ? mode.line.target.thread : undefined)
    : mode.kind === "edit-routine" ? mode.routine.detail.thread : undefined;
  const pinTitles = usePinnedThreadTitle(storedPolicy);

  // Read at mount (see the header comment).
  const [draft, setDraft] = useState<Draft>(() => draftForMode(mode, { teamId: scopedTeam?.id, timezone: browserTimeZone() }));
  const [baseline, setBaseline] = useState(() => draftKey(draft));
  const dirty = draftKey(draft) !== baseline;
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef<HTMLFieldSetElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [collisions, setCollisions] = useState<{ report: EventSubscriptionCollisionsWire; committed: boolean } | null>(null);
  // A create or save that stored the line but reported overlaps. The form
  // freezes on the stored line, and Done (or Esc) reports it and finishes.
  const [stored, setStored] = useState<EditorSaved | null>(null);
  const reported = useRef(false);
  const frozen = stored !== null;

  // A change the editor makes for the reader (a default that loads late)
  // moves the baseline too, so it does not count as an edit.
  function auto(next: Draft) {
    setDraft(next);
    if (!dirty) setBaseline(draftKey(next));
  }

  // The default service is the first connected one, else a schedule (Part H
  // step 2). The connected services load after mount, so the default
  // applies once they arrive, unless a place, a schedule, or the reader
  // already chose.
  const serviceTouched = useRef(
    mode.kind !== "create" || mode.preselected?.place !== undefined || mode.preselected?.schedule === true || fixedTeam !== undefined,
  );
  useEffect(() => {
    if (connected === null || serviceTouched.current) return;
    serviceTouched.current = true;
    const first = EVENT_SERVICES.find((s) => connected.has(s));
    const next = first ?? "schedule";
    if (next !== draft.service) auto(setService(draft, next));
  });

  // A new line starts on the active workspace's assistant and follows a
  // workspace switch until the reader picks one (CLAUDE.md: mount-time state).
  const assistantTouched = useRef(mode.kind !== "create" || fixedTeam !== undefined);
  const scopedTeamId = scopedTeam?.id;
  useEffect(() => {
    if (assistantTouched.current) return;
    const assistant = scopedTeamId !== undefined ? "team" : "user";
    if (draft.assistant === assistant && (draft.teamId ?? undefined) === scopedTeamId) return;
    auto({ ...draft, assistant, teamId: scopedTeamId ?? null });
    // Only a workspace change resyncs; the draft is read, not watched.
  }, [scopedTeamId]);

  // A stored pin's title loads after mount.
  const pinTitle = storedPolicy?.mode === "existing" ? pinTitles[storedPolicy.threadId]?.title ?? undefined : undefined;
  useEffect(() => {
    if (pinTitle === undefined || draft.whereTitle !== undefined) return;
    if (draft.where?.mode !== "existing") return;
    auto({ ...draft, whereTitle: pinTitle });
  }, [pinTitle]);

  function change(next: Draft) {
    // The line is stored; a change here would have no Save to send it.
    if (frozen) return;
    if (next.assistant !== draft.assistant || next.teamId !== draft.teamId) assistantTouched.current = true;
    setDraft(next);
    setCollisions(null);
    setError(null);
  }

  const catalog = catalogQ.data?.services;
  const routine = draft.service === "schedule";
  const threads: ThreadTitles = {
    ...pinTitles,
    ...(draft.where?.mode === "existing" && draft.whereTitle !== undefined ? { [draft.where.threadId]: { title: draft.whereTitle } } : {}),
  };

  // The When in words, for the summary, the suggested name, and the example.
  const unnamed = bodyFromDraft(draft, mode);
  // A followed Slack thread reads as the reply it waits for (Part H step 3).
  const followed = draft.threadFollow ? draftThread(draft, names) : null;
  const threadWhen = followed !== null && followed.channelLabel.length > 0
    ? `a reply in one Slack thread in ${followed.channelLabel}`
    : "a reply in one Slack thread";
  const whenParts: SentencePart[] = draft.threadFollow
    ? [text(threadWhen)]
    : routine
    ? [text(scheduleCron(draft.schedule).length > 0 ? scheduleInWords(scheduleCron(draft.schedule), draft.schedule.timezone) : "On a schedule")]
    : unnamed.kind === "create-line"
      ? lowerFirst(wizardWhenParts({ kind: "presence", sub: lineFromCreate(unnamed.body), service: draft.service === "schedule" ? "slack" : draft.service }, catalog))
      : unnamed.kind === "patch-line" && (mode.kind === "edit" || mode.kind === "review")
        ? presenceWhenParts(applyLinePatch(mode.line, unnamed.body), catalog, names)
        : [];
  const workflowName = workflows.find((w) => w.id === draft.workflowId)?.name;
  const suggestion = routine
    ? draft.doKind === "workflow" ? workflowName ?? "" : suggestedName([text(draft.instructions.split("\n")[0] ?? "")])
    : draft.events.size > 0 ? suggestedName(whenParts) : "";
  const nameValue = draft.nameEdited ? draft.name : suggestion;
  const ready: Draft = { ...draft, name: nameValue };
  const body = bodyFromDraft(ready, mode);
  const sentence = sentenceOf(body, ready, mode, { catalog, workflows, threads, names });

  // A place's own service counts as connected: the place exists, so its events arrive.
  const placeService = mode.kind === "create" ? mode.preselected?.place?.service : undefined;
  const serviceConnected = draft.service === "schedule" || draft.service === placeService || connected === null || connected.has(draft.service);
  const blocker = saveBlocker(ready, mode, { connected: serviceConnected, services });
  // A proposal whose replaced line is gone or already off cannot turn on:
  // the server refuses it (409). Unknown while the lines load.
  const replacesId = mode.kind === "review"
    ? (mode.line.target.kind === "assistant" ? mode.line.target.replaces : undefined) ?? mode.replaces?.id
    : undefined;
  const replacedRow = replacesId === undefined ? undefined : subsQ.data?.subscriptions.find((sub) => sub.id === replacesId);
  const staleProposal: StaleProposal | undefined = replacesId === undefined || subsQ.data === undefined || replacedRow?.enabled === true
    ? undefined
    : replacedRow === undefined ? { kind: "gone" } : { kind: "off", name: replacedRow.name };
  const pending = createLine.isPending || patchLine.isPending || createRoutine.isPending || updateRoutine.isPending;

  const assistants: AssistantOption[] = [
    { value: "user", label: "Your assistant" },
    ...(scopedTeam !== undefined ? [{ value: "team" as const, label: `${scopedTeam.name}'s assistant`, teamId: scopedTeam.id }] : []),
    ...(!routine && orgQ.data?.features.organizations === true ? [{ value: "org" as const, label: "The organization's assistant" }] : []),
  ];

  function requestClose() {
    // A request in flight finishes first: finishing would unmount the form
    // and drop its success handler, so `onSaved` would never run.
    if (pending) return;
    if (frozen) done();
    else if (dirty) setConfirming(true);
    else onFinish();
  }

  function saved(result: EditorSaved) {
    if (reported.current) return;
    reported.current = true;
    onSaved?.(result);
  }

  /** Finishes a frozen form and reports the stored line once. */
  function done() {
    if (stored !== null) saved(stored);
    onFinish();
  }

  /** After a save: the sheet closes. The inline form stays open and reads
   * clean until the refetched row reseeds it. */
  function afterSave(result: EditorSaved) {
    if (!inline) {
      saved(result);
      onFinish();
      return;
    }
    onSaved?.(result);
    setBaseline(draftKey(draft));
  }

  function save(allowCollision = false) {
    if (blocker !== null || pending || frozen || staleProposal !== undefined) return;
    if (isEmptyBody(body)) {
      onFinish();
      return;
    }
    setError(null);
    const lineHandlers = {
      onSuccess: (resp: { id: string; collisions?: EventSubscriptionCollisionsWire }) => {
        if (resp.collisions !== undefined) {
          setCollisions({ report: resp.collisions, committed: true });
          setStored({ kind: "line", id: resp.id });
          setConfirming(false);
          return;
        }
        afterSave({ kind: "line", id: resp.id });
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
    const allow = allowCollision ? { allowCollision: true } : {};
    switch (body.kind) {
      case "create-line":
        createLine.mutate({ ...body.body, ...allow }, lineHandlers);
        return;
      case "patch-line":
        patchLine.mutate({ id: body.id, body: { ...body.body, ...allow } }, lineHandlers);
        return;
      case "create-routine":
        createRoutine.mutate(body.body, {
          onSuccess: (resp) => afterSave({ kind: "routine", id: resp.schedule.scheduleId }),
          onError: (err) => setError(errorText(err)),
        });
        return;
      case "patch-routine":
        updateRoutine.mutate({ id: body.id, body: body.body }, {
          onSuccess: () => afterSave({ kind: "routine", id: body.id }),
          onError: (err) => setError(errorText(err)),
        });
        return;
    }
  }

  const heading = mode.kind === "edit" || mode.kind === "review" ? mode.line.name : mode.kind === "edit-routine" ? mode.routine.name : nameValue.trim() || "New";
  const appears = appearsSummary(draft.appearance);
  const doSummary = draft.doKind === "reply" ? "reply" : draft.doKind === "work" ? "work on it" : workflowName !== undefined ? `run ${workflowName}` : "run a workflow";

  const sideProps: SidePaneProps = {
    title: routine ? "This routine reads" : "This line reads",
    sentence,
    steps: exampleSteps(ready, { when: partsText(whenParts), workflow: workflowName }),
    collisions,
    notConnected: mode.kind === "create" && !serviceConnected ? SERVICE_NAMES[draft.service] : undefined,
    missing: [
      ...(!routine && draft.events.size === 0 ? ["No event is picked yet. Pick at least one in When."] : []),
      ...(nameValue.trim().length === 0 ? [`This ${routine ? "routine" : "line"} has no name yet. Give it one in Name.`] : []),
    ],
    review: mode.kind === "review" ? { replaces: mode.replaces, stale: staleProposal } : undefined,
    editedAt: mode.kind === "edit" || mode.kind === "review" ? mode.line.updatedAt : undefined,
    blocker,
    saveLabel: mode.kind === "create" ? "Create" : mode.kind === "review" ? "Turn on" : "Save",
    pending,
    error,
    // The inline form has nothing to close: Cancel drops the changes.
    onCancel: inline ? onFinish : requestClose,
    onSave: () => save(),
    onSaveAnyway: () => save(true),
    onDone: done,
    names,
    confirmingDiscard: confirming,
    onKeepEditing: () => setConfirming(false),
    onDiscard: onFinish,
  };

  function sections({ isOpen, toggle }: SectionLayout, disabled = false): ReactNode {
    const row = (id: SectionId) => ({ open: isOpen(id), ...(toggle !== undefined ? { onToggle: () => toggle(id) } : {}) });
    return (
      // After a save with overlaps the line is stored: the form reads it, and nothing in it changes.
      // While a save is in flight the form is locked too: a change made then
      // would diff against the row loaded before the save, and a revert to it
      // would be dropped.
      <fieldset ref={formRef} disabled={disabled || frozen || pending} className="m-0 min-w-0 border-0 p-0">
        <Section
          id="when"
          name="When"
          summary={<Sentence parts={whenParts} links={false} />}
          muted={!routine && draft.events.size === 0}
          {...row("when")}
        >
          <WhenSection
            draft={draft}
            mode={mode}
            onChange={change}
            services={services}
            catalogLoading={catalogQ.isLoading}
            catalogError={catalogQ.error != null}
            connected={connected}
            names={names}
            onServicePicked={() => { serviceTouched.current = true; }}
          />
        </Section>
        <Section id="do" name="Do" summary={doSummary} {...row("do")}>
          <DoSection
            draft={draft}
            mode={mode}
            onChange={change}
            services={services}
            workflows={workflows}
            assistants={assistants}
            teamName={scopedTeam?.name}
          />
        </Section>
        {draft.doKind === "workflow" ? (
          <Section id="where" name="Where" summary="Set by the workflow" muted fixed open={false} />
        ) : (
          <Section
            id="where"
            name="Where"
            summary={<Sentence parts={whereSummaryParts(draft)} links={false} />}
            muted={!draft.whereChosen}
            {...row("where")}
          >
            <WhereSection
              draft={draft}
              onChange={change}
              workspace={draftWorkspace(draft, mode)}
              overlapTeam={overlapTeamName(draft, mode, subsQ.data?.subscriptions ?? [], teams)}
            />
          </Section>
        )}
        {!routine && (
          <Section id="appears" name="Appears as" summary={appears.text} muted={appears.muted} {...row("appears")}>
            <AppearsSection value={draft.appearance} onChange={(appearance) => change({ ...draft, appearance })} workflow={draft.doKind === "workflow"} />
          </Section>
        )}
        <Section
          id="name"
          name="Name"
          summary={nameValue.trim() || "No name yet"}
          muted={nameValue.trim().length === 0}
          {...row("name")}
        >
          <NameSection
            name={nameValue}
            edited={draft.nameEdited}
            suggestion={mode.kind === "create" ? suggestion : ""}
            onChange={(name) => change({ ...draft, name, nameEdited: true })}
            onUseSuggestion={() => change({ ...draft, name: "", nameEdited: false })}
          />
        </Section>
      </fieldset>
    );
  }

  return { mode, dirty, frozen, pending, routine, heading, sentence, sideProps, requestClose, formRef, sections };
}
