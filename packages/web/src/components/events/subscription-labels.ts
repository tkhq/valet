import type { EventSubscriptionTargetWire, EventSubscriptionWire, EventSubscriptionThreadWire } from "@valet/api/wire";

/** Mirrors the server's `canMutateSubscription`: an org-owned subscription
 * is everyone's to manage, a team's belongs to its members, and a personal
 * one to its owner. */
export function canMutate(
  sub: EventSubscriptionWire,
  userId: string | undefined,
  memberTeamIds: ReadonlySet<string>,
): boolean {
  if (sub.ownerType === "org") return true;
  if (sub.ownerType === "team") return memberTeamIds.has(sub.ownerId);
  return sub.ownerId === userId;
}

export function describeTarget(
  target: EventSubscriptionTargetWire,
  workflowNames: Map<string, string>,
  teamNames: Map<string, string>,
): string {
  if (target.kind === "workflow") {
    return `Run workflow: ${workflowNames.get(target.workflowId) ?? target.workflowId}`;
  }
  if (target.orchestrator === "org") return "Notify the org assistant";
  if (target.orchestrator === "team") {
    const name = target.teamId !== undefined ? teamNames.get(target.teamId) : undefined;
    return name !== undefined ? `Notify ${name}'s assistant` : "Notify the team's assistant";
  }
  return "Notify your assistant";
}

/** What enabling `sub` does to the subscription it replaces. Undefined when
 * `sub` replaces nothing. The list holds every subscription of `sub`'s owner,
 * and a replacement names only one of those, so an ID the list lacks was
 * removed: the server refuses that enable, and the note says so. A version
 * that is already off is not turned off again. */
export function replacementNote(sub: EventSubscriptionWire, subscriptions: EventSubscriptionWire[]): string | undefined {
  const id = sub.target.kind === "orchestrator" ? sub.target.replaces : undefined;
  if (id === undefined) return undefined;
  const replaced = subscriptions.find((s) => s.id === id);
  if (!replaced) return "A subscription that was removed. Delete this proposal, then ask the assistant for a new one.";
  if (!replaced.enabled) return `${replaced.name}, which is already off.`;
  return `${replaced.name}. Enabling this subscription turns that one off.`;
}


export function describeThreadDestination(thread: EventSubscriptionThreadWire | null | undefined): string {
  if (thread?.mode === "new") return "New thread for each event";
  if (thread?.mode === "existing") return `Existing thread (${thread.threadId})`;
  return "Original conversation or event inbox";
}
