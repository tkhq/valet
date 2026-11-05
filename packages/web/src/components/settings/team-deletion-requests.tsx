import { Pager } from "~/components/pager";
import { currentCursor, pageNumber, popCursor, pushCursor } from "~/lib/cursor-stack";
import { useEffect, useState } from "react";
import type { TeamDeletionRequestSummary } from "@valet/api/wire";
import { useMe } from "~/api/settings";
import { useDecideTeamDeletionRequest, useSubmitTeamDeletionRequest, useTeamDeletionRequests, useTeamDeletionTargets } from "~/api/team-deletion-requests";
import { Badge, type BadgeProps, Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, EmptyRow, ErrorRow, Input, LoadingRow, SelectMenu, WorkList, WorkRow } from "~/components/primitives";
import { SubSection } from "./section";
import { errorText } from "~/lib/error-text";

/** One list, newest first: a filter over a list that is almost always short only hides rows. */
const STATUS_VARIANT: Partial<Record<TeamDeletionRequestSummary["status"], BadgeProps["variant"]>> = { pending: "warning", approved: "success" };

interface Props {
  teamId: string;
  canManage: boolean;
  /** The open request form's target key: "" before a pick, null when closed.
   * The team menu sets it to open the form on the team itself. */
  request?: string | null;
  onRequestChange?: (request: string | null) => void;
}

export function TeamDeletionRequests(props: Props) {
  // The key drops drafts, dialogs, and pages when the team changes.
  return <ScopedDeletionRequests key={props.teamId} {...props} />;
}

