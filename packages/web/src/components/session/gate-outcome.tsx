import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { DecisionGate } from "@valet/api/wire";
import { cn } from "~/lib/cn";

/** What the person chose on each gate in this tab, so the card can say
 * what happened after the gate leaves the pending list. */
const chosen = new Map<string, string>();

export function rememberGateChoice(gateId: string, actionId: string): void {
  chosen.set(gateId, actionId);
  if (chosen.size > 200) chosen.delete(chosen.keys().next().value as string);
}

const SENT_VERB: Array<[RegExp, string]> = [
  [/^(slack|slack_user)\.(send_message|post_message|reply_to_origin|dm_user|dm_owner|send_dm)$/, "Sent"],
  [/^slack\.update_message$/, "Updated"],
  [/^gmail\.(send_email|send_draft)$/, "Sent"],
  [/^gmail\.(create_draft|update_draft)$/, "Draft saved"],
  [/^github\.merge_pull_request$/, "Merged"],
  [/^github\.create_pull_request$/, "Opened"],
  [/^github\.(create_comment|create_review)$/, "Posted"],
];

/** The word a resolved gate shows: "Sent", "Merged", "Approved", "Denied", "Answered". */
export function gateOutcomeLabel(gate: Pick<DecisionGate, "type" | "tool">, actionId: string): string {
  if (gate.type !== "approval") return "Answered";
  if (actionId === "deny") return "Denied";
  const verb = gate.tool ? SENT_VERB.find(([pattern]) => pattern.test(gate.tool!.id))?.[1] : undefined;
  return verb ?? "Approved";
}

/**
 * After the person answers a docked gate, the card flips to one line for a
 * few seconds ("✓ Sent · Post the release notes") instead of vanishing. A
 * gate that left the list for another reason (expired, withdrawn, answered
 * elsewhere) shows nothing.
 */
export function useResolvedGateNotice(pending: DecisionGate | undefined, holdMs = 3000): { gate: DecisionGate; label: string } | undefined {
  const last = useRef<DecisionGate | undefined>(pending);
  const [notice, setNotice] = useState<{ gate: DecisionGate; label: string }>();
  useEffect(() => {
    const previous = last.current;
    last.current = pending;
    if (!previous || previous.id === pending?.id) return;
    const actionId = chosen.get(previous.id);
    if (actionId) setNotice({ gate: previous, label: gateOutcomeLabel(previous, actionId) });
  }, [pending]);
  // Its own effect, so a gate arriving during the hold cannot cancel the timer.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), holdMs);
    return () => clearTimeout(timer);
  }, [notice, holdMs]);
  return notice;
}

export function ResolvedGateNotice({ label, title, className }: { label: string; title: string; className?: string }) {
  const negative = label === "Denied";
  return <p role="status" className={cn("flex min-w-0 items-center gap-1.5 px-5 py-2 text-sm sm:px-8", className)}>
    <Check aria-hidden className={cn("h-4 w-4 shrink-0", negative ? "text-muted" : "text-moss")} />
    <span className={cn("shrink-0 font-medium", negative ? "text-muted" : "text-ink")}>{label}</span>
    <span className="min-w-0 truncate text-muted">· {title}</span>
  </p>;
}
