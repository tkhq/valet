import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEventSubscription, useEventSubscriptions } from "~/api/events";
import { useMe, useOrg, useTeams } from "~/api/settings";
import { useWorkflows } from "~/api/workflows";
import { EditSubscriptionForm } from "~/components/events/edit-subscription-form";
import { canMutate, describeTarget, replacementNote } from "~/components/events/subscription-labels";
import { eligibleTeams } from "~/components/session/assistant-rail";
import { Button, ErrorRow, LoadingRow, pageClass } from "~/components/primitives";
import { useCopyToClipboard } from "~/lib/use-copy";
import { useAdoptWorkspaceScope } from "~/lib/workspace-scope";

export const Route = createFileRoute("/events/subscriptions/$subscriptionId")({
  component: () => <SubscriptionDetailPage subscriptionId={Route.useParams().subscriptionId} />,
});

export function SubscriptionDetailPage({ subscriptionId }: { subscriptionId: string }) {
  const { copied, copy } = useCopyToClipboard();
  const query = useEventSubscription(subscriptionId);
  const me = useMe();
  const teams = useTeams();
  const org = useOrg();
  const workflows = useWorkflows();
  const navigate = useNavigate();
  const sub = query.data?.subscription;
  useAdoptWorkspaceScope(sub ? { type: sub.ownerType, id: sub.ownerId } : undefined);
  const siblings = useEventSubscriptions(sub ? { ownerType: sub.ownerType, ownerId: sub.ownerId } : undefined, { enabled: !!sub });
  const mutable = sub && me.data && canMutate(sub, me.data.id, new Set(eligibleTeams(teams.data?.teams, org.data?.features.organizations).map(team => team.id)));
  const replacementId = sub?.target.kind === "orchestrator" ? sub.target.replaces : undefined;

  return <div className="min-w-0 flex-1 overflow-y-auto"><div className={pageClass}>
    <Link to="/events" search={{ tab: "subscriptions" }} className="inline-flex min-h-11 items-center text-sm text-muted hover:text-ink">← Subscriptions</Link>
    {query.isPending ? <LoadingRow label="Loading subscription…" /> : query.error || !sub ? <ErrorRow>
      Could not load this subscription. Check the link and your organization. <button type="button" className="underline" onClick={() => void query.refetch()}>Retry</button>
    </ErrorRow> : <>
      <header className="mb-8 mt-4 space-y-2">
        <p className="text-xs text-muted">{sub.ownerType === "team" ? teams.data?.teams.find(team => team.id === sub.ownerId)?.name ?? "Team" : sub.ownerType === "org" ? "Organization" : "Personal"} subscription · {sub.enabled ? "Enabled" : "Paused"}</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="min-w-0 break-words font-display text-2xl text-ink">{sub.name}</h1>
          <Button size="sm" variant="secondary" onClick={() => void copy(`${window.location.origin}/events/subscriptions/${encodeURIComponent(sub.id)}`)}>{copied ? "Link copied" : "Copy link"}</Button>
        </div>
        <p className="text-sm text-muted">{!mutable ? "Only the owner or a member of the owning team can edit this subscription." : !sub.enabled ? "Review this subscription before enabling it." : "Edit the event, instructions, and destination for this subscription."}</p>
      </header>
      <EditSubscriptionForm key={sub.id} sub={sub} readOnly={!mutable} review={!sub.enabled}
        replacesNote={replacementId ? (siblings.data ? replacementNote(sub, siblings.data.subscriptions) : "Loading the subscription this proposal replaces. Reload the page if it does not appear.") : undefined}
        targetLabel={describeTarget(sub.target, new Map((workflows.data?.workflows ?? []).map(row => [row.id, row.name])), new Map((teams.data?.teams ?? []).map(row => [row.id, row.name])))}
        onOpenChange={open => { if (!open) void navigate({ to: "/events", search: { tab: "subscriptions" } }); }} />
    </>}
  </div></div>;
}
