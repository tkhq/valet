/**
 * The Library card grid with its filter chips, scope select, and search box.
 *
 * Extracted from `/skills` so the org Library settings page reuses the exact
 * same grid. `/skills` renders it over the full catalog; the settings page
 * pins the org and hides the scope select (every card is an org card there).
 *
 * The controls are CONTROLLED: the page owns the filter set, keeps it in the
 * URL, and sends it to the server with the page request. They used to filter
 * an array held in the browser, which was honest only while the whole catalog
 * was in that array. A page is a slice, so a search box that filtered the
 * slice would report "No skills match your search" for a skill sitting on the
 * next page. `~/api/skills` documents the query the filters become.
 *
 * The cards keep the order the server sent, which is delivery order: the
 * plugin skills, then personal, then team, then org. Re-sorting a page in the
 * browser would order that page alone and put a card in a different place
 * depending on where the page boundary fell.
 */
import type { SkillSummary } from "@valet/api/wire";
import type { SkillListQuery } from "~/api/client";
import { cn } from "~/lib/cn";
import { SkillCard } from "~/components/skills/skill-card";
import { type Scope } from "~/components/skills/scope-badge";
import { SearchInput } from "~/components/search-input";

/** The Library filter: everything, the plain skills, or the prompts. */
export type SkillFilter = "all" | "skills" | "prompts";

const FILTER_CHIPS: ReadonlyArray<{ id: SkillFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "skills", label: "Skills" },
  { id: "prompts", label: "Prompts" },
];

/** The scope filter: everything, or one library scope. */
export type ScopeFilter = "all" | Scope;

const SCOPE_OPTIONS: ReadonlyArray<{ id: ScopeFilter; label: string }> = [
  { id: "all", label: "All scopes" },
  { id: "personal", label: "Personal" },
  { id: "team", label: "Team" },
  { id: "org", label: "Org" },
  { id: "plugin", label: "Plugin" },
];

/** What the three controls hold. The page keeps this in its search params. */
export interface SkillGridFilters {
  filter: SkillFilter;
  scope: ScopeFilter;
  query: string;
}

export const NO_SKILL_FILTERS: SkillGridFilters = { filter: "all", scope: "all", query: "" };

/** True when any control is narrowing the catalog. An empty page means
 * "nothing matched" then, and "nothing here yet" otherwise. */
export function hasSkillFilters(filters: SkillGridFilters): boolean {
  return filters.filter !== "all" || filters.scope !== "all" || filters.query.trim().length > 0;
}

export function SkillGrid({
  skills,
  filters,
  onFiltersChange,
  showScopeFilter = true,
  emptyLabel = "No skills yet.",
  errorLabel,
}: {
  /** One page of the catalog, already filtered by the server. */
  skills: SkillSummary[];
  filters: SkillGridFilters;
  onFiltersChange: (next: SkillGridFilters) => void;
  /** The scope select is off on a page that already fixes the scope. */
  showScopeFilter?: boolean;
  /** Shown when the library holds nothing at all. */
  emptyLabel?: string;
  /** Shown in place of the cards when the read failed. The controls stay
   * up: a failed SEARCH must keep the box that can change or clear it,
   * or the reader's only way out is a reload. */
  errorLabel?: string;
}) {
  const filtering = hasSkillFilters(filters);
  const failed = errorLabel !== undefined;
  // The controls stay up through an empty result and through a failed read.
  // Hiding them would leave a search with no box to clear it in.
  const showControls = skills.length > 0 || filtering || failed;

  return (
    <div>
      {showControls && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2" role="tablist" aria-label="Filter skills">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                role="tab"
                aria-selected={filters.filter === chip.id}
                onClick={() => onFiltersChange({ ...filters, filter: chip.id })}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  filters.filter === chip.id
                    ? "border-moss bg-moss text-white"
                    : "border-line bg-paper text-muted hover:text-ink",
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>

          {showScopeFilter && (
            <select
              aria-label="Filter by scope"
              value={filters.scope}
              onChange={(e) => onFiltersChange({ ...filters, scope: readScopeFilter(e.target.value) })}
              className="rounded-md border border-line bg-paper px-2 py-1 text-xs text-ink"
            >
              {SCOPE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}

          <div className="ml-auto w-full sm:w-56">
            <SearchInput
              value={filters.query}
              onSettled={(query) => onFiltersChange({ ...filters, query })}
              placeholder="Search skills…"
              aria-label="Search skills"
            />
          </div>
        </div>
      )}

      {failed && <div className="mt-8 text-sm text-danger-500">{errorLabel}</div>}

      {!failed && skills.length === 0 && filtering && (
        <div className="mt-8 text-sm text-muted">
          {filters.query.trim().length > 0 || filters.scope !== "all"
            ? "No skills match your search."
            : filters.filter === "prompts"
              ? "No prompts yet. Set a skill's invocation to prompt to list it here."
              : "No skills match this filter."}
        </div>
      )}

      {!failed && skills.length > 0 && (
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {skills.map((skill) => (
            <SkillCard
              key={skill.origin === "plugin" ? `plugin:${skill.name}` : skill.id}
              skill={skill}
            />
          ))}
        </div>
      )}

      {!failed && skills.length === 0 && !filtering && (
        <div className="text-sm text-muted">{emptyLabel}</div>
      )}
    </div>
  );
}

/** A `<select>` hands back a plain string; this is where it becomes one of
 * the values the filter takes. An unknown value reads as "all", the same as a
 * hand-edited URL does. */
export function readScopeFilter(raw: string | undefined): ScopeFilter {
  return SCOPE_OPTIONS.find((opt) => opt.id === raw)?.id ?? "all";
}

/** The same, for the chip row. */
export function readSkillFilter(raw: string | undefined): SkillFilter {
  return FILTER_CHIPS.find((chip) => chip.id === raw)?.id ?? "all";
}

/**
 * The catalog query the three controls become. `all` sends nothing, so the
 * default view asks the plainest question it can.
 *
 * The chips read "Skills" and "Prompts" where the wire reads `skill` and
 * `prompt`: the control is a plural heading over a group of cards, and the
 * parameter names one card's kind.
 */
export function skillFilterQuery(filters: SkillGridFilters): SkillListQuery {
  const query = filters.query.trim();
  return {
    ...(filters.filter === "all" ? {} : { kind: filters.filter === "prompts" ? "prompt" : "skill" }),
    ...(filters.scope === "all" ? {} : { scope: filters.scope }),
    ...(query.length === 0 ? {} : { q: query }),
  };
}
