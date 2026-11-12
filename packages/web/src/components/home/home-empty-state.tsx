import type { ReactNode } from "react";
import { Button } from "~/components/primitives";
import { prefillComposerDraft } from "~/stores/composer-drafts";

/** `prefill` is what the message box gets; it can end mid-sentence for the person to finish. */
const SUGGESTIONS = [
  { label: "What needs me today?", prefill: "What needs me today?" },
  { label: "Catch me up on Slack since yesterday", prefill: "Catch me up on Slack since yesterday" },
  { label: "Start a task", prefill: "Start a task: " },
];

/**
 * The first thing a new home conversation shows: what to ask, and three
 * starters. A starter fills the message box; nothing is sent until the
 * person sends it. Desktop Home's idle view is this, with a greeting.
 */
export function HomeEmptyState({ sessionId, threadId, title = "What should Valet do?", onPick, children }: {
  sessionId: string; threadId: string; title?: string; onPick?: () => void; children?: ReactNode;
}) {
  // The starters get a wider row than the text, so all three fit on one line beside the Tasks panel.
  return <div className="m-auto flex w-full max-w-2xl flex-col items-center gap-4 px-6 py-10 text-center">
    <h2 className="font-display text-2xl text-ink">{title}</h2>
    <p className="max-w-md text-sm text-muted">Ask anything. Bigger jobs run as tasks in the workspace they belong to, and come back here when they finish or need you.</p>
    <div className="flex flex-wrap justify-center gap-2">
      {SUGGESTIONS.map(({ label, prefill }) => <Button key={label} size="sm" variant="secondary" onClick={() => {
        prefillComposerDraft(sessionId, threadId, prefill, SUGGESTIONS.map((s) => s.prefill));
        onPick?.();
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
      }}>{label}</Button>)}
    </div>
    {children}
  </div>;
}

/** Desktop Home's idle heading. */
export function greeting(now: Date): string {
  const hour = now.getHours();
  return hour < 5 ? "Working late?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
