import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { SkillSourcesPanel } from "~/components/skills/skill-sources-panel";
import { useOrg } from "~/api/settings";

/**
 * `/settings/organization/library` — Organization · Library. Org sources only:
 * a repository tracked here mirrors its skills into every member's library.
 *
 * An admin adds, syncs, and removes sources. A member reads them — the status
 * chips show, but the Sync and Remove actions and the add form do not. The
 * `readOnly` prop the panel takes carries that split, keyed off `useOrg()`'s
 * `callerRole`, the same admin signal the members page reads.
 */
export const Route = createFileRoute("/settings/organization/library")({
  component: OrganizationLibraryPage,
});

export function OrganizationLibraryPage() {
  const orgQ = useOrg();
  const isAdmin = orgQ.data?.callerRole === "admin";

  return (
    <Section
      title="Library"
      description="Track a GitHub repository to mirror its skills into every member's library."
    >
      <SkillSourcesPanel scope="org" readOnly={!isAdmin} />
    </Section>
  );
}
