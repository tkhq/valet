import { createHash } from "node:crypto";

/** Stable owner-scoped IDs let the existing primary key serialize retries. */
/** A retry with the same key finds the same proposal. `target` names what the
 * proposal arms, such as a workflow id, so two workflows can reuse one key. */
export function proposalId(kind: string, orgId: string, ownerType: string, ownerId: string, key: string, target?: string): string {
  return `proposal-${createHash("sha256").update(JSON.stringify([kind, orgId, ownerType, ownerId, key, ...(target ? [target] : [])])).digest("hex")}`;
}

export function proposalResult(kind: "subscription" | "schedule", id: string, enabled: boolean, config: unknown) {
  return {
    proposal: {
      kind, id, enabled, config,
      reviewUrl: kind === "subscription"
        ? `/events?tab=subscriptions&review=${encodeURIComponent(id)}`
        : `/workflows?tab=scheduled&review=${encodeURIComponent(id)}`,
    },
  };
}
