import { useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { TabBar, tabPanelId } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";
import { EventFeed, type FeedScope } from "~/components/events/feed";
import { SubscriptionsPanel } from "~/components/events/subscriptions-panel";
import { textParam } from "~/lib/search-params";

/**
 * `/events` — the UI over the event system (feed, catalog, subscriptions;
 * see the events router in packages/api). Two tabs:
 *
 * - Activity: ingested events, filterable by service/key, each expandable
 *   into its payload and delivery attempts. The scope control starts at the
 *   active workspace's events and opens to the whole org on request.
 * - Subscriptions: the rules that turn a matching event into a workflow
 *   run or an orchestrator prompt, listed for the active workspace.
 *
 * Local-state tabs, not child routes: the two panels share no params and
 * a deep link to a tab has no use yet. Promote to routes when one does. One
 * event DOES have its own URL — `/events/$eventId` — because an event that
 * broke a run has to be paste-able into a ticket.
 *
 * The feed's scope is NOT local state: the two tabs unmount each other, and
 * a diagnosis crosses them. It lives in `?scope=`, the same way the
 * workflows hub keeps `?tab=`.
 */
interface EventsSearch {
  scope?: FeedScope;
}

/** Only "all" is written to the URL. An absent or hand-edited value reads
 * as the default workspace scope. */
function readEventsSearch(raw: unknown): EventsSearch {
  return textParam(raw, "scope") === "all" ? { scope: "all" } : {};
}

export const Route = createFileRoute("/events/")({
  component: EventsPage,
  validateSearch: readEventsSearch,
});

const TABS_LABEL = "Events sections";
const TABS = [
  { id: "activity", label: "Activity" },
  { id: "subscriptions", label: "Subscriptions" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function EventsPage() {
  const [tab, setTab] = useState<TabId>("activity");
  // The top-level hooks, not `Route.useSearch()`: the route suite mocks
  // this module and never builds a real router context.
  const search = readEventsSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const scope: FeedScope = search.scope ?? "workspace";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-2xl text-ink">Events</h1>
          <WorkspaceClause />
        </div>
        <p className="mt-1 text-sm text-muted">
          What your connected integrations report, and what runs in response.
        </p>

        <div className="mt-6">
          <TabBar tabs={TABS} active={tab} onSelect={setTab} label={TABS_LABEL} />
        </div>

        <div
          role="tabpanel"
          id={tabPanelId(TABS_LABEL, tab)}
          aria-labelledby={`${tabPanelId(TABS_LABEL, tab)}-tab`}
          className="mt-6"
        >
          {tab === "activity" ? (
            <EventFeed
              scope={scope}
              onScopeChange={(next) =>
                void navigate({ to: "/events", search: next === "all" ? { scope: "all" } : {} })
              }
            />
          ) : (
            <SubscriptionsPanel />
          )}
        </div>
      </div>
    </div>
  );
}
