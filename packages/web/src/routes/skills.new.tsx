import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SkillDoc } from "~/components/skills/skill-doc";

/**
 * `/skills/new` — write a skill.
 *
 * A skill written here is a `local` row owned by the caller, by a team the
 * caller belongs to, or by the org when the caller is an org admin. It reaches
 * every session that owner starts. On save the page opens the skill it just
 * wrote, so the author lands on the thing rather than back at the grid.
 *
 * `?scope=org` preselects the org owner. An admin gets it from the org Library
 * page's "New org skill" button; a member never sees the option, so the
 * editor falls back to a personal skill.
 */
interface NewSkillSearch {
  scope?: "personal" | "org";
}

export const Route = createFileRoute("/skills/new")({
  validateSearch: (raw): NewSkillSearch => ({
    scope: raw.scope === "org" ? "org" : raw.scope === "personal" ? "personal" : undefined,
  }),
  component: NewSkillPage,
});

export function NewSkillPage() {
  const navigate = useNavigate();
  const { scope } = Route.useSearch();

  return (
    <SkillDoc
      skillId={null}
      defaultScope={scope}
      onCreated={(id) => navigate({ to: "/skills/stored/$skillId", params: { skillId: id } })}
      onDeleted={() => navigate({ to: "/skills" })}
    />
  );
}
