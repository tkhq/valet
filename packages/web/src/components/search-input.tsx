/**
 * A search box over state the PAGE owns — usually a `?q=` search param.
 *
 * The box types into a local draft, and the draft reaches `onSettled` once
 * typing settles (250 ms, the memory-search period). Sending each keystroke
 * would cost one request per character, and on a URL-controlled page it made
 * every character a history entry.
 *
 * The draft and the page's value converge from both sides. The box's own
 * send comes back as a prop change (`value` echoes what `onSettled` wrote);
 * the `lastSent` ref recognizes that echo and leaves the draft alone, so the
 * echo never clobbers characters typed while a send was in flight. A prop
 * change the box did NOT send — Back, or a link — wins over the draft.
 */
import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { Input } from "~/components/primitives";
import { useDebouncedValue } from "~/hooks/use-debounced-value";

/** How long the box lets typing settle before it calls `onSettled`. */
export const SEARCH_DEBOUNCE_MS = 250;

export interface SearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  /** The settled query the page holds, as it echoes back — "" when unset. */
  value: string;
  /** Called with the draft once typing settles and the draft differs from
   * the last settled send. */
  onSettled: (query: string) => void;
}

export function SearchInput({ value, onSettled, ...rest }: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  const debounced = useDebouncedValue(draft, SEARCH_DEBOUNCE_MS);
  // The query this box last sent, as the page echoes it back (a blank query
  // comes back as ""). It tells the box's own echo apart from an external
  // change — Back, or a link — which must win over the draft.
  const lastSent = useRef(value);
  useEffect(() => {
    if (debounced === lastSent.current) return;
    lastSent.current = debounced.trim().length === 0 ? "" : debounced;
    onSettled(debounced);
    // The settled draft is the only trigger. `onSettled` is a render-fresh
    // closure when the draft settles; re-running on its identity would
    // resend the draft on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    if (value !== lastSent.current) {
      lastSent.current = value;
      setDraft(value);
    }
  }, [value]);

  return (
    <Input type="search" value={draft} onChange={(e) => setDraft(e.target.value)} {...rest} />
  );
}
