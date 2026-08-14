import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { apiErrorMessage, useDeleteMyGrant, useMyGrants } from "~/api/policies";

/**
 * `/settings/policies` — "My active grants" (action-policies plan, Task 5).
 * Runtime grants scoped to a session or workflow execution (never both —
 * see `RuntimeGrantWire`); revoke is a soft-revoke keyed by scope +
 * `policyKey` (`service:actionId`), not by grant id, matching
 * `DeleteGrantRequest`'s target-addressing.
 */
export function GrantsSection() {
  const grantsQ = useMyGrants();
  const grants = grantsQ.data?.grants ?? [];
  const del = useDeleteMyGrant();
  const [rowError, setRowError] = useState<string | null>(null);

  return (
    <Section title="My active grants" description="Runtime grants for the current session or workflow run.">
      {grantsQ.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
      {!grantsQ.isLoading && grants.length === 0 && (
        <p className="py-4 text-sm text-muted">No active grants.</p>
      )}
      {grants.map((g) => {
        const [service, actionId] = splitPolicyKey(g.policyKey);
        return (
          <div key={g.id} className="flex items-center gap-3 py-3">
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-[--fg]">{g.policyKey}</span>
              <p className="text-xs text-muted">
                {g.sessionId ? `session ${g.sessionId}` : `workflow run ${g.workflowExecutionId}`}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Revoke grant ${g.policyKey}`}
              disabled={del.isPending}
              onClick={() => {
                setRowError(null);
                del.mutate(
                  {
                    sessionId: g.sessionId ?? undefined,
                    workflowExecutionId: g.workflowExecutionId ?? undefined,
                    service,
                    actionId,
                  },
                  { onError: (err) => setRowError(apiErrorMessage(err)) },
                );
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        );
      })}
      {rowError && <p className="pb-2 text-xs text-danger-500">{rowError}</p>}
    </Section>
  );
}

/** `policyKey` is `${service}.${actionId}` (see `grantPolicyKey` in
 *  `policies/resolution.ts`) — `actionId` itself may contain further dots
 *  (e.g. `gmail.send_email`), so split on the FIRST dot only, never the
 *  service name. */
function splitPolicyKey(policyKey: string): [string, string] {
  const idx = policyKey.indexOf(".");
  if (idx === -1) return [policyKey, ""];
  return [policyKey.slice(0, idx), policyKey.slice(idx + 1)];
}
