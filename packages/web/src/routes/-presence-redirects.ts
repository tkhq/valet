import { redirect } from "@tanstack/react-router";

/**
 * Every URL the Presence hub replaced, and where it goes now (spec Part A
 * steps 3 and 4, INV-H1). The old route files hold no page: each one's
 * `beforeLoad` throws `redirectToPresence(<its route>)`. The redirects stay
 * for at least one release, and this file is the one place that lists them.
 *
 * Revision 2 moved Workflows and Runs back out of Presence, to their own
 * `/workflows*` nav entry (spec Part A, Part G). `/presence/workflows*` and
 * `/presence/runs*` are now the legacy side, redirecting to `/workflows*`.
 * Revision 2 also moved one line of presence from `/presence/listeners/$id`
 * to `/presence/rules/$id`. Revision 3 removed the Routines pane: the
 * overview lists the routines, and one routine has its own page at
 * `/presence/routines/$id`.
 *
 * `/workflows` is a live page and a legacy route at once. Before revision 1,
 * its `?tab=scheduled` and `?tab=triggers` opened schedules and `?tab=runs`
 * opened runs. Those URLs redirect; every other `/workflows` URL matches no
 * row and serves the list.
 *
 * A row keeps every search param it does not consume, so `workspace`,
 * `review`, `q`, `gate`, and the rest arrive at the new URL unchanged.
 *
 * The file name starts with `-`, so the router does not publish it as a
 * route.
 */

/** A route the Presence hub replaced. */
export type LegacyRoute =
  | "/workflows"
  | "/events"
  | "/events/$eventId"
  | "/presence/workflows"
  | "/presence/workflows/$workflowId"
  | "/presence/runs"
  | "/presence/runs/$runId"
  | "/presence/listeners/$id"
  | "/presence/routines"
  | "/channel";

/** A route that receives a redirect from a legacy URL. */
export type PresencePath =
  | "/presence"
  | "/presence/places/$subject"
  | "/presence/rules/$id"
  | "/presence/routines/$id"
  | "/presence/activity"
  | "/presence/events/$eventId"
  | "/workflows"
  | "/workflows/$workflowId"
  | "/workflows/runs"
  | "/workflows/runs/$runId";

type Search = Record<string, unknown>;
type Params = Record<string, string>;

export interface PresenceTarget {
  to: PresencePath;
  params: Params;
  search: Search;
}

export interface PresenceRedirectRow {
  from: LegacyRoute;
  /** Which URLs of `from` this row takes, in words, for test names. */
  when: string;
  /** Absent means every URL of `from` that an earlier row did not take. A
   * `from` whose rows all have `matches` serves its own page for a URL that
   * no row takes. */
  matches?: (search: Search) => boolean;
  to: PresencePath;
  mapParams: (params: Params, search: Search) => Params;
  mapSearch: (search: Search) => Search;
  /** A URL this row takes. The table test resolves it and expects `to`. */
  example: { params: Params; search: Search };
}

/** The Events `tab` values that opened the Log. `activity`, `logs`,
 * `problems`, and `receipts` are older names the Events page still read. */
export const LEGACY_EVENTS_TABS = ["log", "activity", "logs", "problems", "receipts"] as const;

