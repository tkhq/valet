import { createFileRoute } from "@tanstack/react-router";
import { useStoredSkill } from "~/api/skills";
import { displayName } from "~/components/integrations/display-name";
import { originLabel, shadowNote } from "~/components/skills/skill-card";
import { SkillDocument } from "~/components/skills/skill-document";

/**
 * `/skills/stored/$skillId` — a stored skill's body, addressed by row id.
 *
 * The id, not the name: a shadowed skill shares its name with the skill that
 * shadows it, so only the id reaches it. Read-only, like every skill page —
 * a `local` skill is written by the assistant or by the API, and a `repo`
 * skill belongs to the repository it came from.
 */
export const Route = createFileRoute("/skills/stored/$skillId")({
  component: StoredSkillPage,
});

export function StoredSkillPage() {
  const { skillId } = Route.useParams();
  const { data: skill, isLoading, error } = useStoredSkill(skillId);

  return (
    <SkillDocument
      title={skill ? displayName(skill.name) : "Skill"}
      description={skill?.description}
      meta={skill && originLabel(skill)}
      notice={skill?.shadowed ? shadowNote(skill) : undefined}
      content={skill?.content}
      skillName={skill?.name}
      isLoading={isLoading}
      error={error}
    />
  );
}
