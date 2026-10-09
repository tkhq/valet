import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCatalogOwner, useListOwner } from "~/lib/use-list-owner";
import { useSkills } from "~/api/skills";
import { Button, Spinner, TabBar, tabPanelId, pageClass } from "~/components/primitives";
import { Pager } from "~/components/pager";
import {
  readScopeFilter,
  readSkillFilter,
  skillFilterQuery,
  SkillGrid,
  type SkillGridFilters,
} from "~/components/skills/skill-grid";
import { RepoSourcesPanel } from "~/components/skills/repo-sources-panel";
import { WorkspaceClause } from "~/components/workspace-clause";
import {
  currentCursor,
  formatCursorStack,
  pageNumber,
  parseCursorStack,
  popCursor,
  pushCursor,
} from "~/lib/cursor-stack";
import { textParam } from "~/lib/search-params";
import { cn } from "~/lib/cn";

/** The catalog and source management keep independent URL state. */
interface SkillsSearch {
  view?: "sources";
  filter?: string;
  scope?: string;
  q?: string;
  /** Cursor stack for the grid. */
  page?: string;
  /** Cursor stack for the repositories panel. */
  sourcePage?: string;
}

/** Reads the search params, keeping only strings. A hand-edited value that
 * names no filter reads as "all", which shows everything rather than an empty
 * page that gives no reason. */
function readSkillsSearch(raw: unknown): SkillsSearch {
  return {
    view: textParam(raw, "view") === "sources" ? "sources" : undefined,
    filter: textParam(raw, "filter"),
    scope: textParam(raw, "scope"),
    q: textParam(raw, "q"),
    page: textParam(raw, "page"),
    sourcePage: textParam(raw, "sourcePage"),
  };
}

export const Route = createFileRoute("/skills/")({
  component: SkillsIndexPage,
  validateSearch: readSkillsSearch,
});

export function SkillsIndexPage() {
  // The top-level hooks, not `Route.useSearch()`: the route suites mock this
  // module and never build a real router context.
  const search = readSkillsSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const view = search.view ?? "catalog";

  const filters: SkillGridFilters = {
    filter: readSkillFilter(search.filter),
    scope: readScopeFilter(search.scope),
    query: search.q ?? "",
  };
  const skillCursors = parseCursorStack(search.page);
  const sourceCursors = parseCursorStack(search.sourcePage);

  const cursor = currentCursor(skillCursors);
  // The nav's switcher decides which workspace this catalog is FOR — for a
  // TEAM. The personal workspace sends no pin, because a pin selects one
  // owner and would hide every ORG-owned skill, which is most of a catalog
  // built from an org-wide repository. See `useCatalogOwner`.
  const owner = useCatalogOwner();
  const listOwner = useListOwner();
  const { data, isLoading, error, isPlaceholderData } = useSkills({
    ...skillFilterQuery(filters),
    ...(owner ? { ownerType: owner.ownerType, ownerId: owner.ownerId } : {}),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const skills = data?.skills ?? [];

  function go(next: Partial<SkillsSearch>): void {
    void navigate({ to: "/skills", search: { ...search, ...next } });
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className={cn(pageClass, "max-w-3xl")}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-baseline gap-3">
            <h1 className="text-2xl font-medium text-ink">Skills</h1>
            <WorkspaceClause />
          </div>
          <Button size="sm" className="shrink-0" asChild>
            <Link to="/skills/new">New skill</Link>
          </Button>
        </div>

        <p className="mt-3 text-sm text-muted">
          Skills give the assistant instructions for a task. Installed skills do not connect accounts or grant access.
        </p>
        <div className="mt-6">
          <TabBar
            label="Skills views"
            tabs={[{ id: "catalog", label: "Catalog" }, { id: "sources", label: "Sources" }]}
            active={view}
            onSelect={(next) => go({ view: next === "sources" ? "sources" : undefined })}
          />
        </div>
        {view === "sources" && <div className="mt-6" role="tabpanel" id={tabPanelId("Skills views", "sources")} aria-labelledby={`${tabPanelId("Skills views", "sources")}-tab`}>
          <p className="mb-4 text-sm text-muted">Manage the repositories that supply skills to this workspace.</p>
          {/* The repositories of the workspace in view, matching the skills below:
              a personal repository's skills are personal, so a team page must not list it. */}
          <RepoSourcesPanel
            {...(listOwner ? { owner: { type: listOwner.ownerType, id: listOwner.ownerId } } : {})}
            cursors={sourceCursors}
            onCursorsChange={(next) => go({ sourcePage: formatCursorStack(next) })}
          />
        </div>}

        {view === "catalog" && <div className="mt-8" role="tabpanel" id={tabPanelId("Skills views", "catalog")} aria-labelledby={`${tabPanelId("Skills views", "catalog")}-tab`}>
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner size={14} /> Loading skills…
            </div>
          )}
          {!isLoading && (
            <>
              <SkillGrid
                skills={skills}
                filters={filters}
                // A changed filter asks a different question of the catalog,
                // so the answer starts at its first page.
                onFiltersChange={(next) =>
                  go({
                    filter: next.filter === "all" ? undefined : next.filter,
                    scope: next.scope === "all" ? undefined : next.scope,
                    q: next.query.trim().length === 0 ? undefined : next.query,
                    page: undefined,
                  })
                }
                emptyLabel="No skills yet. Write one, or ask your assistant to write one for you."
                // Through the grid, not in its place: a failed SEARCH must
                // keep the box that can change or clear it.
                errorLabel={
                  error
                    ? "Could not load skills. Check that the server is running, then reload."
                    : undefined
                }
              />
              {!error && (
                <Pager
                  label="skills"
                  page={pageNumber(skillCursors)}
                  hasPrevious={skillCursors.length > 0}
                  hasNext={data?.nextCursor != null}
                  busy={isPlaceholderData}
                  onPrevious={() => go({ page: formatCursorStack(popCursor(skillCursors)) })}
                  onNext={() => {
                    if (data?.nextCursor != null) {
                      go({ page: formatCursorStack(pushCursor(skillCursors, data.nextCursor)) });
                    }
                  }}
                />
              )}
            </>
          )}
        </div>}
      </div>
    </div>
  );
}
