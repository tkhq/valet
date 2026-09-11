import { useState } from "react";
import { usePolicies, usePutTeamPolicyOverride, useDeletePolicy, useTeamGrants, useDeleteTeamGrant, apiErrorMessage } from "~/api/policies";
import { PolicyOverridesEditor } from "./policy-overrides-section";
import { GrantsList } from "./grants-section";
import { PoliciesSection } from "./policies-section";

export function TeamPolicyOverrides({ teamId, canEdit }: { teamId: string; canEdit: boolean }) {
  const policies = usePolicies(teamId);
  const grants = useTeamGrants(teamId);
  const put = usePutTeamPolicyOverride(teamId);
  const del = useDeletePolicy(teamId);
  const revoke = useDeleteTeamGrant(teamId);
  // Unmount drafts/errors and cached controls when either scoped read fails.
  if (policies.error || grants.error) return <p role="alert">{apiErrorMessage(policies.error ?? grants.error)}</p>;
  if (!policies.data || !grants.data) return <p role="status">Loading…</p>;
  return <TeamPolicyContent key={`${teamId}:${canEdit}`} policies={policies.data.policies} grants={grants.data.grants}
    teamId={teamId} canEdit={canEdit} put={put} del={del} revoke={revoke} />;
}

function TeamPolicyContent({ teamId, policies, grants, canEdit, put, del, revoke }: {
  teamId: string;
  policies: NonNullable<ReturnType<typeof usePolicies>["data"]>["policies"];
  grants: NonNullable<ReturnType<typeof useTeamGrants>["data"]>["grants"];
  canEdit: boolean;
  put: ReturnType<typeof usePutTeamPolicyOverride>;
  del: ReturnType<typeof useDeletePolicy>;
  revoke: ReturnType<typeof useDeleteTeamGrant>;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const simple = policies.filter(p => p.appliesIn === "any" && p.paramMatchers.length === 0 && p.expiresAt === null);
  const advanced = policies.filter(p => !simple.includes(p));
  return <div className="space-y-10">
    <PolicyOverridesEditor overrides={simple} title="Team policy overrides" description="Team overrides on top of org policy."
      canEdit={canEdit} saving={put.isPending} deleting={del.isPending} save={body => put.mutateAsync(body)} remove={row => del.mutateAsync(row.id)} />
    <GrantsList title="Team active grants" grants={grants} canEdit={canEdit} pending={revoke.isPending} revoke={grant => revoke.mutateAsync(grant.id)} />
    <details onToggle={event => setAdvancedOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">Advanced rules ({advanced.length})</summary>
      {advancedOpen && <div className="pt-4"><PoliciesSection teamId={teamId} canEdit={canEdit} variant="advanced" /></div>}
    </details>
  </div>;
}
