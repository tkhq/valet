import { Button } from "~/components/primitives";

/**
 * Previous / page number / Next for a keyset-paginated list.
 *
 * State-free on purpose: the caller keeps the cursor stack, and every list
 * that pages keeps it in the URL (see `~/lib/cursor-stack`). This component
 * only draws the two controls and says which page is open, so one list
 * cannot end up with a pager that looks or reads different from another's.
 *
 * The page number is shown, but no total is: a keyset read knows only whether
 * one more page exists, and counting the rest would cost a second query per
 * page for a number nobody acts on.
 */
export function Pager({
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  label,
}: {
  /** 1-based number of the page being read. */
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Names the list for a screen reader, e.g. "skills". */
  label: string;
}) {
  // One page and nothing after it needs no controls at all.
  if (!hasPrevious && !hasNext) return null;

  return (
    <nav aria-label={`Pages of ${label}`} className="flex items-center justify-between gap-3 pt-4">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        Previous
      </Button>
      <span className="text-xs text-muted">Page {page}</span>
      <Button type="button" variant="ghost" size="sm" disabled={!hasNext} onClick={onNext}>
        Next
      </Button>
    </nav>
  );
}
