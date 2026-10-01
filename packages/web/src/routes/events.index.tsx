import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { TabBar, tabPanelId, pageClass } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";
import { EventLog, type LogFilter } from "~/components/events/event-log";
import { SubscriptionsPanel } from "~/components/events/subscriptions-panel";
import { ChannelsPanel } from "~/components/channels/channels-panel";
import { textParam } from "~/lib/search-params";

/** Channels, the Log (events and problems in one list), and subscriptions.
 * Legacy tab URLs (`activity`, `logs`, `problems`, `receipts`) open the Log. */
type TabId = "channels" | "log" | "subscriptions";

interface EventsSearch {
  tab?: TabId;
  review?: string;
  status?: LogFilter;
  q?: string;
}

/** Only non-default values are written to the URL. An absent or hand-edited
 * value reads as the default tab and the whole Log. */
export function readEventsSearch(raw: unknown): EventsSearch {
  const tabValue = textParam(raw, "tab");
  const tab = tabValue === "subscriptions" ? tabValue
    : ["log", "activity", "logs", "problems", "receipts"].includes(tabValue ?? "") ? "log" : undefined;
  const statusValue = tabValue === "receipts" ? "receipts" : tabValue === "problems" ? "problems" : textParam(raw, "status");
  const status = statusValue === "problems" || statusValue === "receipts" ? statusValue : undefined;
  // `problemsQ` is the old Event Logs search; it now searches the Log.
  const q = textParam(raw, "q") ?? textParam(raw, "problemsQ");
  const review = textParam(raw, "review");
  return { ...(review ? { review } : {}), ...(tab ? { tab } : {}), ...(status ? { status } : {}), ...(q ? { q } : {}) };
}

export const Route = createFileRoute("/events/")({
  component: EventsPage,
  validateSearch: readEventsSearch,
});

const TABS_LABEL = "Events sections";
const TABS = [
  { id: "channels", label: "Channels" },
  { id: "log", label: "Log" },
  { id: "subscriptions", label: "Subscriptions" },
] as const;

export function EventsPage() {
  // The top-level hooks, not `Route.useSearch()`: the route suite mocks
  // this module and never builds a real router context.
  const search = readEventsSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const [selectedTab, setTab] = useState<TabId>(search.tab ?? "channels");
  const tab = selectedTab;
  useEffect(() => setTab(search.tab ?? "channels"), [search.tab]);

  /** Writes the Log's filters to the URL, so Back and a shared link restore them. */
  function setLog(next: Partial<Pick<EventsSearch, "status" | "q">>) {
    const merged = { status: search.status, q: search.q, ...next };
    void navigate({
      to: "/events",
      search: {
        tab: "log" as const,
        ...(merged.status && merged.status !== "all" ? { status: merged.status } : {}),
        ...(merged.q ? { q: merged.q } : {}),
      },
    });
  }

  function selectTab(next: TabId) {
    setTab(next);
    void navigate({
      to: "/events",
      search: (previous) => {
        const { tab: _tab, ...rest } = readEventsSearch(previous);
        return next === "channels" ? rest : { ...rest, tab: next };
      },
    });
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className={pageClass}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-2xl text-ink">Events</h1>
          <WorkspaceClause />
        </div>
        <p className="mt-1 text-sm text-muted">
          What your connected integrations report, and what runs in response.
        </p>

        <div className="mt-6">
          <TabBar tabs={TABS} active={tab} onSelect={selectTab} label={TABS_LABEL} />
        </div>

        <div
          role="tabpanel"
          id={tabPanelId(TABS_LABEL, tab)}
          aria-labelledby={`${tabPanelId(TABS_LABEL, tab)}-tab`}
          className="mt-6"
        >
          {tab === "channels" && <ChannelsPanel />}
          {tab === "log" && (
            <EventLog
              filter={search.status ?? "all"}
              onFilterChange={(status) => setLog({ status })}
              query={search.q ?? ""}
              onQueryChange={(q) => setLog({ q })}
            />
          )}
          {tab === "subscriptions" && <SubscriptionsPanel reviewId={search.review} onReviewClose={() => void navigate({ to: "/events", search: { tab: "subscriptions" } })} />}
        </div>
      </div>
    </div>
  );
}
