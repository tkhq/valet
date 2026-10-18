/**
 * One place, such as `#incidents` or `acme/api`
 * (docs/specs/2026-10-16-presence-hub-design.md Part C). The sections, in
 * order: the header (the concrete name and the service), **Valet here** with
 * **Listen for…**, **Threads**, **Appears as** when a line here sets one,
 * and **Recent activity**.
 */
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { EventSubscriptionWire, EventSummaryWire, PresencePlaceDetailResponse } from "@valet/api/wire";
import { usePresencePlace } from "~/api/presence";
import {
  Avatar, AvatarFallback, AvatarImage, Button, EmptyRow, ErrorRow, LoadingRow, WorkRow, WorkSection, textLinkClass,
} from "~/components/primitives";
import { AutomationWizard } from "~/components/events/automation-wizard";
import { errorText } from "~/lib/error-text";
import { PresenceDetailPage } from "./page-shell";
import { PresenceLine } from "./presence-line";
import { appearanceName, hasAppearance, usePresenceSentence } from "./presence-rows";
import { PlaceThreads } from "./place-threads";
import { placeSearchTerm, SERVICE_NAMES } from "./places";
import { eventInWords, eventPlace, type ThreadTitles } from "./sentences";

export function PlacePage({ subject }: { subject: string }) {
  const detail = usePresencePlace(subject);
  const place = detail.data?.place;
  const subtitle = place === undefined ? undefined : SERVICE_NAMES[place.service];
  // The key is a system name (`slack:T1/C900`), so the title waits for the
  // place's concrete name.
  const title = place?.label ?? (detail.isError ? "Not available" : "Loading…");
  return (
    <PresenceDetailPage crumbs={[{ label: "Presence", to: "/presence" }, { label: title }]} title={title} subtitle={subtitle}>
      {detail.isPending && <LoadingRow />}
      {detail.isError && (
        <ErrorRow>{errorText(detail.error, "Could not load this place. Pick it from the rail again.")}</ErrorRow>
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

/** Recent activity shows this many rows; View all opens the rest (Part C step 7). */
const RECENT_ROWS = 10;

export function PlaceBody({ data }: { data: PresencePlaceDetailResponse }) {
  const { place, listeners, threads, activity } = data;
  const [adding, setAdding] = useState(false);
  const sentence = usePresenceSentence(listeners, knownThreadTitles(threads));
  const appearances = listeners.filter(hasAppearance);
  const recent = activity.slice(0, RECENT_ROWS);
  return (
    <div className="space-y-8">
      <WorkSection
        title="Valet here"
        count={listeners.length}
        actions={(
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus aria-hidden className="h-3.5 w-3.5" />
            Listen for…
          </Button>
        )}
      >
        {listeners.length === 0 && <EmptyRow className="px-4 py-3">Nothing is set up here yet.</EmptyRow>}
        {listeners.length > 0 && (
          <div className="grid gap-0.5 px-4 py-2">
            {listeners.map((sub) => <PresenceLine key={sub.id} sub={sub} sentence={sentence(sub)} />)}
          </div>
        )}
      </WorkSection>
      {adding && (
        <AutomationWizard
          open
          onOpenChange={setAdding}
          preselectedPlace={{ subject: place.subject, service: place.service, label: place.label }}
        />
      )}

      <PlaceThreads threads={threads} service={place.service} label={place.label} />

      {appearances.length > 0 && (
        <WorkSection title="Appears as" count={appearances.length}>
          {appearances.map((sub) => <AppearanceRow key={sub.id} sub={sub} />)}
        </WorkSection>
      )}

      <WorkSection
        title="Recent activity"
        count={recent.length}
        actions={activity.length > 0 && (
          <Link to="/presence/activity" search={{ q: placeSearchTerm(place) }} className={textLinkClass}>View all</Link>
        )}
      >
        {activity.length === 0 && <EmptyRow className="px-4 py-3">Nothing happened here in the last 30 days.</EmptyRow>}
        {recent.map((event) => <ActivityRow key={event.id} event={event} placeLabel={place.label} />)}
      </WorkSection>
    </div>
  );
}

function AppearanceRow({ sub }: { sub: EventSubscriptionWire }) {
  const appearance = sub.target.appearance ?? {};
  const name = appearanceName(sub);
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
      detail={<>Set by <Link to="/presence/rules/$id" params={{ id: sub.id }} className="hover:underline">{sub.name}</Link></>}
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
