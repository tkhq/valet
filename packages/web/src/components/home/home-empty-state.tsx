import { Button } from "~/components/primitives";
import { prefillComposerDraft } from "~/stores/composer-drafts";

const SUGGESTIONS = [
  "What needs me today?",
  "Catch me up on Slack since yesterday",
  "Start a task: ",
];

/**
 * The first thing a new home conversation shows: what to ask, and three
 * starters. A starter fills the message box; nothing is sent until the
 * person sends it.
 */
export function HomeEmptyState({ sessionId, threadId }: { sessionId: string; threadId: string }) {
  return <div className="m-auto flex w-full max-w-md flex-col items-center gap-4 px-6 py-10 text-center">
    <h2 className="font-display text-2xl text-ink">What should Valet do?</h2>
    <p className="text-sm text-muted">Ask anything. Bigger jobs run as tasks in the workspace they belong to, and come back here when they finish or need you.</p>
    <div className="flex flex-wrap justify-center gap-2">
      {SUGGESTIONS.map(text => <Button key={text} size="sm" variant="secondary" onClick={() => {
        prefillComposerDraft(sessionId, threadId, text);
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus();
      }}>{text.trim()}</Button>)}
    </div>
  </div>;
}
