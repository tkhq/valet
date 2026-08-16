import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { SkillSourcesPanel } from "~/components/skills/skill-sources-panel";

/**
 * `/settings/library-sources` — You · Library sources. Track a GitHub
 * repository, and Valet mirrors its skills into your library. This panel keeps
 * personal and team sources; org sources live under Organization · Library.
 */
export const Route = createFileRoute("/settings/library-sources")({
  component: LibrarySourcesPage,
});

export function LibrarySourcesPage() {
  return (
    <Section
      title="Library sources"
      description="Track a GitHub repository to mirror its skills into your library."
    >
      <SkillSourcesPanel scope="personal" />
    </Section>
  );
}
