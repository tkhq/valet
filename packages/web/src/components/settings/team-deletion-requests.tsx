import { useEffect, useState } from "react";
import type { TeamDeletionRequestSummary } from "@valet/api/wire";
import { useMe } from "~/api/settings";
import { useDecideTeamDeletionRequest, useSubmitTeamDeletionRequest, useTeamDeletionRequests, useTeamDeletionTargets } from "~/api/team-deletion-requests";
import { Button, ConfirmDialog, ErrorRow, Input, LoadingRow, SelectMenu } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

export function TeamDeletionRequests({ teamId, canManage }: { teamId: string; canManage: boolean }) {
  const me = useMe();
  const requests = useTeamDeletionRequests(teamId);
  const targets = useTeamDeletionTargets(teamId);
  const submit = useSubmitTeamDeletionRequest(teamId);
  const decide = useDecideTeamDeletionRequest(teamId);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] = useState<{ row: TeamDeletionRequestSummary; decision: "approve" | "decline" | "withdraw" } | null>(null);
  const readable = requests.isSuccess && !requests.error;
  useEffect(() => {
    setSelected(""); setReason(""); setNote(""); setConfirmation(null);
  }, [teamId]);
  useEffect(() => {
    if (!canManage) setConfirmation((current) => current?.decision === "withdraw" ? current : null);
  }, [canManage]);
  useEffect(() => { if (!readable) setConfirmation(null); }, [readable]);
  const target = targets.data?.targets.find((t) => `${t.resourceType}:${t.resourceId}` === selected);
  return <section aria-label="Deletion requests" className="space-y-2 py-2">
    <h4 className="text-xs font-medium uppercase tracking-wide text-muted">Deletion requests</h4>
    <p className="text-xs text-muted">Ask a team admin to delete a shared resource. Requests expire after 14 days.</p>
    {requests.isPending ? <LoadingRow label="Loading deletion requests…" /> : requests.error ?
      <ErrorRow>Could not load deletion requests. <Button onClick={() => void requests.refetch()}>Retry</Button></ErrorRow> :
      <ul className="space-y-2">{requests.data.requests.length === 0 && <li className="text-xs text-muted">No deletion requests.</li>}
        {requests.data.requests.map((row) => <li key={row.id} className="rounded border border-line p-2 text-xs">
          <p>{row.resourceLabel} ({resourceTypeLabel(row.resourceType)}) — {row.status}</p>
          <p className="text-muted">Requested by {row.requesterName} on {new Date(row.requestedAt).toLocaleDateString()}{!row.requesterIsMember && " (no longer a team member)"}</p>
          {row.reason && <p>{row.reason}</p>}{row.decisionNote && <p>{row.decisionNote}</p>}
          {row.lastRefusal && <ErrorRow>{row.lastRefusal}</ErrorRow>}
          {row.status === "pending" && <div className="mt-1 flex gap-2">
            {canManage && (["approve", "decline"] as const).map((decision) => <Button key={decision} size="sm" disabled={decide.isPending}
              onClick={() => { decide.reset(); setNote(""); setConfirmation({ row, decision }); }}>{decision === "approve" ? "Approve" : "Decline"}</Button>)}
            {row.requestedBy === me.data?.id && <Button size="sm" disabled={decide.isPending} onClick={() => { decide.reset(); setNote(""); setConfirmation({ row, decision: "withdraw" }); }}>Withdraw</Button>}
          </div>}
        </li>)}
      </ul>}
    {targets.isPending ? <LoadingRow label="Loading team resources…" /> : targets.error ?
      <ErrorRow>Could not load team resources. <Button onClick={() => void targets.refetch()}>Retry resources</Button></ErrorRow> :
      <div className="flex flex-wrap gap-2">
        <SelectMenu ariaLabel="Resource to delete" value={selected}
          disabled={submit.isPending || !readable || targets.data.targets.length === 0}
          triggerLabel={target ? `${target.label} (${resourceTypeLabel(target.resourceType)})` : "Choose a team resource"}
          options={targets.data.targets.map((item) => ({ value: `${item.resourceType}:${item.resourceId}`, label: `${item.label} (${resourceTypeLabel(item.resourceType)})` }))}
          onChange={setSelected} />
        {targets.data.targets.length === 0 && <p className="text-xs text-muted">No resources are available for deletion requests.</p>}
        <Input aria-label="Deletion reason" placeholder="Reason (optional)" maxLength={2000} value={reason} disabled={submit.isPending || !readable} onChange={(e) => setReason(e.target.value)} />
        <Button size="sm" disabled={!target || submit.isPending || !readable} onClick={() => {
          if (target) submit.mutate({ resourceType: target.resourceType, resourceId: target.resourceId, reason }, { onSuccess: () => { setSelected(""); setReason(""); } });
        }}>Request deletion</Button>
      </div>}
    {submit.error && <ErrorRow>{errorText(submit.error)}</ErrorRow>}
    {confirmation && <ConfirmDialog open={readable && (confirmation.decision === "withdraw" || canManage)} onOpenChange={(open) => { if (!open) setConfirmation(null); }}
      title={`${confirmation.decision === "approve" ? "Approve deletion of" : confirmation.decision === "decline" ? "Decline deletion of" : "Withdraw request for"} ${confirmation.row.resourceLabel}?`}
      description={confirmation.decision === "approve" ? "Approval deletes this resource for everyone on the team. If it is still in use, the request stays open and explains what to resolve first. Deletion cannot be undone." : "This closes the request without deleting the resource."}
      confirmLabel={confirmation.decision === "approve" ? "Approve deletion" : confirmation.decision === "decline" ? "Decline request" : "Withdraw request"}
      pending={decide.isPending} error={decide.error ? errorText(decide.error) : undefined}
      onConfirm={() => decide.mutate({ id: confirmation.row.id, decision: confirmation.decision, note }, { onSuccess: () => setConfirmation(null) })} >
      <Input aria-label="Decision note" placeholder="Decision note (optional)" maxLength={2000} disabled={decide.isPending} value={note} onChange={(e) => setNote(e.target.value)} />
    </ConfirmDialog>}
  </section>;
}

function resourceTypeLabel(type: TeamDeletionRequestSummary["resourceType"]): string {
  const labels = { workflow: "Workflow", skill: "Skill", content_source: "Repository source", credential: "Connection", api_key: "API key", team: "Team" };
  return labels[type];
}
