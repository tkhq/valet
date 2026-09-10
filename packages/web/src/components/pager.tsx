import { Button } from "~/components/primitives";

/**
 * Previous / page number / Next for a paginated list.
 *
 * State-free on purpose: the caller keeps page state in the URL. This
 * component only draws the controls, so list pagers look and read the same.
 * A keyset list omits `totalPages`. An offset list can show its known total.
 */
export function Pager({
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  label,
  busy = false,
  totalPages,
}: {
  /** 1-based number of the page being read. */
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Names the list for a screen reader, e.g. "skills". */
  label: string;
  /** True while the list on screen is a held-over page from a PREVIOUS
   * query (see `useSkills`'s placeholder). Its `nextCursor` names a row of
   * that old query, so Next is held — but the pager stays mounted, and
   * Previous stays live because the cursor stack in the URL is always
   * about the current query. */
  busy?: boolean;
  /** Total page count when the caller knows it. */
  totalPages?: number;
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
      <span className="text-xs text-muted">
        Page {page}{totalPages === undefined ? "" : ` of ${totalPages}`}
      </span>
      <Button type="button" variant="ghost" size="sm" disabled={busy || !hasNext} onClick={onNext}>
        Next
      </Button>
    </nav>
  );
}
