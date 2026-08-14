/**
 * The Library card grid with its filter chips, scope select, and search box.
 *
 * Extracted from `/skills` so the org Library settings page reuses the exact
 * same grid. `/skills` renders it over the full catalog; the settings page
 * passes it the org rows only and hides the scope select (every card is an
 * org card there).
 *
 * The component owns the filter/search state. A caller that wants a fixed
 * scope passes `showScopeFilter={false}` and pre-filters its `skills`.
 */
import { useState } from "react";
import type { SkillSummary } from "@valet/api/wire";
import { Input } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { SkillCard } from "~/components/skills/skill-card";
import { scopeForSkill, type Scope } from "~/components/skills/scope-badge";
import { displayName } from "~/components/integrations/display-name";

/** Sorted by display name so the page order is stable whatever order the
 * server returns. */
function sortByName(skills: SkillSummary[]): SkillSummary[] {
  return [...skills].sort((a, b) => displayName(a.name).localeCompare(displayName(b.name)));
}

/** A skill runs as a prompt when it declares `invocation: "prompt"`. Only a
 * stored skill carries the field; a plugin skill never does, so it always
 * counts as a plain skill. */
function isPrompt(skill: SkillSummary): boolean {
  return skill.origin !== "plugin" && skill.invocation === "prompt";
}

/** The Library filter: everything, the plain skills, or the prompts. */
export type SkillFilter = "all" | "skills" | "prompts";

const FILTER_CHIPS: ReadonlyArray<{ id: SkillFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "skills", label: "Skills" },
  { id: "prompts", label: "Prompts" },
];

/** Keeps the rows the active chip selects. `all` keeps everything; `prompts`
 * keeps prompt-invocation skills; `skills` keeps the rest. */
export function filterSkills(skills: SkillSummary[], filter: SkillFilter): SkillSummary[] {
  if (filter === "all") return skills;
  if (filter === "prompts") return skills.filter(isPrompt);
  return skills.filter((s) => !isPrompt(s));
}

/** The scope filter: everything, or one library scope. */
export type ScopeFilter = "all" | Scope;

const SCOPE_OPTIONS: ReadonlyArray<{ id: ScopeFilter; label: string }> = [
  { id: "all", label: "All scopes" },
  { id: "personal", label: "Personal" },
  { id: "team", label: "Team" },
  { id: "org", label: "Org" },
  { id: "plugin", label: "Plugin" },
];

/** Keeps the rows the active scope selects. `all` keeps everything. */
export function filterByScope(skills: SkillSummary[], scope: ScopeFilter): SkillSummary[] {
  if (scope === "all") return skills;
  return skills.filter((s) => scopeForSkill(s) === scope);
}

/** Case-insensitive substring match over name and description. An empty query
 * keeps everything. */
export function filterByQuery(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return skills;
  return skills.filter(
    (s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
  );
}

export function SkillGrid({
  skills,
  showScopeFilter = true,
  emptyLabel = "No skills yet.",
}: {
  skills: SkillSummary[];
  /** The scope select is off on a page that already fixes the scope. */
  showScopeFilter?: boolean;
  /** Shown when `skills` is non-empty but nothing matches the filters. */
  emptyLabel?: string;
}) {
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");
  const sorted = sortByName(filterByQuery(filterByScope(filterSkills(skills, filter), scope), query));

  return (
    <div>
      {skills.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2" role="tablist" aria-label="Filter skills">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                role="tab"
                aria-selected={filter === chip.id}
                onClick={() => setFilter(chip.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  filter === chip.id
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
              value={scope}
              onChange={(e) => setScope(e.target.value as ScopeFilter)}
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
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills…"
              aria-label="Search skills"
            />
          </div>
        </div>
      )}

      {skills.length > 0 && sorted.length === 0 && (
        <div className="mt-8 text-sm text-muted">
          {query.trim().length > 0 || scope !== "all"
            ? "No skills match your search."
            : filter === "prompts"
              ? "No prompts yet. Set a skill's invocation to prompt to list it here."
              : "No skills match this filter."}
        </div>
      )}

      {sorted.length > 0 && (
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {sorted.map((skill) => (
            <SkillCard
              key={skill.origin === "plugin" ? `plugin:${skill.name}` : skill.id}
              skill={skill}
            />
          ))}
        </div>
      )}

      {skills.length === 0 && <div className="text-sm text-muted">{emptyLabel}</div>}
    </div>
  );
}
