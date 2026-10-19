/**
 * The editor (docs/specs/2026-10-16-presence-hub-design.md Part H): one
 * full-height sheet that creates and edits a line of presence or a
 * routine. The form on the left lists the sections When, Do, Where,
 * Appears as, and Name; the side pane on the right reads the sentence the
 * draft will store, a worked example, the warnings, and Create or Save.
 *
 * The sheet mounts when it opens, so the draft seeds from `mode` at open
 * time. A new mode needs a new open. Esc, Cancel, and a click outside close
 * it; a draft with changes asks `Discard your changes?` first.
 */
import { useEffect, useRef, useState } from "react";
import type { EventSubscriptionCollisionsWire, EventSubscriptionWire } from "@valet/api/wire";
import { useCreateEventSubscription, useEventCatalog, useEventSubscriptions, usePatchEventSubscription } from "~/api/events";
import { usePlugins } from "~/api/integrations";
import { usePinnedThreadTitle } from "~/api/rule";
import { useOrg, useTeams } from "~/api/settings";
import { useCreateSchedule, useUpdateSchedule, useWorkflows } from "~/api/workflows";
import { collisionsFromError } from "~/components/events/collision-notice";
import { EVENT_SERVICES, connectedServices } from "~/components/events/when-do-step";
import { wizardSentenceParts, wizardWhenParts } from "~/components/events/wizard-preview";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/primitives";
import { useActiveWorkspace } from "~/components/workspace-clause";
import { errorText } from "~/lib/error-text";
import { browserTimeZone } from "~/lib/time-zones";
import { cn } from "~/lib/cn";
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
import { SentenceCard, SidePane, SidePaneRest, type SidePaneProps } from "./side-pane";
import { useIsPhone } from "./use-is-phone";
import { WhenSection } from "./when-section";
import { WhereSection, whereSummaryParts } from "./where-section";

export type { EditorMode } from "./draft";

/** What a Create or Save stored: a line or a routine, by its id. */
export interface EditorSaved {
  kind: "line" | "routine";
  id: string;
}

