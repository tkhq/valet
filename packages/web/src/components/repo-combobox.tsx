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

/**
 * Host-side base for a new session's working directory. This is a real path
 * the api creates on the host (docker bind-mount source in dev), NOT the
 * in-sandbox `/workspace` mount — creating `/workspace/<name>` on the host
 * fails (`mkdir /workspace` ENOENT). Callers append the repo base name.
 */
export const DEFAULT_WORKSPACE_BASE = "/tmp/valet/workspace";

/** `owner/repo` -> `repo`; falls back to the whole string if it has no slash. */
export function repoBaseName(fullName: string): string {
  const parts = fullName.split("/");
  return parts[parts.length - 1] || fullName;
}

/** The host working directory for a session bound to `fullName`. */
export function workspaceForRepo(fullName: string): string {
  return `${DEFAULT_WORKSPACE_BASE}/${repoBaseName(fullName)}`;
}

/**
 * Parse a free-text public-repo reference into a GitHub binding. Accepts
 * `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo`
 * (with optional `.git`, trailing slash, or `/tree/<branch>` suffix), and
 * `git@github.com:owner/repo.git`. Returns null when it does not parse.
 * The binding carries no ref — the server resolves the default branch HEAD.
 */
export function parsePublicRepo(input: string): { fullName: string; cloneUrl: string } | null {
  const s = input.trim();
  if (!s) return null;
  let owner: string | undefined;
  let repo: string | undefined;
  const ssh = /^git@github\.com:([^/\s]+)\/(.+?)(?:\.git)?\/?$/.exec(s);
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/.exec(s);
  const bare = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(s);
  if (ssh) {
    [, owner, repo] = ssh;
  } else if (url) {
    [, owner, repo] = url;
  } else if (bare) {
    [, owner, repo] = bare;
  }
  if (!owner || !repo) return null;
  return { fullName: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git` };
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
