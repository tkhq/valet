import type { ReactNode } from "react";
import { Button } from "~/components/primitives";
import { useSendAsPerson } from "~/components/session/send-as-person";

/** Each starter sends a complete request, so Valet starts right away. An
 * open-ended one asks Valet to ask for the details, as starter prompts in
 * other assistant apps do, instead of leaving half a sentence in the box. */
const SUGGESTIONS = [
  { label: "What needs me today?", prompt: "What needs me today?" },
  { label: "Catch me up on Slack since yesterday", prompt: "Catch me up on Slack since yesterday" },
  { label: "Start a task", prompt: "Help me start a new task. Ask me what it is." },
];

/**
 * The first thing a new home conversation shows: what to ask, and three
 * starters. A starter sends its request as the person's message. Desktop
 * Home's idle view is this, with a greeting.
 */
export function HomeEmptyState({ sessionId, threadId, title = "What should Valet do?", onPick, children }: {
  sessionId: string; threadId: string; title?: string; onPick?: () => void; children?: ReactNode;
}) {
  const { reply, pending, error } = useSendAsPerson(sessionId, threadId, "Could not send. Type your request in the message box instead.");
  // The starters get a wider row than the text, so all three fit on one line beside the Tasks panel.
  return <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-4 px-6 py-10 text-center">
    <h2 className="font-display text-2xl text-ink">{title}</h2>
    <p className="max-w-md text-sm text-muted">Ask anything. Bigger jobs run as tasks in the workspace they belong to, and come back here when they finish or need you.</p>
    <div className="flex flex-wrap justify-center gap-2">
      {/* The idle view stays until the send succeeds: it shows the error when the send fails. */}
      {SUGGESTIONS.map(({ label, prompt }) => <Button key={label} size="sm" variant="secondary" disabled={pending} onClick={() => {
        void reply(prompt).then((sent) => { if (sent) onPick?.(); });
      }}>{label}</Button>)}
    </div>
    {error && <p role="alert" className="text-xs text-danger-500">{error}</p>}
    {children}
  </div>;
}

/** Desktop Home's idle heading. */
export function greeting(now: Date): string {
  const hour = now.getHours();
  return hour < 5 ? "Working late?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
