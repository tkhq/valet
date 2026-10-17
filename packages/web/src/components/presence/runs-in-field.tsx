/**
 * RunsInField: the **Runs in** control for an assistant rule
 * (docs/specs/2026-10-16-presence-hub-design.md Part C step 2, Part D step 3).
 * It offers a new thread each time, one thread per subject (only when the
 * rule's events name one), the rule's own thread, and an existing thread
 * from the workspace's open threads.
 *
 * The value is the policy, or null while "An existing thread…" is chosen and
 * no thread is picked yet. The parent holds the value and refuses a save
 * while it is null, so a half-made choice never posts the old policy.
 */
import type { AssistantThreadPolicy } from "@valet/shared";
import { useState } from "react";
import { ThreadPicker } from "./thread-picker";
import {
  carriesSlackConversation,
  ownOptionLabel,
  SHARED_SLACK_THREAD_NOTE,
  subjectOptionLabel,
  type RuleKind,
  type SubjectKind,
} from "./thread-policy-copy";
import { runsInLabel } from "./sentences";

/** The text a parent shows when it refuses a save with no picked thread. */
export const PICK_A_THREAD_ERROR = "Pick a thread for Runs in, or choose another option.";

type Mode = AssistantThreadPolicy["mode"];

export function RunsInField({
  idPrefix,
  value,
  onChange,
  subjectKind,
  ruleKind,
  workspace,
  eventKeys = [],
  disabled = false,
}: {
  idPrefix: string;
  value: AssistantThreadPolicy | null;
  /** `title` names the thread a reader picked from the thread list. */
  onChange: (next: AssistantThreadPolicy | null, title?: string) => void;
  /** Null hides the subject option: the rule's events name no subject. */
  subjectKind: SubjectKind | null;
  ruleKind: RuleKind;
  /** The workspace key whose threads the picker lists. Absent hides the
   * existing option (the org assistant has no thread list here). */
  workspace?: string;
  /** The rule's event keys. Slack mention or message keys add a note when
   * one thread would hold several Slack conversations. */
  eventKeys?: readonly string[];
  disabled?: boolean;
}) {
  // The title of the thread the picker emitted, keyed by thread id, so a
  // value that points at another thread never shows a stale title.
  const [picked, setPicked] = useState<{ threadId: string; title: string } | null>(null);
  const mode: Mode = value === null ? "existing" : value.mode;
  const name = `${idPrefix}-runs-in`;

  const options: { mode: Mode; label: string }[] = [
    { mode: "new", label: "A new thread each time" },
    ...(subjectKind !== null ? [{ mode: "subject" as const, label: subjectOptionLabel(subjectKind) }] : []),
    { mode: "own", label: ownOptionLabel(ruleKind) },
    ...(workspace !== undefined || mode === "existing" ? [{ mode: "existing" as const, label: "An existing thread…" }] : []),
  ];

  function choose(next: Mode) {
    if (next === "existing") onChange(null);
    else onChange({ mode: next });
  }

  const existing = value !== null && value.mode === "existing" ? value : null;
  const title = existing !== null && picked?.threadId === existing.threadId ? picked.title : undefined;

  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="mb-1 text-xs font-medium text-muted">Runs in</legend>
      {options.map((o) => (
        <label key={o.mode} className="flex min-h-11 items-center gap-2 text-sm text-ink sm:min-h-0">
          <input type="radio" name={name} checked={mode === o.mode} onChange={() => choose(o.mode)} />
          {o.label}
        </label>
      ))}
      {(mode === "own" || mode === "existing") && carriesSlackConversation(eventKeys) && (
        <p className="ml-6 text-xs text-muted">{SHARED_SLACK_THREAD_NOTE}</p>
      )}
      {mode === "existing" && (
        <div className="ml-6 space-y-1.5">
          {existing !== null
            ? <p className="text-xs text-muted">{runsInLabel(existing, subjectKind, ruleKind, title)}</p>
            : <p className="text-xs text-muted">Pick a thread.</p>}
          {workspace !== undefined && (
            <ThreadPicker
              workspace={workspace}
              selectedThreadId={existing?.threadId}
              onPick={(policy, pickedTitle) => {
                setPicked({ threadId: policy.threadId, title: pickedTitle });
                onChange(policy, pickedTitle);
              }}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}
