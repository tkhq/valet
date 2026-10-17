/**
 * One place, such as `#incidents` or `acme/api`
 * (docs/specs/2026-10-16-presence-hub-design.md Part B step 3). The sections,
 * in order: the header (the concrete name and the service), **Listeners**
 * with **Add**, **Appears as** when a listener here sets one, **Threads**,
 * and **Recent activity**.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { EventSubscriptionWire, EventSummaryWire, PresencePlaceDetailResponse } from "@valet/api/wire";
import { usePresencePlace } from "~/api/presence";
import {
  Avatar, AvatarFallback, AvatarImage, Button, EmptyRow, ErrorRow, LoadingRow, WorkRow, WorkSection,
} from "~/components/primitives";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { errorText } from "~/lib/error-text";
import { PresenceDetailPage } from "./page-shell";
import { ListenerRow, useListenerSentence } from "./listener-rows";
import { PlaceThreads } from "./place-threads";
import { SERVICE_NAMES } from "./places-tab";
import { eventInWords, eventPlace, type ThreadTitles } from "./sentences";

export function PlacePage({ subject }: { subject: string }) {
  const detail = usePresencePlace(subject);
  const place = detail.data?.place;
  const subtitle = place === undefined
    ? undefined
    : [SERVICE_NAMES[place.service], place.listenerCount > 0 ? place.scopeLabel : undefined].filter(Boolean).join(" · ");
  return (
    <PresenceDetailPage back="/presence" backLabel="Places" title={place?.label ?? subject} subtitle={subtitle}>
      {detail.isPending && <LoadingRow />}
      {detail.isError && (
        <ErrorRow>{errorText(detail.error, "Could not load this page. Open Places and select it again.")}</ErrorRow>
      )}
      {detail.data && <PlaceBody data={detail.data} />}
    </PresenceDetailPage>
  );
}

/** Thread titles the page already has, so a pinned thread here reads by name. */
function knownThreadTitles(threads: PresencePlaceDetailResponse["threads"]): ThreadTitles {
  const titles: Record<string, { title: string }> = {};
  for (const thread of [...threads.subject, ...threads.following, ...threads.active]) {
    titles[thread.threadId] = { title: thread.title };
  }
  return titles;
}

export function PlaceBody({ data }: { data: PresencePlaceDetailResponse }) {
  const { place, listeners, threads, activity } = data;
  const [adding, setAdding] = useState(false);
  const sentence = useListenerSentence(listeners, knownThreadTitles(threads));
  const appearances = listeners.filter(hasAppearance);
  return (
    <div className="space-y-8">
      <WorkSection
        title="Listeners"
        count={listeners.length}
        actions={(
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)} aria-label={`Add a listener in ${place.label}`}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            Add
          </Button>
        )}
      >
        {listeners.length === 0 && <EmptyRow className="px-4 py-3">No listener here yet. Select Add to create one.</EmptyRow>}
        {listeners.map((sub) => <ListenerRow key={sub.id} sub={sub} sentence={sentence(sub)} />)}
      </WorkSection>
      {adding && (
        <AutomationWizard
          open
          onOpenChange={setAdding}
          preselectedPlace={{ subject: place.subject, service: place.service, label: place.label }}
        />
      )}

      {appearances.length > 0 && (
        <WorkSection title="Appears as" count={appearances.length}>
          {appearances.map((sub) => <AppearanceRow key={sub.id} sub={sub} />)}
        </WorkSection>
      )}

      <PlaceThreads threads={threads} service={place.service} label={place.label} />

      <WorkSection title="Recent activity" count={activity.length}>
        {activity.length === 0 && <EmptyRow className="px-4 py-3">Nothing happened here in the last 30 days.</EmptyRow>}
        {activity.map((event) => <ActivityRow key={event.id} event={event} placeLabel={place.label} />)}
      </WorkSection>
    </div>
  );
}

function hasAppearance(sub: EventSubscriptionWire): boolean {
  const appearance = sub.target.appearance;
  return Boolean(appearance?.displayName?.trim() || appearance?.avatarUrl?.trim());
}

function AppearanceRow({ sub }: { sub: EventSubscriptionWire }) {
  const appearance = sub.target.appearance ?? {};
  const name = appearance.displayName?.trim() || "Valet";
  return (
    <WorkRow
      title={(
        <span className="inline-flex items-center gap-2">
          <Avatar size="sm">
            {appearance.avatarUrl && <AvatarImage src={appearance.avatarUrl} alt="" />}
            <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
          {name}
        </span>
      )}
      detail={<>Set by <Link to="/presence/listeners/$id" params={{ id: sub.id }} className="hover:underline">{sub.name}</Link></>}
    />
  );
}

function ActivityRow({ event, placeLabel }: { event: EventSummaryWire; placeLabel: string }) {
  return (
    <WorkRow
      title={(
        <Link to="/presence/events/$eventId" params={{ eventId: event.id }}>
          {eventInWords(event.eventKey)} in {eventPlace(event.refs) ?? placeLabel}
        </Link>
      )}
      time={event.occurredAt}
      detail={event.summary}
    />
  );
}
