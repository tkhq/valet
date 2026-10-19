/**
 * The problem state of a line of presence or a routine
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 5, Part D): a badge
 * for every list, and the page text with the thread picker inline.
 *
 * The problem with an inline fix is a pinned thread that no longer accepts
 * deliveries. The api reports it as the pin text: a line's `problem`, a
 * routine's `disabledReason`. Any other text, such as a routine the
 * scheduler turned off for an empty prompt, shows as written.
 */
import type { ReactNode } from "react";
import type { AssistantThreadPolicy } from "@valet/shared";
import { Badge } from "~/components/primitives";
import { Ref } from "./ref";
import { Sentence } from "./sentence";
import type { SentencePart } from "./sentences";
import { ThreadPicker } from "./thread-picker";

/** The dead-letter text the api stores when a pin cannot take a delivery.
 * The web compares against it and never shows it. */
export const PIN_UNAVAILABLE = "Pick another thread in Presence.";

/** The pin text the api stored before the current text. Rows dead-lettered
 * then keep it, so the web still matches it. */
// copy-lint: allow rule
export const PIN_UNAVAILABLE_LEGACY = "Pick another thread for this rule in Presence.";

/** Whether a problem or reason is the pin text, current or legacy. */
export function isPinProblem(text: string | null | undefined): boolean {
  return text === PIN_UNAVAILABLE || text === PIN_UNAVAILABLE_LEGACY;
}

/** The words after the thread's name in the pin problem line. */
const pinProblemTail = " is archived. Pick another thread:";

function hasTitle(title: string | undefined): title is string {
  return title !== undefined && title.trim().length > 0;
}

/** The problem line for an archived pin. Without a title it names `The pinned thread`. */
export function pinProblemText(threadTitle?: string): string {
  return `${hasTitle(threadTitle) ? threadTitle : "The pinned thread"}${pinProblemTail}`;
}

/** The badge a list row shows for a rule with a problem. Nothing otherwise. */
export function ProblemBadge({ problem }: { problem: string | null | undefined }) {
  if (problem === undefined || problem === null || problem.length === 0) return null;
  return (
    <Badge variant="danger" title={isPinProblem(problem) ? pinProblemText() : problem}>
      {isPinProblem(problem) ? "Thread archived" : "Problem"}
    </Badge>
  );
}

/**
 * The page text for a rule with a problem. For a pin problem it shows the
 * thread picker inline, so one choice fixes the rule. Another problem shows
 * its own text.
 */
export function ThreadProblem({
  problem,
  threadTitle,
  workspace,
  onPick,
  pending = false,
  error,
  readOnly = false,
  readOnlyText = "Only its owner can change this.",
  variant = "box",
  lead,
  leadParts,
  threadId,
  action,
}: {
  problem: string;
  /** Muted words before the problem text, such as `In acme/api,`. */
  lead?: string;
  /** `lead` as parts, with the place as a token. Wins over `lead`. */
  leadParts?: readonly SentencePart[];
  /** The archived pin's id. With it and a title, the title reads as a thread token. */
  threadId?: string;
  /** The archived pin's title, when the caller knows it. */
  threadTitle?: string;
  /** The viewer may not change the rule: no picker, and the text names who can. */
  readOnly?: boolean;
  /** Who may change it, for a read-only viewer. */
  readOnlyText?: string;
  /** The workspace key whose threads the picker lists. Absent hides the picker. */
  workspace: string | undefined;
  onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>) => void;
  pending?: boolean;
  error?: string | null;
  /** `box` frames the problem on a page of its own. `inline` sits under a
   * row in a list, without the frame. */
  variant?: "box" | "inline";
  /** A control after a problem that has no picker, such as the routine page's `Edit`. */
  action?: ReactNode;
}) {
  const pin = isPinProblem(problem);
  const text = pin ? pinProblemText(threadTitle) : problem;
  const body = (
    <>
      <p role="alert" className="text-sm text-danger-600 dark:text-danger-500">
        {leadParts !== undefined
          ? <span className="text-muted"><Sentence parts={leadParts} />{" "}</span>
          : lead !== undefined && <span className="text-muted">{`${lead} `}</span>}
        {pin && threadId !== undefined && hasTitle(threadTitle)
          ? <><Ref kind="thread" text={threadTitle} to="/threads/$threadId" params={{ threadId }} />{pinProblemTail}</>
          : text}
      </p>
      {pin && readOnly && <p className="text-xs text-muted">{readOnlyText}</p>}
      {pin && !readOnly && workspace !== undefined && <ThreadPicker workspace={workspace} onPick={(policy) => onPick(policy)} />}
      {pin && !readOnly && workspace === undefined && (
        <p className="text-xs text-muted">Select Edit, then choose another option under Where.</p>
      )}
      {!pin && action}
      {pending && <p className="text-xs text-muted">Saving…</p>}
      {error && <p role="alert" className="text-xs text-danger-500">{error}</p>}
    </>
  );
  if (variant === "inline") {
    return <div role="group" aria-label="Problem" className="mt-2 space-y-2">{body}</div>;
  }
  return (
    <section aria-label="Problem" className="space-y-2 rounded-md border border-danger-500 bg-danger-wash p-3">
      {body}
    </section>
  );
}
