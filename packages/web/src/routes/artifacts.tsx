import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useArtifacts } from "~/api/artifacts";
import { useMe } from "~/api/settings";
import { CreateArtifactDialog } from "~/components/artifact/create-artifact";
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
  const [creating, setCreating] = useState(false);
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
        description="Documents and pages in this workspace."
        actions={<div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!owner} onClick={() => setCreating(true)}>Create artifact</Button>
          <Button asChild variant="secondary" size="sm"><Link to="/memory">Memory</Link></Button>
        </div>}
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
          {query.data.artifacts.length === 0 ? <>
            <EmptyRow>{cursors.length || nextCursor ? "No visible artifacts on this page. Use the page controls to continue." : "No artifacts yet. Start with a document or HTML page."}</EmptyRow>
            {!cursors.length && !nextCursor && <Button onClick={() => setCreating(true)}>Create artifact</Button>}
          </> : <WorkList>
            {query.data.artifacts.map((artifact) => <WorkRow
              key={artifact.id}
              title={artifact.revoked ? artifact.title : <Link to="/a/$token" params={{ token: artifact.token }} className="[overflow-wrap:anywhere]">{artifact.title}</Link>}
              badge={<Badge>{artifact.revoked ? "Revoked" : artifact.ownerType === "team" ? "Team" : artifact.visibility === "public" ? "Public" : "Organization"}</Badge>}
              time={artifact.updatedAt}
              detail={<span>{artifact.format === "html" ? "HTML Page" : "Document"} · Version {artifact.sharedVersion ?? artifact.version}</span>}
              actions={artifact.actorUserId === me.data?.id && <Button asChild variant="secondary" size="sm">
                <Link to="/artifacts/$id" params={{ id: artifact.id }} aria-label={`Edit ${artifact.title}`}>Edit</Link>
              </Button>}
            />)}
          </WorkList>}
          <Pager label="artifacts" page={pageNumber(cursors)} hasPrevious={cursors.length > 0} hasNext={!!nextCursor}
            onPrevious={() => go(popCursor(cursors))} onNext={() => { if (nextCursor) go(pushCursor(cursors, nextCursor)); }} />
        </>}
    </div>
    {owner && <CreateArtifactDialog open={creating} owner={owner} onOpenChange={setCreating} />}
  </div>;
}
