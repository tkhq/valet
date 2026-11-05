/**
 * Shared fixtures for the Presence component tests. Test files only import
 * this module; the app never does.
 */
import type { EventSubscriptionWire, PresencePlaceWire, ThreadSummary } from "@valet/api/wire";
import type { Routine } from "./routine-helpers";

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
  useOrgDirectory: () => ({ data: { users: [] } }),
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

/** A place with one line, no active thread, and no activity, with `over` on top. */
export function place(
  subject: string,
  label: string,
  service: PresencePlaceWire["service"],
  parent: string | null = null,
  over: Partial<PresencePlaceWire> = {},
): PresencePlaceWire {
  return { subject, label, service, parent, listenerCount: 1, activeThreadCount: 0, lastActivityAt: null, ...over };
}

/** A routine owned by `u-001`: `Morning summary`, every day at 9:00 UTC, due in an hour. `detail` merges into the default detail. */
export function routine(
  id: string,
  over: Partial<Omit<Routine, "kind" | "detail">> & { detail?: Partial<Routine["detail"]> } = {},
): Routine {
  const { detail, ...rest } = over;
  return {
    kind: "schedule",
    id,
    name: "Morning summary",
    enabled: true,
    ...rest,
    detail: {
      cron: "0 9 * * *",
      timezone: "UTC",
      targetKind: "assistant",
      prompt: "Summarize",
      nextFireAt: Date.now() + 3_600_000,
      lastFiredAt: null, lastFiredThread: null,
      ownerType: "user",
      ownerId: "u-001",
      ...detail,
    },
  };
}

/**
 * A node's text as the reader sees it on screen. A token with glued
 * punctuation also holds a visually hidden copy for screen readers
 * (`Ref`'s `readAs`), which `textContent` would read twice.
 */
export function visibleText(node: Node | null | undefined): string {
  if (node === null || node === undefined) return "";
  const copy = node.cloneNode(true);
  if (copy instanceof Element) for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
  return copy.textContent ?? "";
}
