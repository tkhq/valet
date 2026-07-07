import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { MemoryPage } from '@/components/memory/memory-page';

// `?file=<path>` deep-links to a specific memory file (used by the dashboard
// card, and kept in sync as the user browses so views are shareable).
export const Route = createFileRoute('/orchestrator/memory')({
  validateSearch: (search: Record<string, unknown>): { file?: string } => ({
    file: typeof search.file === 'string' && search.file ? search.file : undefined,
  }),
  component: MemoryRoute,
});

function MemoryRoute() {
  const { file } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  return (
    <MemoryPage
      selectedPath={file ?? null}
      // Selecting a file pushes a history entry so browser back/forward walks
      // the trail of visited memories; clearing (close/delete) replaces so an
      // extra "empty" entry doesn't pile up.
      onSelectPath={(path) => {
        if (path === (file ?? null)) return; // re-clicking the open file: no history spam
        navigate({ search: { file: path ?? undefined }, replace: path === null });
      }}
    />
  );
}
