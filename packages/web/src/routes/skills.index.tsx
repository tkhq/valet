import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCatalogOwner } from "~/lib/use-list-owner";
import { useSkills } from "~/api/skills";
import { Button, Spinner } from "~/components/primitives";
import { Pager } from "~/components/pager";
import {
  readScopeFilter,
  readSkillFilter,
  skillFilterQuery,
  SkillGrid,
  type SkillGridFilters,
} from "~/components/skills/skill-grid";
import { SkillSourcesPanel } from "~/components/skills/skill-sources-panel";
import {
  currentCursor,
  formatCursorStack,
  pageNumber,
  parseCursorStack,
  popCursor,
  pushCursor,
} from "~/lib/cursor-stack";

/**
 * `/skills` — markdown documents the assistant can pull into a turn. One
 * grid holds both kinds: skills the installed plugins ship, and skills
 * stored for the caller. Each card carries an origin badge and opens the
 * skill's page.
 *
 * A skill is written here, or by the assistant through the `skills` actions,
 * or synced from a repository. All three land in the same table and reach a
 * session the same way. See docs/specs/2026-08-05-agent-skills-design.md.
 *
 * The repositories panel above the grid is the other half of that rule: it
 * points Valet at a repository to mirror, and never edits a skill. It sits
 * here, over the skills it produces, and lists every source the caller
 * reaches — personal, team, and org — with the scope on the row's badge.
 * Settings keeps one repositories panel still: the org one, which an admin
 * uses to run the library every member reads.
 *
 * One grid, in delivery order. Grouping into a section per plugin was tried
 * and reverted: 8 of the 9 plugins ship exactly one skill, so it produced 8
 * headed sections holding a single card each and stretched 11 items over
 * roughly nine screens. The origin belongs on the card, not in a header.
 *
 * Both lists are paged, and every piece of that state — the filters and each
 * list's cursor stack — lives in the search params. A page is then a real
 * history entry, so Back pages back instead of leaving Skills.
 *
 * The grid, its filter chips, the scope select, and the search box live in
 * `SkillGrid`, so the org Library settings page reuses the same grid.
 */
interface SkillsSearch {
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
  const search: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? { ...raw } : {};
  const text = (key: string): string | undefined =>
    typeof search[key] === "string" ? search[key] : undefined;
  return {
    filter: text("filter"),
    scope: text("scope"),
    q: text("q"),
    page: text("page"),
    sourcePage: text("sourcePage"),
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
  const { data, isLoading, error } = useSkills({
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
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-end justify-between gap-4">
          <h1 className="font-display text-2xl text-ink">Skills</h1>
          <Button size="sm" className="shrink-0" asChild>
            <Link to="/skills/new">New skill</Link>
          </Button>
        </div>

        <div className="mt-6">
          <SkillSourcesPanel
            cursors={sourceCursors}
            onCursorsChange={(next) => go({ sourcePage: formatCursorStack(next) })}
          />
        </div>

        <div className="mt-8">
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
              />
              <Pager
                label="skills"
                page={pageNumber(skillCursors)}
                hasPrevious={skillCursors.length > 0}
                hasNext={data?.nextCursor != null}
                onPrevious={() => go({ page: formatCursorStack(popCursor(skillCursors)) })}
                onNext={() => {
                  if (data?.nextCursor != null) {
                    go({ page: formatCursorStack(pushCursor(skillCursors, data.nextCursor)) });
                  }
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
