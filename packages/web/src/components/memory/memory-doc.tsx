import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { qkMemory, useMemoryDoc } from "~/api/memory";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { api, ApiError } from "~/api/client";
import { Badge, Button, Spinner } from "~/components/primitives";
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
  /** Called after a successful delete (`navigate({ to: "/memory" })` in
   * production) — same router-free convention as `onNavigateToChat`. */
  onDeleted?: () => void;
}

/**
 * Right pane of the memory explorer (Task 6 brief): the notebook-style
 * document view. Title + body render in the display face (Newsreader);
 * frontmatter is never shown raw — `splitFrontmatter` (display-only, tolerant)
 * pulls `type`/`tags`/`sensitivity`/`origin` out as quiet badges and the
 * component renders only the body markdown.
 *
 * Edit swaps the rendered body for a plain-markdown textarea over the
 * STORED content (`file.content`, no frontmatter — the server re-derives
 * the title and keeps type/tags/pinned as they were). Delete is
 * confirm-gated inline, no dialog.
 */
export function MemoryDoc({ path, onNavigateToChat, onDeleted }: MemoryDocProps) {
  const docQ = useMemoryDoc(path);
  const info = useOrchestratorInfo();
  const queryClient = useQueryClient();
  const name = info.data?.name ?? "your assistant";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (content: string) => api.writeMemoryDoc({ path, content }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: qkMemory.doc(path) });
      await queryClient.invalidateQueries({ queryKey: qkMemory.tree() });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteMemoryDoc(path),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qkMemory.tree() });
      queryClient.removeQueries({ queryKey: qkMemory.doc(path) });
      onDeleted?.();
    },
  });

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

  function startEditing() {
    // `file` is narrowed non-null above; TS can't carry that into the
    // closure, so re-read from the query data.
    setDraft(docQ.data?.file?.content ?? "");
    setEditing(true);
    setConfirmingDelete(false);
  }

  return (
    <article className="mx-auto max-w-[65ch] px-6 py-10">
      <header className="mb-8 space-y-3 border-b border-line pb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="font-display text-3xl leading-tight text-ink">
            {file.pinned === 1 && <span aria-hidden="true">📌 </span>}
            {file.title || path}
          </h1>
          {!editing && (
            <div className="flex shrink-0 items-center gap-2 pt-2 text-xs">
              <button type="button" onClick={startEditing} className="text-muted hover:text-moss">
                Edit
              </button>
              {confirmingDelete ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => deleteMutation.mutate()}
                    disabled={deleteMutation.isPending}
                    className="font-medium text-danger-500 hover:underline"
                  >
                    {deleteMutation.isPending ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className="text-muted hover:text-danger-500"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
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
        {deleteMutation.error instanceof Error && (
          <p className="text-xs text-danger-500">Delete failed: {deleteMutation.error.message}</p>
        )}
      </header>

      {editing ? (
        <div className="space-y-3">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Memory content"
            spellCheck={false}
            className="min-h-[50vh] w-full resize-y rounded-md border border-line bg-paper p-3 font-mono text-sm leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
          />
          {saveMutation.error instanceof Error && (
            <p className="text-xs text-danger-500">Save failed: {saveMutation.error.message}</p>
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate(draft)}
              disabled={saveMutation.isPending || draft.trim().length === 0}
            >
              {saveMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            {draft.trim().length === 0 && (
              <span className="text-xs text-muted">Content can't be empty — use Delete instead.</span>
            )}
          </div>
        </div>
      ) : (
        <Markdown className="font-display text-[17px] prose-headings:font-display">{body}</Markdown>
      )}

      {!editing && (
        <footer className="mt-12 border-t border-line pt-6">
          <button type="button" onClick={askToUpdate} className="text-sm text-moss hover:underline">
            Ask {name} to update this
          </button>
        </footer>
      )}
    </article>
  );
}
