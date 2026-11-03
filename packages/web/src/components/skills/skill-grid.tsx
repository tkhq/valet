/**
 * The Library skill list with its Skills/Principles chips, scope select, and search box.
 *
 * Extracted from `/skills` so the org Library settings page reuses the exact
 * same list. `/skills` renders it over the full catalog; the settings page
 * pins the org and hides the scope select (every row is an org row there).
 *
 * The controls are CONTROLLED: the page owns the filter set, keeps it in the
 * URL, and sends it to the server with the page request. They used to filter
 * an array held in the browser, which was honest only while the whole catalog
 * was in that array. A page is a slice, so a search box that filtered the
 * slice would report "No skills match your search" for a skill sitting on the
 * next page. `~/api/skills` documents the query the filters become.
 *
 * The rows keep the order the server sent, which is delivery order: the
 * plugin skills, then personal, then team, then org. Re-sorting a page in the
 * browser would order that page alone and put a row in a different place
 * depending on where the page boundary fell.
 */
import type { ReactNode } from "react";
import type { SkillSummary } from "@valet/api/wire";
import type { SkillListQuery } from "~/api/client";
import { FilterChips, Select } from "~/components/primitives";
import { SkillCard } from "~/components/skills/skill-card";
import { type Scope } from "~/components/skills/scope-badge";
import { SearchInput } from "~/components/search-input";

/** The Library view: the skill catalog, or the principles agents follow. */
export type SkillFilter = "skills" | "principles";

const FILTER_CHIPS: ReadonlyArray<{ id: SkillFilter; label: string }> = [
  { id: "skills", label: "Skills" },
  { id: "principles", label: "Principles" },
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

/** True when any control is narrowing the catalog. An empty page means
 * "nothing matched" then, and "nothing here yet" otherwise. */
export function hasSkillFilters(filters: SkillGridFilters): boolean {
  return filters.scope !== "all" || filters.query.trim().length > 0;
}

export function SkillGrid({
  skills,
  filters,
  onFiltersChange,
  showScopeFilter = true,
  emptyLabel = "No skills yet.",
  errorLabel,
  principles,
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
  /** The Principles view. Without it the grid shows skills alone, with no chips. */
  principles?: ReactNode;
}) {
  const filtering = hasSkillFilters(filters);
  const failed = errorLabel !== undefined;
  // The controls stay up through an empty result and through a failed read.
  // Hiding them would leave a search with no box to clear it in.
  const showControls = skills.length > 0 || filtering || failed;
  const chips = principles !== undefined && (
    <FilterChips
      label="Library view"
      value={filters.filter}
      onChange={(filter) => onFiltersChange({ ...filters, filter })}
      options={FILTER_CHIPS.map((chip) => ({ value: chip.id, label: chip.label }))}
    />
  );

  if (principles !== undefined && filters.filter === "principles") {
    return (
      <div>
        {chips}
        <div className="mt-6 flex min-h-0 flex-col overflow-hidden rounded-2xl bg-ink-wash">{principles}</div>
      </div>
    );
  }

  return (
    <div>
      {(showControls || chips) && (
        <div className="flex flex-wrap items-center gap-3">
          {chips}

          {showControls && showScopeFilter && (
            <Select
              size="sm"
              aria-label="Filter by scope"
              value={filters.scope}
              onChange={(e) => onFiltersChange({ ...filters, scope: readScopeFilter(e.target.value) })}
            >
              {SCOPE_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </Select>
          )}

          {showControls && <div className="ml-auto w-full sm:w-56">
            <SearchInput
              size="sm"
              value={filters.query}
              onSettled={(query) => onFiltersChange({ ...filters, query })}
              placeholder="Search skills…"
              aria-label="Search skills"
            />
          </div>}
        </div>
      )}

      {failed && <div className="mt-8 text-sm text-danger-500">{errorLabel}</div>}

      {!failed && skills.length === 0 && filtering && (
        <div className="mt-8 text-sm text-muted">
          No skills match your search.
        </div>
      )}

      {!failed && skills.length > 0 && (
        <ul aria-label="Skills" className="mt-6 divide-y divide-line rounded-2xl bg-ink-wash">
          {skills.map((skill) => (
            <SkillCard
              key={skill.origin === "plugin" ? `plugin:${skill.name}` : skill.id}
              skill={skill}
            />
          ))}
        </ul>
      )}

      {!failed && skills.length === 0 && !filtering && (
        <div className={chips ? "mt-6 text-sm text-muted" : "text-sm text-muted"}>{emptyLabel}</div>
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

/** The same, for the chip row. An old or unknown value reads as the skills. */
export function readSkillFilter(raw: string | undefined): SkillFilter {
  return raw === "principles" ? "principles" : "skills";
}

/**
 * The catalog query the controls become. `all` sends nothing, so the default
 * view asks the plainest question it can. The skills view lists every kind.
 */
export function skillFilterQuery(filters: SkillGridFilters): SkillListQuery {
  const query = filters.query.trim();
  return {
    ...(filters.scope === "all" ? {} : { scope: filters.scope }),
    ...(query.length === 0 ? {} : { q: query }),
  };
}
