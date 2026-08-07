import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SkillDoc } from "~/components/skills/skill-doc";

/**
 * `/skills/stored/$skillId` — one stored skill, addressed by row id.
 *
 * The id, not the name: a shadowed skill shares its name with the skill that
 * shadows it, so only the id reaches it. Navigation glue only — `SkillDoc`
 * holds the page.
 */
export const Route = createFileRoute("/skills/stored/$skillId")({
  component: StoredSkillPage,
});

export function StoredSkillPage() {
  const { skillId } = Route.useParams();
  const navigate = useNavigate();

  return (
    <SkillDoc
      skillId={skillId}
      onCreated={(id) => navigate({ to: "/skills/stored/$skillId", params: { skillId: id } })}
      onDeleted={() => navigate({ to: "/skills" })}
    />
  );
}
