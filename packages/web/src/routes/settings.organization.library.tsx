import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { SkillSourcesPanel } from "~/components/skills/skill-sources-panel";
import {
  readSkillFilter,
  skillFilterQuery,
  SkillGrid,
  type SkillGridFilters,
} from "~/components/skills/skill-grid";
import { Button, Spinner } from "~/components/primitives";
import { Pager } from "~/components/pager";
import {
  currentCursor,
  formatCursorStack,
  pageNumber,
  parseCursorStack,
  popCursor,
  pushCursor,
} from "~/lib/cursor-stack";
import { useOrg } from "~/api/settings";
import { useSkills } from "~/api/skills";

/**
 * `/settings/organization/library` — Organization · Library.
 *
 * Two panels. The sources panel tracks GitHub repositories that mirror skills
 * into every member's library. Below it, the org skills panel lists the org's
 * own skills and prompts.
 *
 * This is the org half of a surface that also lives on `/skills`. The two do
 * not repeat each other: `/skills` shows every source a person reaches and
 * files a new one under the workspace they are in, while this page pins the
 * org, so an admin reads and changes the org library alone. The personal
 * page that used to sit beside both is gone — a row's scope is a badge now,
 * not a third page.
 *
 * An admin adds, syncs, and removes sources, and writes new org skills. A
 * member reads both — the status chips and the cards show, but the write
 * actions do not. `readOnly` on the sources panel and the missing "New org
 * skill" button carry that split, keyed off `useOrg()`'s `callerRole`, the
 * same admin signal the members page reads.
 *
 * Both lists are paged, and both keep their filters and cursor stack in the
 * search params so Back pages back.
 */
interface LibrarySearch {
  filter?: string;
  q?: string;
  /** Cursor stack for the org skills grid. */
  page?: string;
  /** Cursor stack for the repositories panel. */
  sourcePage?: string;
}

function readLibrarySearch(raw: unknown): LibrarySearch {
  const search: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? { ...raw } : {};
  const text = (key: string): string | undefined =>
    typeof search[key] === "string" ? search[key] : undefined;
  return {
    filter: text("filter"),
    q: text("q"),
    page: text("page"),
    sourcePage: text("sourcePage"),
  };
}

export const Route = createFileRoute("/settings/organization/library")({
  component: OrganizationLibraryPage,
  validateSearch: readLibrarySearch,
});

export function OrganizationLibraryPage() {
  const orgQ = useOrg();
  const isAdmin = orgQ.data?.callerRole === "admin";
  const orgId = orgQ.data?.id;

  // The top-level hooks, not `Route.useSearch()`: the route suites mock this
  // module and never build a real router context.
  const search = readLibrarySearch(useSearch({ strict: false }));
  const navigate = useNavigate();

  function go(next: Partial<LibrarySearch>): void {
    void navigate({ to: "/settings/organization/library", search: { ...search, ...next } });
  }

  return (
    <div className="space-y-10">
      <Section
        title="Library"
        description="Track a GitHub repository to mirror its skills into every member's library."
      >
        {orgId === undefined ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={14} /> Loading the organization…
          </div>
        ) : (
          <SkillSourcesPanel
            owner={{ type: "org", id: orgId }}
            readOnly={!isAdmin}
            cursors={parseCursorStack(search.sourcePage)}
            onCursorsChange={(next) => go({ sourcePage: formatCursorStack(next) })}
          />
        )}
      </Section>

      <OrgSkillsSection
        isAdmin={isAdmin}
        orgId={orgId}
        search={search}
        onSearchChange={go}
      />
    </div>
  );
}

/** The org's own skills and prompts. Reuses the `/skills` grid, pinned to the
 * org owner so the server sends org rows alone — a client-side filter over a
 * page would drop every org row that fell on a later page. */
function OrgSkillsSection({
  isAdmin,
  orgId,
  search,
  onSearchChange,
}: {
  isAdmin: boolean;
  orgId: string | undefined;
  search: LibrarySearch;
  onSearchChange: (next: Partial<LibrarySearch>) => void;
}) {
  const filters: SkillGridFilters = {
    filter: readSkillFilter(search.filter),
    // The page pins the org, so the scope select is off and its value fixed.
    scope: "all",
    query: search.q ?? "",
  };
  const cursors = parseCursorStack(search.page);
  const cursor = currentCursor(cursors);
  // The org id is the pin, so the read waits for it. Without the wait the
  // query would ask for the whole catalog once and show a member's own
  // skills under an "Organization skills" heading.
  const { data, isLoading, error } = useSkills(
    {
      ...skillFilterQuery(filters),
      ...(orgId === undefined ? {} : { ownerType: "org", ownerId: orgId }),
      ...(cursor === undefined ? {} : { cursor }),
    },
    { enabled: orgId !== undefined },
  );
  const orgSkills = data?.skills ?? [];
  const waiting = isLoading || orgId === undefined;

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

      {waiting && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading skills…
        </div>
      )}
      {!waiting && error && (
        <div className="text-sm text-danger-500">
          Could not load skills. Check that the server is running, then reload.
        </div>
      )}
      {!waiting && !error && (
        <>
          <SkillGrid
            skills={orgSkills}
            filters={filters}
            onFiltersChange={(next) =>
              onSearchChange({
                filter: next.filter === "all" ? undefined : next.filter,
                q: next.query.trim().length === 0 ? undefined : next.query,
                page: undefined,
              })
            }
            showScopeFilter={false}
            emptyLabel="No org skills yet."
          />
          <Pager
            label="organization skills"
            page={pageNumber(cursors)}
            hasPrevious={cursors.length > 0}
            hasNext={data?.nextCursor != null}
            onPrevious={() => onSearchChange({ page: formatCursorStack(popCursor(cursors)) })}
            onNext={() => {
              if (data?.nextCursor != null) {
                onSearchChange({ page: formatCursorStack(pushCursor(cursors, data.nextCursor)) });
              }
            }}
          />
        </>
      )}
    </section>
  );
}
