import { createFileRoute } from "@tanstack/react-router";
import { useSkill } from "~/api/skills";
import { displayName } from "~/components/integrations/display-name";
import { originLabel } from "~/components/skills/skill-card";
import { SkillDocument } from "~/components/skills/skill-document";

/**
 * `/skills/$skillName` — one skill's body, addressed by the name the agent
 * asks for. A plugin skill wins a repeated name here exactly as it wins at
 * session build, so this route always shows the skill a session would get.
 *
 * A stored skill that another skill shadows shares its name with the winner,
 * so this route cannot reach it. `/skills/stored/$skillId` addresses those
 * by row id.
 */
export const Route = createFileRoute("/skills/$skillName")({
  component: SkillDetailPage,
});

export function SkillDetailPage() {
  const { skillName } = Route.useParams();
  const { data: skill, isLoading, error } = useSkill(skillName);

  return (
    <SkillDocument
      title={displayName(skillName)}
      description={skill?.description}
      meta={
        skill && (
          <>
            {skill.origin === "plugin" ? `from ${skill.plugin}` : originLabel(skill)}
            {skill.takesArgs && " · takes arguments"}
          </>
        )
      }
      content={skill?.content}
      skillName={skill?.name}
      isLoading={isLoading}
      error={error}
    />
  );
}