export function LineEditor(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  mode: EditorMode;
  onSaved?(result: EditorSaved): void;
  /** Where focus goes when the sheet closes, for a launcher that restores it itself. */
  onCloseAutoFocus?(event: Event): void;
}) {
  if (!props.open) return null;
  return <EditorSheet {...props} />;
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

function EditorSheet({ onOpenChange, mode, onSaved, onCloseAutoFocus }: {
  onOpenChange(open: boolean): void;
  mode: EditorMode;
  onSaved?(result: EditorSaved): void;
  onCloseAutoFocus?(event: Event): void;
}) {
  const phone = useIsPhone();
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

  // Read at mount, which is open time (see the header comment).
  const [draft, setDraft] = useState<Draft>(() => draftForMode(mode, { teamId: scopedTeam?.id, timezone: browserTimeZone() }));
  const [baseline, setBaseline] = useState(() => draftKey(draft));
  const dirty = draftKey(draft) !== baseline;
  const [openSection, setOpenSection] = useState<SectionId | null>(mode.initialSection ?? (mode.kind === "create" ? "when" : null));
  const [confirming, setConfirming] = useState(false);
  // A section named at open time scrolls into view, so a `Change` link
  // under Where lands on Where and not on the top of the form.
  const initialSection = mode.initialSection;
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (initialSection === undefined) return;
    const el = formRef.current?.querySelector(`[data-section="${initialSection}"]`);
    if (el instanceof HTMLElement && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start" });
  }, [initialSection]);
  const [error, setError] = useState<string | null>(null);
  const [collisions, setCollisions] = useState<{ report: EventSubscriptionCollisionsWire; committed: boolean } | null>(null);

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
  const followed = draft.threadFollow ? draftThread(draft) : null;
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
  const blocker = saveBlocker(ready, mode, { connected: serviceConnected });
  const pending = createLine.isPending || patchLine.isPending || createRoutine.isPending || updateRoutine.isPending;

  const assistants: AssistantOption[] = [
    { value: "user", label: "Your assistant" },
    ...(scopedTeam !== undefined ? [{ value: "team" as const, label: `${scopedTeam.name}'s assistant`, teamId: scopedTeam.id }] : []),
    ...(!routine && orgQ.data?.features.organizations === true ? [{ value: "org" as const, label: "The organization's assistant" }] : []),
  ];

  function close() {
    onOpenChange(false);
  }

  function requestClose() {
    if (dirty && collisions?.committed !== true) setConfirming(true);
    else close();
  }

  function saved(result: EditorSaved) {
    onSaved?.(result);
  }

  function save(allowCollision = false) {
    if (blocker !== null || pending) return;
    if (isEmptyBody(body)) {
      close();
      return;
    }
    setError(null);
    const lineHandlers = {
      onSuccess: (resp: { id: string; collisions?: EventSubscriptionCollisionsWire }) => {
        saved({ kind: "line", id: resp.id });
        if (resp.collisions !== undefined) {
          setCollisions({ report: resp.collisions, committed: true });
          return;
        }
        close();
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
          onSuccess: (resp) => {
            saved({ kind: "routine", id: resp.schedule.scheduleId });
            close();
          },
          onError: (err) => setError(errorText(err)),
        });
        return;
      case "patch-routine":
        updateRoutine.mutate({ id: body.id, body: body.body }, {
          onSuccess: () => {
            saved({ kind: "routine", id: body.id });
            close();
          },
          onError: (err) => setError(errorText(err)),
        });
        return;
    }
  }

  const toggle = (id: SectionId) => () => setOpenSection((cur) => (cur === id ? null : id));
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
    review: mode.kind === "review" ? { replaces: mode.replaces } : undefined,
    editedAt: mode.kind === "edit" || mode.kind === "review" ? mode.line.updatedAt : undefined,
    blocker,
    saveLabel: mode.kind === "create" ? "Create" : mode.kind === "review" ? "Turn on" : "Save",
    pending,
    error,
    onCancel: requestClose,
    onSave: () => save(),
    onSaveAnyway: () => save(true),
    onDone: close,
    confirmingDiscard: confirming,
    onKeepEditing: () => setConfirming(false),
    onDiscard: close,
  };

  const form = (
    <>
      <div className="mb-5 flex items-baseline justify-between gap-4">
        <DialogTitle className="min-w-0 text-xl font-medium text-ink [overflow-wrap:anywhere]">{heading}</DialogTitle>
        {phone
          ? <Button type="button" variant="ghost" size="sm" onClick={requestClose}>Close</Button>
          : <span className="shrink-0 text-[13px] text-muted">Esc to close</span>}
      </div>
      <DialogDescription className="sr-only">
        Choose when Valet acts, what it does, and where. The side pane reads the result.
      </DialogDescription>
      <div ref={formRef}>
        <Section
          id="when"
          name="When"
          summary={<Sentence parts={whenParts} links={false} />}
          muted={!routine && draft.events.size === 0}
          open={openSection === "when"}
          onToggle={toggle("when")}
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
        <Section id="do" name="Do" summary={doSummary} open={openSection === "do"} onToggle={toggle("do")}>
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
          <Section id="where" name="Where" summary="Set by the workflow" muted fixed open={false} onToggle={() => {}} />
        ) : (
          <Section
            id="where"
            name="Where"
            summary={<Sentence parts={whereSummaryParts(draft)} links={false} />}
            muted={!draft.whereChosen}
            open={openSection === "where"}
            onToggle={toggle("where")}
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
          <Section id="appears" name="Appears as" summary={appears.text} muted={appears.muted} open={openSection === "appears"} onToggle={toggle("appears")}>
            <AppearsSection value={draft.appearance} onChange={(appearance) => change({ ...draft, appearance })} workflow={draft.doKind === "workflow"} />
          </Section>
        )}
        <Section
          id="name"
          name="Name"
          summary={nameValue.trim() || "No name yet"}
          muted={nameValue.trim().length === 0}
          open={openSection === "name"}
          onToggle={toggle("name")}
        >
          <NameSection
            name={nameValue}
            edited={draft.nameEdited}
            suggestion={mode.kind === "create" ? suggestion : ""}
            onChange={(name) => change({ ...draft, name, nameEdited: true })}
            onUseSuggestion={() => change({ ...draft, name: "", nameEdited: false })}
          />
        </Section>
      </div>
    </>
  );

  return (
    <Dialog open onOpenChange={(next) => { if (!next) requestClose(); }}>
      <DialogContent
        hideClose
        onCloseAutoFocus={onCloseAutoFocus}
        data-layout={phone ? "phone" : "wide"}
        className={cn(
          "h-[100dvh] max-h-[100dvh] w-full max-w-[1180px] gap-0 overflow-hidden p-0",
          "grid-rows-[minmax(0,1fr)] sm:h-[calc(100dvh-4rem)] sm:max-h-[calc(100dvh-4rem)] sm:w-[calc(100%-2rem)]",
          "max-sm:rounded-none max-sm:border-0",
          phone ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,7fr)_minmax(0,5fr)]",
        )}
      >
        {phone ? (
          <div className="min-h-0 overflow-y-auto">
            <div data-testid="editor-phone-header" className="sticky top-0 z-10 border-b border-line bg-neutral-100 px-4 py-3 dark:bg-neutral-900">
              <SentenceCard title={sideProps.title} sentence={sentence} />
            </div>
            <div className="px-4 py-6">{form}</div>
            <div className="flex flex-col gap-5 bg-neutral-100 px-4 py-6 dark:bg-neutral-900">
              <SidePaneRest {...sideProps} />
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 overflow-y-auto border-r border-line px-9 py-7">{form}</div>
            <aside aria-label="Preview" className="flex min-h-0 flex-col gap-5 overflow-y-auto bg-neutral-100 px-8 py-7 dark:bg-neutral-900">
              <SidePane {...sideProps} />
            </aside>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