function text(search: Search, key: string): string | undefined {
  const value = search[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The search without the named keys. */
function without(search: Search, ...keys: string[]): Search {
  return Object.fromEntries(Object.entries(search).filter(([key]) => !keys.includes(key)));
}

function tabIs(...values: readonly string[]) {
  return (search: Search) => values.includes(text(search, "tab") ?? "");
}

const noParams = (): Params => ({});
const sameParams = (params: Params): Params => params;

/** The Log's filters as the Events page read them: `tab=problems` and
 * `tab=receipts` set the status and win over `status`; `status` keeps only
 * `problems`; the old `problemsQ` search fills an absent `q`. The old
 * `receipts` value opens the whole Log, because receipts now sit under
 * their own disclosure in Activity. */
function activitySearch(search: Search): Search {
  const tab = text(search, "tab");
  const statusValue = tab === "receipts" || tab === "problems" ? tab : text(search, "status");
  const status = statusValue === "problems" ? statusValue : undefined;
  const q = text(search, "q") ?? text(search, "problemsQ");
  return {
    ...without(search, "tab", "status", "q", "problemsQ"),
    ...(status ? { status } : {}),
    ...(q ? { q } : {}),
  };
}

const dropTab = (search: Search): Search => without(search, "tab");

/** The pre-revision-1 Workflows tabs: `scheduled` listed schedules and
 * `triggers` listed event rules. */
const SCHEDULE_TABS = ["scheduled", "triggers"] as const;

export const PRESENCE_REDIRECTS: readonly PresenceRedirectRow[] = [
  {
    from: "/workflows",
    when: "a Scheduled review link",
    matches: (search) => tabIs("scheduled")(search) && text(search, "review") !== undefined,
    to: "/presence/routines/$id",
    mapParams: (_params, search) => ({ id: text(search, "review") ?? "" }),
    mapSearch: (search) => without(search, "tab", "review"),
    example: { params: {}, search: { tab: "scheduled", review: "sched-1" } },
  },
  {
    // The Triggers tab listed event rules, not schedules, so its review id
    // names a rule.
    from: "/workflows",
    when: "a Triggers review link",
    matches: (search) => tabIs("triggers")(search) && text(search, "review") !== undefined,
    to: "/presence/rules/$id",
    mapParams: (_params, search) => ({ id: text(search, "review") ?? "" }),
    mapSearch: (search) => without(search, "tab", "review"),
    example: { params: {}, search: { tab: "triggers", review: "sub-1" } },
  },
  {
    from: "/workflows",
    when: "the Scheduled or Triggers tab",
    matches: tabIs(...SCHEDULE_TABS),
    to: "/presence",
    mapParams: noParams,
    mapSearch: (search) => without(search, "tab", "review"),
    example: { params: {}, search: { tab: "scheduled" } },
  },
  {
    from: "/workflows",
    when: "the Runs tab",
    matches: tabIs("runs"),
    to: "/workflows/runs",
    mapParams: noParams,
    mapSearch: dropTab,
    example: { params: {}, search: { tab: "runs" } },
  },
  {
    from: "/events",
    when: "the Log tab or a legacy Log tab value",
    matches: tabIs(...LEGACY_EVENTS_TABS),
    to: "/presence/activity",
    mapParams: noParams,
    mapSearch: activitySearch,
    example: { params: {}, search: { tab: "receipts", status: "problems" } },
  },
  {
    from: "/events",
    when: "a Subscriptions review link",
    matches: (search) => tabIs("subscriptions")(search) && text(search, "review") !== undefined,
    to: "/presence/rules/$id",
    mapParams: (_params, search) => ({ id: text(search, "review") ?? "" }),
    mapSearch: dropTab,
    example: { params: {}, search: { tab: "subscriptions", review: "sub-1" } },
  },
  {
    from: "/events",
    when: "Channels, Subscriptions, or no tab",
    to: "/presence",
    mapParams: noParams,
    mapSearch: dropTab,
    example: { params: {}, search: {} },
  },
  {
    from: "/events/$eventId",
    when: "one event",
    to: "/presence/events/$eventId",
    mapParams: sameParams,
    mapSearch: (search) => search,
    example: { params: { eventId: "ev-1" }, search: {} },
  },
  {
    from: "/presence/workflows",
    when: "the workflow list",
    to: "/workflows",
    mapParams: sameParams,
    mapSearch: (search) => search,
    example: { params: {}, search: {} },
  },
  {
    from: "/presence/workflows/$workflowId",
    when: "one workflow",
    to: "/workflows/$workflowId",
    mapParams: sameParams,
    mapSearch: (search) => search,
    example: { params: { workflowId: "wf-1" }, search: {} },
  },
  {
    from: "/presence/runs",
    when: "every run",
    to: "/workflows/runs",
    mapParams: sameParams,
    mapSearch: (search) => search,
    example: { params: {}, search: {} },
  },
  {
    from: "/presence/runs/$runId",
    when: "one run",
    to: "/workflows/runs/$runId",
    mapParams: sameParams,
    mapSearch: (search) => search,
    example: { params: { runId: "run-1" }, search: {} },
  },
  {
    from: "/presence/listeners/$id",
    when: "one line of presence",
    to: "/presence/rules/$id",
    mapParams: sameParams,
    mapSearch: (search) => search,
    example: { params: { id: "sub-1" }, search: {} },
  },
  {
    from: "/presence/routines",
    when: "one routine",
    matches: (search) => text(search, "routine") !== undefined,
    to: "/presence/routines/$id",
    mapParams: (_params, search) => ({ id: text(search, "routine") ?? "" }),
    mapSearch: (search) => without(search, "routine"),
    example: { params: {}, search: { routine: "sched-1" } },
  },
  {
    from: "/presence/routines",
    when: "the Routines pane",
    to: "/presence",
    mapParams: noParams,
    mapSearch: (search) => without(search, "routine"),
    example: { params: {}, search: {} },
  },
  {
    from: "/channel",
    when: "a channel key",
    matches: (search) => text(search, "key") !== undefined,
    to: "/presence/places/$subject",
    mapParams: (_params, search) => ({ subject: text(search, "key") ?? "" }),
    mapSearch: (search) => without(search, "key"),
    example: { params: {}, search: { key: "slack:C123" } },
  },
  {
    from: "/channel",
    when: "no channel key",
    to: "/presence",
    mapParams: noParams,
    mapSearch: (search) => without(search, "key"),
    example: { params: {}, search: {} },
  },
];

/** A raw search that is not a plain object reads as empty. */
function readSearch(raw: unknown): Search {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw));
}

/**
 * Where an old URL goes now: the first row of `from` that takes it, or
 * `undefined` when no row takes it. Only a `from` whose rows all have
 * `matches` (`/workflows`) returns `undefined`; that URL serves its page.
 */
export function presenceRedirectFor(from: LegacyRoute, params: Params, rawSearch: unknown): PresenceTarget | undefined {
  const search = readSearch(rawSearch);
  const row = PRESENCE_REDIRECTS.find((candidate) => candidate.from === from && (candidate.matches?.(search) ?? true));
  if (!row) return undefined;
  return { to: row.to, params: row.mapParams(params, search), search: row.mapSearch(search) };
}

/** A `beforeLoad` for an old route: it throws the redirect to the new URL,
 * and returns without a redirect when no row takes the URL. It reads
 * `location.search`, the search as the URL carried it, because a route's
 * `validateSearch` drops the keys it does not know. Exported standalone so a
 * test can call it without a router. */
export function redirectToPresence(from: LegacyRoute) {
  return ({ params, location }: { params: Params; location: { search: unknown } }): void => {
    const target = presenceRedirectFor(from, params, location.search);
    if (target === undefined) return;
    throw redirect({ to: target.to, params: target.params, search: target.search, replace: true });
  };
}
