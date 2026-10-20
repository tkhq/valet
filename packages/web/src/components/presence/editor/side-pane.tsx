/**
 * The editor's side pane (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 8): the sentence as it will read, a worked example, the
 * warnings, the permissions note, and the footer with Cancel and Create
 * or Save. On a phone the sentence card is a sticky header above the
 * form, and the rest sits under the form.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { EventSubscriptionCollisionsWire, EventSubscriptionWire } from "@valet/api/wire";
import { Button } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { Ref } from "../ref";
import { Sentence } from "../sentence";
import { eventInWords, SENTENCE_PLACE_FIELD_SET, type SentencePart } from "../sentences";

/** Why a proposal cannot turn on: the line it replaces is gone, or that
 * line is already off. */
export type StaleProposal = { kind: "gone" } | { kind: "off"; name: string };

/**
 * The review text for a stale proposal. The rule page and the editor's
 * review mode both show it. It follows the api's refusal
 * (`staleReplacement` in packages/api/src/routes/events.ts): turning the
 * proposal on while the replaced line is off could leave two versions
 * replying.
 */
export function staleProposalText(stale: StaleProposal): string {
  if (stale.kind === "gone") return "The line this proposal replaces is gone. Delete this proposal and make a new line.";
  return `${stale.name} is already off. Turning this on could leave two versions replying. Delete this proposal and ask the assistant for a new one.`;
}

export interface SidePaneProps {
  title: string;
  sentence: readonly SentencePart[];
  steps: readonly [string, string, string];
  /** The last create or save refused (`committed: false`) or saved with an overlap. */
  collisions?: { report: EventSubscriptionCollisionsWire; committed: boolean } | null;
  /** The service the line listens to, when it is not connected. */
  notConnected?: string;
  /** What the draft still lacks, as warnings: a missing event or name. */
  missing?: readonly string[];
  /** Review mode. `stale` is set when the line the proposal replaces is
   * gone or already off: the server refuses Turn on (409), so none shows. */
  review?: { replaces?: { id: string; name: string }; stale?: StaleProposal };
  editedAt?: number;
  /** Why Create or Save is off, or null when the draft is ready. */
  blocker: string | null;
  saveLabel: "Create" | "Save" | "Turn on";
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
  onSaveAnyway?: () => void;
  onDone?: () => void;
  confirmingDiscard: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** `Edited 3 days ago`. */
export function editedAgo(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < MINUTE) return "Edited just now";
  if (diff < HOUR) return `Edited ${count(Math.floor(diff / MINUTE), "minute")} ago`;
  if (diff < DAY) return `Edited ${count(Math.floor(diff / HOUR), "hour")} ago`;
  return `Edited ${count(Math.floor(diff / DAY), "day")} ago`;
}

function plural(words: string): string {
  return /(s|sh|ch|x)$/.test(words) ? `${words}es` : `${words}s`;
}

/** Shared events in words: `completed checks`, `mentions or pushes`. */
export function collisionWords(keys: readonly string[]): string {
  const words = [...new Set(keys.map((key) => plural(eventInWords(key).toLowerCase())))];
  return words.length <= 2 ? words.join(" or ") : `${words.slice(0, -1).join(", ")}, or ${words[words.length - 1]}`;
}

/** The place a colliding line names, or null when it listens everywhere. */
function collisionPlace(sub: EventSubscriptionWire): string | null {
  for (const field of SENTENCE_PLACE_FIELD_SET) {
    const filter = sub.filters.find((f) => f.field === field && (f.op === "eq" || f.op === "in"));
    if (filter === undefined) continue;
    if (typeof filter.value === "string") return filter.label?.trim() || filter.value;
    return filter.value.map((v, i) => filter.labels?.[i]?.trim() || v).join(" or ");
  }
  return null;
}

export function SentenceCard({ title, sentence, className }: { title: string; sentence: readonly SentencePart[]; className?: string }) {
  return (
    <div className={cn("rounded-[10px] border border-line bg-paper px-5 py-[18px]", className)}>
      <p className="mb-2 text-xs text-muted">{title}</p>
      <p data-testid="editor-sentence" aria-live="polite" className="text-xl font-medium leading-snug text-ink [overflow-wrap:anywhere]">
        <Sentence parts={sentence} links={false} />
      </p>
    </div>
  );
}

