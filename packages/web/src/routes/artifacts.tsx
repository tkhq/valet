import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useArtifacts } from "~/api/artifacts";
import { useMe } from "~/api/settings";
import { Badge, Button, EmptyRow, ErrorRow, LoadingRow, PageHeader, WorkList, WorkRow, pageClass } from "~/components/primitives";
import { Pager } from "~/components/pager";
import { WorkspaceClause } from "~/components/workspace-clause";
import { currentCursor, formatCursorStack, pageNumber, parseCursorStack, popCursor, pushCursor } from "~/lib/cursor-stack";
import { usePageTitle } from "~/lib/page-title";
import { textParam } from "~/lib/search-params";
import { useListOwner } from "~/lib/use-list-owner";

function readSearch(raw: unknown) {
  return { page: textParam(raw, "page"), pageOwner: textParam(raw, "pageOwner") };
}

export const Route = createFileRoute("/artifacts")({
  component: ArtifactsPage,
  validateSearch: readSearch,
});

export function ArtifactsPage() {
  usePageTitle("Artifacts");
  const owner = useListOwner();
  const me = useMe();
  const search = readSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const ownerKey = owner ? `${owner.ownerType}:${owner.ownerId}` : undefined;
  // Cursors belong to one owner. Switching workspaces starts at page one.
  const cursors = search.pageOwner === ownerKey ? parseCursorStack(search.page) : [];
  const query = useArtifacts(owner, { enabled: !!owner, limit: 50, cursor: currentCursor(cursors) });
  const nextCursor = query.data?.nextCursor;
  const go = (stack: string[]) => void navigate({
    to: "/artifacts",
    search: { page: formatCursorStack(stack), pageOwner: stack.length ? ownerKey : undefined },
  });

  return <div className="min-w-0 flex-1 overflow-y-auto">
    <div className={pageClass}>
      <PageHeader
        className="mb-6"
        title="Artifacts"
        clause={<WorkspaceClause />}
        description="Published documents and pages in this workspace, most recently updated first."
        actions={<Button asChild variant="secondary" size="sm"><Link to="/memory">Memory</Link></Button>}
      />
      {!owner && me.isError ? <ErrorRow>Could not load your workspace. Reload this page to try again.</ErrorRow>
        : !owner || query.isPending ? <LoadingRow label="Loading artifacts…" />
        : query.isError ? <>
          <ErrorRow>Could not load artifacts. Try again or return to the first page.</ErrorRow>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void query.refetch()}>Try again</Button>
            {cursors.length > 0 && <Button variant="ghost" size="sm" onClick={() => go([])}>First page</Button>}
          </div>
        </> : <>
          {query.data.artifacts.length === 0 ? <EmptyRow>
            {cursors.length || nextCursor ? "No visible artifacts on this page. Use the page controls to continue." : "No artifacts yet. Ask your assistant to publish a document or page."}
          </EmptyRow> : <WorkList>
            {query.data.artifacts.map((artifact) => <WorkRow
              key={artifact.id}
              title={artifact.revoked ? artifact.title : <Link to="/a/$token" params={{ token: artifact.token }} className="[overflow-wrap:anywhere]">{artifact.title}</Link>}
              badge={<Badge>{artifact.revoked ? "Revoked" : artifact.ownerType === "team" ? "Team" : artifact.visibility === "public" ? "Public" : "Organization"}</Badge>}
              time={artifact.updatedAt}
              detail={<span className="[overflow-wrap:anywhere]">{artifact.format === "html" ? "Page" : "Document"} · Version {artifact.sharedVersion ?? artifact.version} · {artifact.path}</span>}
            />)}
          </WorkList>}
          <Pager label="artifacts" page={pageNumber(cursors)} hasPrevious={cursors.length > 0} hasNext={!!nextCursor}
            onPrevious={() => go(popCursor(cursors))} onNext={() => { if (nextCursor) go(pushCursor(cursors, nextCursor)); }} />
        </>}
    </div>
  </div>;
}