function ScopedDeletionRequests({ teamId, canManage, request, onRequestChange }: Props) {
  const me = useMe();
  const [cursors, setCursors] = useState<string[]>([]);
  const requests = useTeamDeletionRequests(teamId, { status: "all", limit: 50, cursor: currentCursor(cursors) });
  const targets = useTeamDeletionTargets(teamId);
  const submit = useSubmitTeamDeletionRequest(teamId);
  const decide = useDecideTeamDeletionRequest(teamId);
  const [localRequest, setLocalRequest] = useState<string | null>(null);
  const selected = request === undefined ? localRequest : request;
  const setSelected = onRequestChange ?? setLocalRequest;
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] = useState<{ row: TeamDeletionRequestSummary; decision: "approve" | "decline" | "withdraw" } | null>(null);
  const readable = requests.isSuccess && !requests.error;
  useEffect(() => {
    if (!canManage) setConfirmation((current) => current?.decision === "withdraw" ? current : null);
  }, [canManage]);
  useEffect(() => { if (!readable) setConfirmation(null); }, [readable]);
  const target = targets.data?.targets.find((t) => `${t.resourceType}:${t.resourceId}` === selected);
  const closeRequest = () => { setSelected(null); setReason(""); };
  return <SubSection title="Deletion requests" description="Ask a team admin to delete a shared resource."
    actions={<Button variant="secondary" size="sm" disabled={!readable} onClick={() => { submit.reset(); setSelected(""); }}>Request deletion…</Button>}>
    {requests.isPending ? <LoadingRow label="Loading deletion requests…" /> : requests.error ?
      <ErrorRow>Could not load deletion requests. <Button onClick={() => void requests.refetch()}>Retry</Button></ErrorRow> :
      requests.data.requests.length === 0 ? <EmptyRow className="py-0">No deletion requests.</EmptyRow> :
      <WorkList>{requests.data.requests.map((row) => <WorkRow key={row.id} title={row.resourceLabel} time={row.requestedAt}
        badge={<Badge variant={STATUS_VARIANT[row.status] ?? "neutral"} className="capitalize">{row.status}</Badge>}
        detail={<>
          {resourceTypeLabel(row.resourceType)} · Requested by {row.requesterName}{!row.requesterIsMember && " (no longer a team member)"}
          {row.reason && <span className="block">{row.reason}</span>}
          {row.decisionNote && <span className="block">{row.decisionNote}</span>}
          {row.lastRefusal && <span role="alert" className="block text-danger-500">{row.lastRefusal}</span>}
        </>}
        actions={row.status === "pending" && <>
          {canManage && (["approve", "decline"] as const).map((decision) => <Button key={decision} variant="secondary" size="sm" disabled={decide.isPending}
            onClick={() => { decide.reset(); setNote(""); setConfirmation({ row, decision }); }}>{decision === "approve" ? "Approve" : "Decline"}</Button>)}
          {row.requestedBy === me.data?.id && <Button variant="secondary" size="sm" disabled={decide.isPending} onClick={() => { decide.reset(); setNote(""); setConfirmation({ row, decision: "withdraw" }); }}>Withdraw</Button>}
        </>} />)}
      </WorkList>}
    <Pager label="deletion requests" page={pageNumber(cursors)} hasPrevious={cursors.length > 0}
      hasNext={readable && requests.data?.nextCursor != null} busy={requests.isFetching}
      onPrevious={() => { setConfirmation(null); setCursors(popCursor(cursors)); }}
      onNext={() => {
        if (readable && requests.data?.nextCursor) { setConfirmation(null); setCursors(pushCursor(cursors, requests.data.nextCursor)); }
      }} />
    <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) closeRequest(); }}>
      <DialogContent title="Request deletion" description="A team admin reviews the request. Requests expire after 14 days.">
        {targets.isPending ? <LoadingRow label="Loading team resources…" /> : targets.error ?
          <ErrorRow>Could not load team resources. <Button onClick={() => void targets.refetch()}>Retry resources</Button></ErrorRow> :
          targets.data.targets.length === 0 ? <p className="text-sm text-muted">No resources are available for deletion requests.</p> :
          <SelectMenu ariaLabel="Resource to delete" value={selected ?? ""} disabled={submit.isPending} triggerClassName="w-full justify-start"
            triggerLabel={target ? `${target.label} (${resourceTypeLabel(target.resourceType)})` : "Choose a team resource"}
            options={targets.data.targets.map((item) => ({ value: `${item.resourceType}:${item.resourceId}`, label: `${item.label} (${resourceTypeLabel(item.resourceType)})` }))}
            onChange={setSelected} />}
        <Input aria-label="Deletion reason" placeholder="Reason (optional)" maxLength={2000} value={reason} disabled={submit.isPending} onChange={(e) => setReason(e.target.value)} />
        {submit.error && <ErrorRow className="py-0">{errorText(submit.error)}</ErrorRow>}
        <DialogFooter>
          <Button variant="secondary" onClick={closeRequest}>Cancel</Button>
          <Button disabled={!target || submit.isPending || !readable} onClick={() => {
            if (target) submit.mutate({ resourceType: target.resourceType, resourceId: target.resourceId, reason }, { onSuccess: closeRequest });
          }}>Request deletion</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {confirmation && <ConfirmDialog open={readable && (confirmation.decision === "withdraw" || canManage)} onOpenChange={(open) => { if (!open) setConfirmation(null); }}
      title={`${confirmation.decision === "approve" ? "Approve deletion of" : confirmation.decision === "decline" ? "Decline deletion of" : "Withdraw request for"} ${confirmation.row.resourceLabel}?`}
      description={confirmation.decision === "approve" ? "Approval deletes this resource for everyone on the team. If it is still in use, the request stays open and explains what to resolve first. Deletion cannot be undone." : "This closes the request without deleting the resource."}
      confirmLabel={confirmation.decision === "approve" ? "Approve deletion" : confirmation.decision === "decline" ? "Decline request" : "Withdraw request"}
      pending={decide.isPending} error={decide.error ? errorText(decide.error) : undefined}
      onConfirm={() => decide.mutate({ id: confirmation.row.id, decision: confirmation.decision, note }, { onSuccess: () => setConfirmation(null) })} >
      <Input aria-label="Decision note" placeholder="Decision note (optional)" maxLength={2000} disabled={decide.isPending} value={note} onChange={(e) => setNote(e.target.value)} />
    </ConfirmDialog>}
  </SubSection>;
}

function resourceTypeLabel(type: TeamDeletionRequestSummary["resourceType"]): string {
  const labels = { workflow: "Workflow", skill: "Skill", content_source: "Repository source", credential: "Connection", api_key: "API key", team: "Team" };
  return labels[type];
}
