import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SkillDoc } from "~/components/skills/skill-doc";

/**
 * `/skills/new` — write a skill.
 *
 * A skill written here is a `local` row owned by the caller, or by a team
 * the caller belongs to, and it reaches every session that owner starts. On
 * save the page opens the skill it just wrote, so the author lands on the
 * thing rather than back at the grid.
 */
export const Route = createFileRoute("/skills/new")({
  component: NewSkillPage,
});

export function NewSkillPage() {
  const navigate = useNavigate();

  return (
    <SkillDoc
      skillId={null}
      onCreated={(id) => navigate({ to: "/skills/stored/$skillId", params: { skillId: id } })}
      onDeleted={() => navigate({ to: "/skills" })}
    />
  );
}
