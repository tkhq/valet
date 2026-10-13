import { createFileRoute } from "@tanstack/react-router";
import { api } from "~/api/client";
import { WorkflowAgentApprovals } from "~/components/workflows/agent-approvals";
import { SharedThreadView } from "~/components/session/shared-thread-view";
import { SessionDetailPage, type SessionSearch } from "./sessions.$sessionId";

export const Route = createFileRoute("/threads/$threadId")({
  validateSearch: (raw): SessionSearch => ({
    tab: raw.tab === "chat" || raw.tab === "browser" || raw.tab === "terminal" || raw.tab === "vscode" ? raw.tab : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
    finding: typeof raw.finding === "string" ? raw.finding : undefined,
  }),
  loader: ({ params }) => api.getThreadAddress(params.threadId),
  component: ThreadPage,
});

function ThreadPage() {
  const address = Route.useLoaderData();
  const { sessionId, id } = address;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  if (sessionId.startsWith("wf:")) return <WorkflowAgentApprovals sessionId={sessionId} />;
  // A guest reaches only this thread, never the owner's workspace.
  if (address.guest) return <SharedThreadView address={address} guest={address.guest} />;
  return <SessionDetailPage sessionId={sessionId} search={{ ...search, thread: id }} onSearchChange={(update) => { void navigate({ search: update }); }} />;
}
