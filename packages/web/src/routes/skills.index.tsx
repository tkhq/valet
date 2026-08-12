import { createFileRoute, Link } from "@tanstack/react-router";
import type { SkillSummary } from "@valet/api/wire";
import { useSkills } from "~/api/skills";
import { Button, Spinner } from "~/components/primitives";
import { SkillCard } from "~/components/skills/skill-card";
import { SkillSourcesPanel } from "~/components/skills/skill-sources-panel";
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

export function SkillsIndexPage() {
  const { data, isLoading, error } = useSkills();
  const skills = data?.skills ?? [];
  const sorted = sortByName(skills);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <h1 className="font-display text-2xl text-ink">Skills</h1>
          <Button size="sm" className="shrink-0" asChild>
            <Link to="/skills/new">New skill</Link>
          </Button>
        </div>

        <div className="mt-8">
          <SkillSourcesPanel />
        </div>

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
