import { useState } from "react";
import type { ModelInfo } from "@valet/api/wire";
import { Input } from "~/components/primitives";
import { matchesNeedle } from "~/lib/text-match";

/**
 * Search-to-add typeahead over a caller-supplied list of not-yet-added
 * catalog models. Same hand-rolled input+filtered-list pattern as
 * `ModelCombobox` (no Popover/Command primitive in this package; disclosed
 * tradeoff there applies here too). The list opens on focus/typing, caps at
 * 30 rows with a "narrow the search" hint, and stays open after an add so
 * several models can be added in one sitting.
 *
 * Used by `ModelTiersSection`'s per-tier target list.
 */
export function AddModelTypeahead({
  options,
  onAdd,
}: {
  options: ModelInfo[];
  onAdd: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matches = options.filter((m) => matchesNeedle(query, [m.id, m.name, m.providerName]));

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wider text-muted">Add a model</div>
      <Input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQuery("");
            setOpen(false);
          }
        }}
        placeholder={`Search ${options.length} models — name, id, or provider…`}
        aria-label="Search models to add"
      />
      {open && (
        <div className="max-h-56 overflow-y-auto rounded border border-line">
          {matches.slice(0, 30).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onAdd(m.id)}
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm text-ink hover:bg-ink-wash"
            >
              <span className="truncate">{m.name}</span>
              <span className="ml-2 shrink-0 text-xs text-muted">{m.providerName}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted">No matching models.</p>
          )}
          {matches.length > 30 && (
            <p className="px-2 py-1.5 text-xs text-muted">
              {matches.length - 30} more — narrow the search.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
