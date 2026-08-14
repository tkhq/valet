import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SkillSummary } from "@valet/api/wire";
import { useSkills } from "~/api/skills";
import { Button, Input, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { SkillCard } from "~/components/skills/skill-card";
import { scopeForSkill, type Scope } from "~/components/skills/scope-badge";
import { displayName } from "~/components/integrations/display-name";

/**
 * `/skills` — markdown documents the assistant can pull into a turn. One
 * grid holds both kinds: skills the installed plugins ship, and skills
 * stored for the caller. Each card carries an origin badge and opens the
 * skill's page.
 *
 * A skill is written here, or by the assistant through the `skills` actions,
 * or synced from a repository. All three land in the same table and reach a
 * session the same way. See docs/specs/2026-08-05-agent-skills-design.md.
 *
 * The repositories panel above the grid is the other half of that rule: it
 * points Valet at a repository to mirror, and never edits a skill.
 *
 * One grid, sorted by name. Grouping into a section per plugin was tried and
 * reverted: 8 of the 9 plugins ship exactly one skill, so it produced 8
 * headed sections holding a single card each and stretched 11 items over
 * roughly nine screens. The origin belongs on the card, not in a header.
 */
export const Route = createFileRoute("/skills/")({
  component: SkillsIndexPage,
});

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
    (s) =>
      s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
  );
}

export function SkillsIndexPage() {
  const { data, isLoading, error } = useSkills();
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");
  const skills = data?.skills ?? [];
  const sorted = sortByName(
    filterByQuery(filterByScope(filterSkills(skills, filter), scope), query),
  );
  const pluginCount = new Set(
    skills.flatMap((s) => (s.origin === "plugin" ? [s.plugin] : [])),
  ).size;
  const storedCount = skills.filter((s) => s.origin !== "plugin").length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <h1 className="font-display text-2xl text-ink">Skills</h1>
          <div className="flex shrink-0 items-center gap-4">
            {!isLoading && !error && skills.length > 0 && (
              <span className="font-mono text-xs text-muted">
                {skills.length} skill{skills.length === 1 ? "" : "s"} · {pluginCount} plugin
                {pluginCount === 1 ? "" : "s"} · {storedCount} yours
              </span>
            )}
            <Button size="sm" asChild>
              <Link to="/skills/new">New skill</Link>
            </Button>
          </div>
        </div>

        <div className="mt-6 text-sm">
          <Link
            to="/settings/library-sources"
            className="text-moss underline-offset-2 hover:underline"
          >
            Manage sync sources in Settings →
          </Link>
        </div>

        {!isLoading && !error && skills.length > 0 && (
          <div className="mt-8 flex flex-wrap items-center gap-3">
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

        <div className="mt-8 space-y-12">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading skills…
            </div>
          )}
          {!isLoading && error && (
            <div className="text-sm text-danger-500">
              Could not load skills. Check that the server is running, then reload.
            </div>
          )}
          {!isLoading && !error && skills.length === 0 && (
            <div className="text-sm text-muted">
              No skills yet. Write one, or ask your assistant to write one for you.
            </div>
          )}
          {!isLoading && !error && skills.length > 0 && sorted.length === 0 && (
            <div className="text-sm text-muted">
              {query.trim().length > 0 || scope !== "all"
                ? "No skills match your search."
                : filter === "prompts"
                  ? "No prompts yet. Set a skill's invocation to prompt to list it here."
                  : "No skills match this filter."}
            </div>
          )}

          {!isLoading && !error && sorted.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {sorted.map((skill) => (
                <SkillCard
                  key={skill.origin === "plugin" ? `plugin:${skill.name}` : skill.id}
                  skill={skill}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
