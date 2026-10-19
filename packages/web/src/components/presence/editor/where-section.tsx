/**
 * The editor's **Where** section (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 5): the thread policies as cards with one explanation each,
 * the thread picker inline in the pinned card, and, for a personal line
 * that a team line also covers, `When <team> also listens`.
 */
import type { AssistantThreadPolicy } from "@valet/shared";
import { useId } from "react";
import { cn } from "~/lib/cn";
import { ThreadPicker } from "../thread-picker";
import { text, type SentencePart } from "../sentences";
import {
  carriesSlackConversation,
  ownOptionLabel,
  SHARED_SLACK_THREAD_NOTE,
  subjectOptionLabel,
} from "../thread-policy-copy";
import { draftSubjectKind, effectiveWhere, type Draft } from "./draft";

type Mode = AssistantThreadPolicy["mode"];

/** The Where summary: `in a new thread each time`, `in the Platform CI thread`. */
export function whereSummaryParts(draft: Draft): SentencePart[] {
  const where = effectiveWhere(draft);
  if (where === null) return [text("in a thread you pick")];
  switch (where.mode) {
    case "new":
      return [text("in a new thread each time")];
    case "subject":
      return [text(`in ${subjectOptionLabel(draftSubjectKind(draft)).toLowerCase()}`)];
    case "own":
      return [text(draft.service === "schedule" ? "in this routine's thread" : "in its own thread")];
    case "existing": {
      const title = draft.whereTitle?.trim();
      if (title === undefined || title.length === 0) return [text("in the thread you picked")];
      return [text("in the "), { kind: "thread", text: title, sessionId: where.sessionId, threadId: where.threadId }, text(" thread")];
    }
  }
}

export function WhereSection({
  draft,
  onChange,
  workspace,
  overlapTeam,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  /** The workspace whose threads the picker lists. Absent hides the pinned card. */
  workspace: string | undefined;
  /** The team whose line also covers these events, for a personal line. */
  overlapTeam?: string;
}) {
  const id = useId();
  const routine = draft.service === "schedule";
  const subjectKind = draftSubjectKind(draft);
  const current = draft.whereChosen ? draft.where : effectiveWhere(draft);
  const mode: Mode = current === null ? "existing" : current.mode === "subject" && subjectKind === null ? "own" : current.mode;
  const unit = routine ? "routine" : "line";
  const pinned = current?.mode === "existing" ? current : null;
  const pinTitle = pinned !== null ? draft.whereTitle?.trim() : undefined;

  const cards: { mode: Mode; title: string; line: string }[] = [
    ...(!routine && subjectKind !== null
      ? [{ mode: "subject" as const, title: subjectOptionLabel(subjectKind), line: `Each ${subjectKind} gets its own thread; every event for it lands there.` }]
      : []),
    { mode: "new", title: "A new thread each time", line: routine ? "Every run starts fresh." : "Every event starts fresh." },
    { mode: "own", title: ownOptionLabel(routine ? "routine" : "presence"), line: `One running thread for this ${unit}.` },
    ...(workspace !== undefined || mode === "existing"
      ? [{
          mode: "existing" as const,
          title: pinTitle !== undefined && pinTitle.length > 0 ? `The ${pinTitle} thread` : "Pick a thread",
          line: `Pick an existing thread. If it is archived, this ${unit} stops until you pick another.`,
        }]
      : []),
  ];

  function choose(next: Mode) {
    if (next === "existing") onChange({ ...draft, where: pinned, whereChosen: true });
    else onChange({ ...draft, where: { mode: next }, whereChosen: true, whereTitle: undefined });
  }

  const keys = [...draft.events];
  return (
    <>
      <div role="radiogroup" aria-label="Where" className="grid gap-2">
        {cards.map((card) => {
          const on = mode === card.mode;
          const lineId = `${id}-line-${card.mode}`;
          return (
            <div
              key={card.mode}
              className={cn("rounded-lg border border-line px-3.5 py-3", on && "border-ink ring-1 ring-ink")}
            >
              <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5">
                <input
                  type="radio"
                  name={`${id}-where`}
                  className="row-span-2 mt-1"
                  aria-label={card.title}
                  aria-describedby={lineId}
                  checked={on}
                  onChange={() => choose(card.mode)}
                />
                <span className="text-[15px] font-medium text-ink">{card.title}</span>
                <span id={lineId} className="text-[13px] leading-snug text-muted">{card.line}</span>
              </label>
              {on && (card.mode === "own" || card.mode === "existing") && carriesSlackConversation(keys) && (
                <p className="ml-7 mt-1.5 text-xs text-muted">{SHARED_SLACK_THREAD_NOTE}</p>
              )}
              {on && card.mode === "existing" && workspace !== undefined && (
                <div className="ml-7 mt-2">
                  <ThreadPicker
                    workspace={workspace}
                    selectedThreadId={pinned?.threadId}
                    onPick={(policy, title) => onChange({ ...draft, where: policy, whereChosen: true, whereTitle: title })}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {overlapTeam !== undefined && draft.assistant === "user" && (
        <div role="radiogroup" aria-label={`When ${overlapTeam} also listens`} className="grid gap-1.5">
          <p className="text-xs text-muted">When {overlapTeam} also listens</p>
          <label className="flex min-h-11 items-start gap-2 text-sm text-ink sm:min-h-0">
            <input
              type="radio"
              name={`${id}-overlap`}
              className="mt-1"
              aria-label="Pause this line"
              checked={draft.deliveryPolicy !== "always"}
              onChange={() => onChange({ ...draft, deliveryPolicy: "ignoreIfMyTeamSubscribed", pauseOnOverlap: true })}
            />
            <span>
              Pause this line
              <span className="block text-xs text-muted">{overlapTeam} answers. This line stops until you turn it on again.</span>
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-2 text-sm text-ink sm:min-h-0">
            <input
              type="radio"
              name={`${id}-overlap`}
              className="mt-1"
              aria-label="Keep both"
              checked={draft.deliveryPolicy === "always"}
              onChange={() => onChange({ ...draft, deliveryPolicy: "always" })}
            />
            <span>
              Keep both
              <span className="block text-xs text-muted">Your assistant and {overlapTeam} both act.</span>
            </span>
          </label>
        </div>
      )}
    </>
  );
}
