import { createFileRoute } from "@tanstack/react-router";
import type { SkillSummary } from "@valet/api/wire";
import { useSkills } from "~/api/skills";
import { Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { SkillCard } from "~/components/skills/skill-card";
import { displayName } from "~/components/integrations/display-name";

/**
 * `/skills` — the markdown playbooks the assistant can pull into a turn.
 * Read-only: skills come from the installed plugins, so this page shows
 * what is there and links to each body. Nothing here is editable.
 *
 * One section per owning plugin, in the settings visual idiom (open
 * hairline stacks, no card boxes around the group). The grouping is the
 * point — it answers "what does each integration teach the assistant?"
 * instead of showing a flat list.
 */
export const Route = createFileRoute("/skills/")({
  component: SkillsIndexPage,
});

interface PluginGroup {
  plugin: string;
  skills: SkillSummary[];
}

/** Groups skills by owning plugin. Plugins sort by display name; skills
 * sort by display name inside each group, so the page order is stable
 * whatever order the server returns. */
function groupByPlugin(skills: SkillSummary[]): PluginGroup[] {
  const byPlugin = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    const group = byPlugin.get(skill.plugin);
    if (group) group.push(skill);
    else byPlugin.set(skill.plugin, [skill]);
  }
  return [...byPlugin.entries()]
    .map(([plugin, group]) => ({
      plugin,
      skills: [...group].sort((a, b) => displayName(a.name).localeCompare(displayName(b.name))),
    }))
    .sort((a, b) => displayName(a.plugin).localeCompare(displayName(b.plugin)));
}

export function SkillsIndexPage() {
  const { data, isLoading, error } = useSkills();
  const skills = data?.skills ?? [];
  const groups = groupByPlugin(skills);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl text-ink">Skills</h1>
            <p className="mt-1 text-sm text-muted">
              Playbooks your assistant reads on demand. Each installed plugin brings its own.
            </p>
          </div>
          {!isLoading && !error && skills.length > 0 && (
            <span className="shrink-0 font-mono text-xs text-muted">
              {skills.length} skill{skills.length === 1 ? "" : "s"} in {groups.length} plugin
              {groups.length === 1 ? "" : "s"}
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
              No skills installed. Skills arrive with plugins — see Integrations.
            </div>
          )}

          {!isLoading &&
            !error &&
            groups.map((group) => (
              <Section key={group.plugin} title={displayName(group.plugin)}>
                <div className="grid gap-3 pt-4 sm:grid-cols-2">
                  {group.skills.map((skill) => (
                    <SkillCard key={skill.name} skill={skill} />
                  ))}
                </div>
              </Section>
            ))}
        </div>
      </div>
    </div>
  );
}
