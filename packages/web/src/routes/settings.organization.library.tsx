import { createFileRoute, Link } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { SkillSourcesPanel } from "~/components/skills/skill-sources-panel";
import { SkillGrid } from "~/components/skills/skill-grid";
import { Button, Spinner } from "~/components/primitives";
import { useOrg } from "~/api/settings";
import { useSkills } from "~/api/skills";

/**
 * `/settings/organization/library` — Organization · Library.
 *
 * Two panels. The sources panel tracks GitHub repositories that mirror skills
 * into every member's library. Below it, the org skills panel lists the org's
 * own skills and prompts.
 *
 * An admin adds, syncs, and removes sources, and writes new org skills. A
 * member reads both — the status chips and the cards show, but the write
 * actions do not. `readOnly` on the sources panel and the missing "New org
 * skill" button carry that split, keyed off `useOrg()`'s `callerRole`, the
 * same admin signal the members page reads.
 */
export const Route = createFileRoute("/settings/organization/library")({
  component: OrganizationLibraryPage,
});

export function OrganizationLibraryPage() {
  const orgQ = useOrg();
  const isAdmin = orgQ.data?.callerRole === "admin";

  return (
    <div className="space-y-10">
      <Section
        title="Library"
        description="Track a GitHub repository to mirror its skills into every member's library."
      >
        <SkillSourcesPanel scope="org" readOnly={!isAdmin} />
      </Section>

      <OrgSkillsSection isAdmin={isAdmin} />
    </div>
  );
}

/** The org's own skills and prompts. Reuses the `/skills` grid, filtered to
 * org rows. The rows already ride in the shared `useSkills` list, so a
 * client-side filter is enough. */
function OrgSkillsSection({ isAdmin }: { isAdmin: boolean }) {
  const { data, isLoading, error } = useSkills();
  const orgSkills = (data?.skills ?? []).filter(
    (s) => s.origin !== "plugin" && s.ownerType === "org",
  );

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-xl text-ink">Organization skills &amp; prompts</h2>
          <p className="text-sm text-muted">
            Skills and prompts owned by the org. Every member&apos;s sessions can read them.
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" asChild>
            <Link to="/skills/new" search={{ scope: "org" }}>
              New org skill
            </Link>
          </Button>
        )}
      </div>

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
      {!isLoading && !error && (
        <SkillGrid
          skills={orgSkills}
          showScopeFilter={false}
          emptyLabel="No org skills yet."
        />
      )}
    </section>
  );
}
