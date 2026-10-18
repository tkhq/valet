/**
 * Shared fixtures for the Presence component tests. Test files only import
 * this module; the app never does.
 */
import type { EventSubscriptionWire, ThreadSummary } from "@valet/api/wire";

/** The viewer in the tests: a member who owns the `u-001` lines. */
export const ME_MEMBER = { id: "u-001", orgId: "acme", orgRole: "member" } as const;

/**
 * The `~/api/settings` mock for a member with no team. Use it from a
 * hoisted factory:
 * `vi.mock("~/api/settings", async () => (await import("./test-fixtures")).memberSettings)`.
 */
export const memberSettings = {
  useMe: () => ({ data: ME_MEMBER }),
  useTeams: () => ({ data: { teams: [] } }),
};

/** A line of presence owned by `u-001`, with `over` on top. */
export function line(id: string, over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id, name: id, ownerType: "user", ownerId: "u-001", eventKeys: [], filters: [],
    target: { kind: "assistant" }, enabled: true, createdBy: "u-001", createdAt: 1, updatedAt: 1, ...over,
  };
}

/** The archived thread that the faulted lines pin. */
export const PLATFORM_CI: ThreadSummary = {
  id: "t-ci", sessionId: "s-u", title: "Platform CI", createdAt: 1, lastUserActivityAt: 1, archivedAt: 2,
};

/** The open thread a pick moves a line to. */
export const PLATFORM_OPS: ThreadSummary = {
  id: "t-ops", sessionId: "s-u", title: "Platform Ops", createdAt: 1, lastUserActivityAt: 1,
};
