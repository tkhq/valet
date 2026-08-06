import { Link, createFileRoute } from "@tanstack/react-router";
import { useSkill } from "~/api/skills";
import { Spinner } from "~/components/primitives";
import { Markdown } from "~/components/markdown";
import { Section } from "~/components/settings/section";
import { displayName } from "~/components/integrations/display-name";

/**
 * `/skills/$skillName` — one skill's markdown body, in the same centered
 * document shell as the catalog. Read-only, like the catalog: the body
 * ships inside a plugin package.
 *
 * Placeholders stay as authored. The server does not fill them here,
 * because reading a skill is not invoking it — the agent's `skill` tool
 * fills them at invoke time.
 */
export const Route = createFileRoute("/skills/$skillName")({
  component: SkillDetailPage,
});

export function SkillDetailPage() {
  const { skillName } = Route.useParams();
  const { data: skill, isLoading, error } = useSkill(skillName);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <Link to="/skills" className="text-xs text-muted underline-offset-2 hover:underline">
          ← Skills
        </Link>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl text-ink">{displayName(skillName)}</h1>
            {skill?.description && <p className="mt-1 text-sm text-muted">{skill.description}</p>}
          </div>
          {skill && (
            <span className="shrink-0 font-mono text-xs text-muted">
              from {skill.plugin}
              {skill.takesArgs && " · takes arguments"}
            </span>
          )}
        </div>

        <div className="mt-10">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading skill…
            </div>
          )}
          {!isLoading && error && (
            <div className="text-sm text-danger-500">
              Could not load this skill. Open /skills to see the installed skills.
            </div>
          )}
          {!isLoading && !error && skill && (
            <Section
              title="Playbook"
              description={`The assistant reads this text when it calls the skill tool with name "${skill.name}".`}
            >
              <div className="pt-4">
                <Markdown>{skill.content}</Markdown>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}
