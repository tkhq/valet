import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { TabBar } from "~/components/primitives";
import { EventFeed } from "~/components/events/feed";
import { SubscriptionsPanel } from "~/components/events/subscriptions-panel";

/**
 * `/events` — the first UI over the event system (feed, catalog,
 * subscriptions; see the events router in packages/api). Two tabs:
 *
 * - Activity: the org's ingested events, filterable by service/key, each
 *   expandable into its payload and delivery attempts.
 * - Subscriptions: the rules that turn a matching event into a workflow
 *   run or an orchestrator prompt.
 *
 * Local-state tabs, not child routes: the two panels share no params and
 * a deep link to a tab has no use yet. Promote to routes when one does.
 */
export const Route = createFileRoute("/events")({
  component: EventsPage,
});

const TABS = [
  { id: "activity", label: "Activity" },
  { id: "subscriptions", label: "Subscriptions" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function EventsPage() {
  const [tab, setTab] = useState<TabId>("activity");

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <h1 className="font-display text-2xl text-ink">Events</h1>
        <p className="mt-1 text-sm text-muted">
          What your connected integrations report, and what runs in response.
        </p>

        <div className="mt-6">
          <TabBar tabs={TABS} active={tab} onSelect={setTab} label="Events sections" />
        </div>

        <div className="mt-6">{tab === "activity" ? <EventFeed /> : <SubscriptionsPanel />}</div>
      </div>
    </div>
  );
}
