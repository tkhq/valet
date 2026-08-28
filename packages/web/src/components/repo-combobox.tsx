/**
 * The GitHub repo picker: a filter-as-you-type combobox over `GET /api/repos`
 * (`useRepos` in `~/api/repos`). Extracted from `new-session-dialog.tsx` so
 * the security hub's "New review" card and the new-session dialog share one
 * picker instead of two drifting copies.
 */
import { useEffect, useRef, useState } from "react";
import type { GetReposResponse } from "@valet/api/wire";
import { Badge, Input } from "~/components/primitives";
import { matchesNeedle } from "~/lib/text-match";

export type RepoOption = GetReposResponse["repos"][number];

/** `owner/repo` -> `repo`; falls back to the whole string if it has no slash. */
export function repoBaseName(fullName: string): string {
  const parts = fullName.split("/");
  return parts[parts.length - 1] || fullName;
}

export function RepoCombobox({
  repos,
  label,
  onSelect,
}: {
  repos: RepoOption[];
  label: string;
  onSelect: (repo: RepoOption) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const matches = repos.filter((r) => matchesNeedle(query, [r.fullName]));

  // The close-on-blur timer below outlives the component if the dialog is
  // dismissed within its window: it then sets state on an unmounted tree,
  // and under jsdom it fires after teardown and throws on a missing
  // `window`. Hold it so unmount can cancel it.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    };
  }, []);

  return (
    <div className="relative">
      <Input
        value={query}
        placeholder="owner/repo"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => {
          // Delay so a click on a list item registers before we close.
          if (closeTimer.current !== null) clearTimeout(closeTimer.current);
          closeTimer.current = setTimeout(() => setOpen(false), 120);
        }}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
      />
      {open && (
        <div
          role="listbox"
          aria-label="Repository results"
          className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded border border-line bg-paper py-1 shadow-lg"
        >
          {matches.length === 0 && (
            <div className="px-3 py-1.5 text-sm text-muted">No matching repos.</div>
          )}
          {matches.map((r) => (
            <button
              key={r.fullName}
              type="button"
              role="option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelect(r);
                setQuery("");
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-ink-wash"
            >
              <span className="truncate text-ink">{r.fullName}</span>
              {r.installed && <Badge variant="accent">Installed</Badge>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
