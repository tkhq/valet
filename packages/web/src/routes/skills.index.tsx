import { createFileRoute } from "@tanstack/react-router";
import type { SkillSummary } from "@valet/api/wire";
import { useSkills } from "~/api/skills";
import { Spinner } from "~/components/primitives";
import { SkillCard } from "~/components/skills/skill-card";
import { displayName } from "~/components/integrations/display-name";

/**
 * `/skills` — the markdown playbooks the assistant can pull into a turn.
 * Two kinds sit in one grid: the skills the installed plugins ship, and the
 * skills stored for the caller. Each card carries an origin badge and opens
 * a read-only page.
 *
 * Browsing only. A skill is authored in the repository it comes from, or by
 * the assistant through the `skills` actions — a form here would be a second
 * authoring path with no version history behind it. See
 * docs/specs/2026-08-05-agent-skills-design.md.
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

export function SkillsIndexPage() {
  const { data, isLoading, error } = useSkills();
  const skills = data?.skills ?? [];
  const sorted = sortByName(skills);
  const pluginCount = new Set(
    skills.flatMap((s) => (s.origin === "plugin" ? [s.plugin] : [])),
  ).size;
  const storedCount = skills.filter((s) => s.origin !== "plugin").length;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl text-ink">Skills</h1>
            <p className="mt-1 text-sm text-muted">
              Playbooks your assistant reads on demand. Plugins bring their own; ask your assistant
              to write you one.
            </p>
          </div>
          {!isLoading && !error && skills.length > 0 && (
            <span className="shrink-0 font-mono text-xs text-muted">
              {skills.length} skill{skills.length === 1 ? "" : "s"} · {pluginCount} plugin
              {pluginCount === 1 ? "" : "s"} · {storedCount} yours
            </span>
          )}
        </div>

        <div className="mt-10 space-y-12">
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
              No skills yet. Plugins bring their own — see Integrations — or ask your assistant to
              write one for you.
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