/** Everything in the side pane under the sentence card. */
export function SidePaneRest(props: SidePaneProps) {
  const reasonId = useId();
  const keepEditing = useRef<HTMLButtonElement>(null);
  const { collisions, review } = props;
  // The confirm can sit below the fold on a phone: bring it into view and
  // put focus on the safe choice.
  useEffect(() => {
    if (!props.confirmingDiscard) return;
    const button = keepEditing.current;
    button?.scrollIntoView?.({ block: "nearest" });
    button?.focus();
  }, [props.confirmingDiscard]);
  const committed = collisions?.committed === true;
  const blocking = collisions !== null && collisions !== undefined && !collisions.committed && collisions.report.blocking.length > 0;
  const stale = review?.stale !== undefined;
  const anyway = props.saveLabel === "Create" ? "Create anyway" : props.saveLabel === "Turn on" ? "Turn on anyway" : "Save anyway";

  let footer: ReactNode;
  if (props.confirmingDiscard) {
    footer = (
      <div role="group" aria-label="Discard your changes?" className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-sm font-medium text-ink">Discard your changes?</span>
        <Button ref={keepEditing} type="button" variant="secondary" onClick={props.onKeepEditing}>Keep editing</Button>
        <Button type="button" variant="danger" onClick={props.onDiscard}>Discard</Button>
      </div>
    );
  } else if (committed) {
    footer = (
      <div className="flex justify-end">
        <Button type="button" onClick={props.onDone}>Done</Button>
      </div>
    );
  } else {
    footer = (
      <div className="grid gap-1.5">
        {!stale && props.blocker !== null && (
          <p id={reasonId} className="text-right text-[13px] text-muted">{props.blocker}</p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-[13px] text-muted">{props.editedAt !== undefined ? editedAgo(props.editedAt) : ""}</span>
          <Button type="button" variant="secondary" onClick={props.onCancel} disabled={props.pending}>Cancel</Button>
          {!stale && blocking && props.onSaveAnyway !== undefined && (
            <Button type="button" variant="secondary" onClick={props.onSaveAnyway} disabled={props.pending || props.blocker !== null}>
              {anyway}
            </Button>
          )}
          {!stale && (
            <Button
              type="button"
              onClick={props.onSave}
              disabled={props.pending || props.blocker !== null}
              aria-describedby={props.blocker !== null ? reasonId : undefined}
            >
              {props.saveLabel}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-[10px] border border-line bg-paper px-5 py-[18px] text-sm leading-relaxed text-ink">
        <p className="mb-2 text-xs text-muted">For example</p>
        <ol className="grid gap-2">
          {/* The list is always the same three steps in the same order, so the index is a stable key. */}
          {props.steps.map((step, i) => (
            <li key={i} className="grid grid-cols-[20px_minmax(0,1fr)] items-baseline gap-2.5">
              <span aria-hidden="true" className="inline-grid h-5 w-5 place-items-center rounded-full bg-ink-wash text-[11px] text-muted">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </div>

      {review !== undefined && (
        <p role="note" className="border-l-2 border-accent-500 pl-3 text-[13px] text-ink">
          Proposed by the assistant.{" "}
          {review.stale !== undefined
            ? staleProposalText(review.stale)
            : review.replaces !== undefined
              ? <>Turning it on turns off <Ref kind="line" text={review.replaces.name} />.</>
              : "It stays off until you turn it on."}
        </p>
      )}

      {props.notConnected !== undefined && (
        <p className="border-l-2 border-accent-500 pl-3 text-[13px] text-ink">
          {props.notConnected} is not connected. Connect it in Integrations first.
        </p>
      )}

      {(props.missing ?? []).map((warning) => (
        <p key={warning} className="border-l-2 border-accent-500 pl-3 text-[13px] text-ink">{warning}</p>
      ))}

      {collisions !== null && collisions !== undefined && (
        <div className="grid gap-2">
          {[...collisions.report.blocking, ...collisions.report.overlapping].map((c) => {
            const place = collisionPlace(c.subscription);
            return (
              <p key={c.subscription.id} className="border-l-2 border-accent-500 pl-3 text-[13px] text-ink">
                <Ref kind="line" text={c.subscription.name} /> also acts on {collisionWords(c.sharedKeys)}
                {place !== null ? ` for ${place}` : ""}. <span className="text-muted">Both will run.</span>
              </p>
            );
          })}
          {blocking && (
            <p className="text-[13px] text-muted">
              Not saved yet. Narrow the conditions so they stay apart, or select {anyway}. Then both lines run.
            </p>
          )}
          {committed && <p className="text-[13px] text-muted">Saved.</p>}
        </div>
      )}

      <p className="text-xs text-muted">Uses this workspace's existing access. Saving grants nothing new.</p>
      {props.error !== null && <p role="alert" className="text-[13px] text-danger-500">{props.error}</p>}
      <div className="mt-auto pt-2">{footer}</div>
    </>
  );
}

/** The whole side pane, for the wide layout. */
export function SidePane(props: SidePaneProps) {
  return (
    <>
      <SentenceCard title={props.title} sentence={props.sentence} />
      <SidePaneRest {...props} />
    </>
  );
}
