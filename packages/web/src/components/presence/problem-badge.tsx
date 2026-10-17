/**
 * The problem state of a line of presence or a routine
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 5, Part D): a badge
 * for every list, and the page text with the thread picker inline.
 *
 * Today the one problem is a pinned thread that no longer accepts deliveries.
 * The api reports it as the pin text: a line's `problem`, a routine's
 * `disabledReason`.
 */
import type { AssistantThreadPolicy } from "@valet/shared";
import { Badge } from "~/components/primitives";
import { ThreadPicker } from "./thread-picker";

/** The dead-letter text the api stores when a pin cannot take a delivery.
 * The web compares against it and never shows it. */
// copy-lint: allow rule
export const PIN_UNAVAILABLE = "Pick another thread for this rule in Presence.";

/** The problem line for an archived pin. Without a title it names `The pinned thread`. */
export function pinProblemText(threadTitle?: string): string {
  const title = threadTitle !== undefined && threadTitle.trim().length > 0 ? threadTitle : "The pinned thread";
  return `${title} is archived. Pick another thread:`;
}

/** The badge a list row shows for a rule with a problem. Nothing otherwise. */
export function ProblemBadge({ problem }: { problem: string | null | undefined }) {
  if (problem === undefined || problem === null || problem.length === 0) return null;
  return (
    <Badge variant="danger" title={problem === PIN_UNAVAILABLE ? pinProblemText() : problem}>
      {problem === PIN_UNAVAILABLE ? "Thread archived" : "Problem"}
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
  variant = "box",
}: {
  problem: string;
  /** The archived pin's title, when the caller knows it. */
  threadTitle?: string;
  /** The viewer may not change the rule: no picker, and the text names who can. */
  readOnly?: boolean;
  /** The workspace key whose threads the picker lists. Absent hides the picker. */
  workspace: string | undefined;
  onPick: (policy: Extract<AssistantThreadPolicy, { mode: "existing" }>) => void;
  pending?: boolean;
  error?: string | null;
  /** `box` frames the problem on a page of its own. `inline` sits under a
   * row in a list, without the frame. */
  variant?: "box" | "inline";
}) {
  const pin = problem === PIN_UNAVAILABLE;
  const text = pin ? pinProblemText(threadTitle) : problem;
  const body = (
    <>
      <p role="alert" className="text-sm text-danger-600 dark:text-danger-500">{text}</p>
      {pin && readOnly && <p className="text-xs text-muted">Only its owner can change this.</p>}
      {pin && !readOnly && workspace !== undefined && <ThreadPicker workspace={workspace} onPick={(policy) => onPick(policy)} />}
      {pin && !readOnly && workspace === undefined && (
        <p className="text-xs text-muted">Select Edit, then choose another option under Runs in.</p>
      )}
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
