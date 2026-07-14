import { useMemoryDoc } from "~/api/memory";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { ApiError } from "~/api/client";
import { Badge, Spinner } from "~/components/primitives";
import { Markdown } from "~/components/markdown";
import { splitFrontmatter } from "~/lib/frontmatter";
import { relativeTime } from "~/lib/relative-time";
import { useComposerPrefillStore } from "~/stores/composer-prefill";

/** Pure — the exact prefill text the footer hands off to the composer. */
export function memoryDocPrefillText(path: string): string {
  return `Update memory file ${path}: `;
}

export interface MemoryDocProps {
  path: string;
  /**
   * Called after the prefill store is seeded, to actually leave the page
   * (`navigate({ to: "/chat" })` in production). Kept as a callback rather
   * than calling `useNavigate` in here so this component renders/tests
   * without a `RouterProvider` — same reasoning as `signal-card.tsx`'s
   * `onOpenChild`.
   */
  onNavigateToChat: () => void;
}

/**
 * Right pane of the memory explorer (Task 6 brief): the notebook-style
 * document view. Title + body render in the display face (Newsreader);
 * frontmatter is never shown raw — `splitFrontmatter` (display-only, tolerant)
 * pulls `type`/`tags`/`sensitivity`/`origin` out as quiet badges and the
 * component renders only the body markdown.
 */
export function MemoryDoc({ path, onNavigateToChat }: MemoryDocProps) {
  const docQ = useMemoryDoc(path);
  const info = useOrchestratorInfo();
  const name = info.data?.name ?? "your assistant";

  function askToUpdate() {
    useComposerPrefillStore.getState().set(memoryDocPrefillText(path));
    onNavigateToChat();
  }

  if (docQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const notFound = docQ.error instanceof ApiError && docQ.error.status === 404;
  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center text-sm text-muted">
        <p>Nothing here yet.</p>
        <p>
          Talk to {name}, or import a bundle via the API.
        </p>
      </div>
    );
  }

  if (docQ.error) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-danger-500">
        <div>
          Couldn't load this file.
          <div className="mt-2">
            <button type="button" className="underline" onClick={() => docQ.refetch()}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!docQ.data || docQ.data.kind !== "file" || !docQ.data.file) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
        This is a directory — pick a file from the tree.
      </div>
    );
  }

  const { file, rendered } = docQ.data;
  const { meta, body } = splitFrontmatter(rendered);
  const type = meta.type ?? file.type;
  const tags = meta.tags ?? [];

  return (
    <article className="mx-auto max-w-[65ch] px-6 py-10">
      <header className="mb-8 space-y-3 border-b border-line pb-6">
        <h1 className="font-display text-3xl leading-tight text-ink">
          {file.pinned === 1 && <span aria-hidden="true">📌 </span>}
          {file.title || path}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{type}</Badge>
          {tags.map((tag) => (
            <Badge key={tag} variant="neutral">
              {tag}
            </Badge>
          ))}
          {meta.sensitivity && <Badge variant="accent">{meta.sensitivity}</Badge>}
          {meta.origin && <Badge variant="neutral">{meta.origin}</Badge>}
        </div>
        <p className="text-xs text-muted">Updated {relativeTime(file.updatedAt)}</p>
      </header>

      <Markdown className="font-display text-[17px] prose-headings:font-display">{body}</Markdown>

      <footer className="mt-12 border-t border-line pt-6">
        <button type="button" onClick={askToUpdate} className="text-sm text-moss hover:underline">
          Ask {name} to update this
        </button>
      </footer>
    </article>
  );
}
