import { useState } from "react";
import type { StreamMessage } from "~/stores/stream";
import { Button } from "~/components/primitives";
import { messageCopyText } from "./message-item";
import { useSendAsPerson } from "./send-as-person";

/** Words that open a question a person can answer with yes or no. */
const YES_NO_OPENER = /^(should|shall|do|does|did|can|could|would|will|want|wanna|is|are|was|were|has|have|ok|okay|ready|good to|sound good|send|post|merge|publish|ship|deploy|go ahead|proceed|continue|approve|keep|use|start|schedule|book|add|remove|delete|close|open|move|try|draft|create)\b/i;

/**
 * The yes-or-no question that closes the newest message, when Valet asked
 * one and nobody answered yet: "…Send from you?" or "Want prep notes?".
 */
export function yesNoQuestion(messages: readonly StreamMessage[]): { messageId: string; question: string } | undefined {
  const last = [...messages].reverse().find(m => !m.signal && !m.compaction && !m.command);
  if (!last || last.role !== "assistant" || last.completed !== true || last.stopReason === "error") return undefined;
  if (last.parts.some(part => part.kind === "tool_call" && part.status === "running")) return undefined;
  const text = messageCopyText(last).trim();
  if (!text.endsWith("?")) return undefined;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const question = sentences.at(-1) ?? text;
  // "Which…", "What…", "How…" ask for more than yes or no, and so does a
  // choice between options ("…the monorepo or the deploy repo?").
  if (/^(which|what|where|when|who|whom|whose|why|how)\b/i.test(question) || /\bor\b/i.test(question)) return undefined;
  if (!YES_NO_OPENER.test(question) && !/\b(want me to|should i|shall i|ok to|okay to|okay\?|ok\?|right\?)/i.test(question)) return undefined;
  return { messageId: last.id, question };
}

/**
 * One-tap answers under a yes-or-no question from Valet: Yes and No send that
 * word as the person's message; Not now hides the chips. The composer stays
 * for any other answer.
 */
export function QuickReplies({ sessionId, threadId, messages, disabled }: {
  sessionId: string; threadId: string | undefined; messages: readonly StreamMessage[]; disabled?: boolean;
}) {
  const asked = yesNoQuestion(messages);
  const [dismissed, setDismissed] = useState<string>();
  const { reply, pending, error } = useSendAsPerson(sessionId, threadId, "Could not send. Type your answer instead.");
  if (!asked || !threadId || disabled || dismissed === asked.messageId) return null;
  return <div role="group" aria-label={`Answer: ${asked.question}`} className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-5 pb-1 pt-2 sm:px-8">
    <Button size="sm" variant="secondary" disabled={pending} onClick={() => void reply("Yes")}>Yes</Button>
    <Button size="sm" variant="secondary" disabled={pending} onClick={() => void reply("No")}>No</Button>
    <Button size="sm" variant="ghost" onClick={() => setDismissed(asked.messageId)}>Not now</Button>
    {error && <span role="alert" className="text-xs text-danger-500">{error}</span>}
  </div>;
}
