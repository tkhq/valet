/**
 * One place, such as `#incidents` or `acme/api`
 * (docs/specs/2026-10-16-presence-hub-design.md Part C). The sections, in
 * order: the header (the service mark, the concrete name, and the service), **Valet here** with
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
import { errorText } from "~/lib/error-text";
import { announceCreated } from "./created-highlight";
import { LineEditor } from "./editor/line-editor";
import { PRESENCE_CRUMB, PresenceDetailPage } from "./page-shell";
import { PresenceLine } from "./presence-line";
import { appearanceName, hasAppearance, usePresenceSentenceParts } from "./presence-rows";
import { PlaceThreads } from "./place-threads";
import { isServiceRoot, SERVICE_NAMES } from "./places";
import { ServiceMark } from "./service-mark";
import { eventInWords, eventPlace, type ThreadTitles } from "./sentences";

export function PlacePage({ subject }: { subject: string }) {
  const detail = usePresencePlace(subject);
  const place = detail.data?.place;
  const subtitle = place === undefined ? undefined : SERVICE_NAMES[place.service];
  // The key is a system name (`slack:T1/C900`), so the title waits for the
  // place's concrete name.
  const title = place?.label ?? (detail.isError ? "Not available" : "Loading…");
  const mark = place === undefined ? undefined : <ServiceMark service={place.service} size="lg" />;
  return (
    <PresenceDetailPage crumbs={[PRESENCE_CRUMB, { label: title }]} title={title} mark={mark} subtitle={subtitle}>
      {detail.isPending && <LoadingRow />}
      {detail.isError && (
        <ErrorRow>{errorText(detail.error, "Could not load this place. Open Presence and pick the place again.")}</ErrorRow>
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
  const sentence = usePresenceSentenceParts(listeners, knownThreadTitles(threads));
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
      <LineEditor
        open={adding}
        onOpenChange={setAdding}
        onSaved={announceCreated}
        mode={{ kind: "create", preselected: { place: { subject: place.subject, service: place.service, label: place.label } } }}
      />

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
          <Link to="/presence/activity" search={{ place: place.subject }} className={textLinkClass}>View all</Link>
        )}
      >
        {activity.length === 0 && <EmptyRow className="px-4 py-3">Nothing happened here in the last 30 days.</EmptyRow>}
        {recent.map((event) => <ActivityRow key={event.id} event={event} placeLabel={place.label} serviceWide={isServiceRoot(place)} />)}
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

/**
 * One recent event: `<event in words> in <place>`. The place is this page's
 * label, not the event's refs, which can hold a raw channel id. An event in
 * a pull request on a repository's page names the pull request (`acme/api#12`).
 */
function ActivityRow({ event, placeLabel, serviceWide }: { event: EventSummaryWire; placeLabel: string; serviceWide: boolean }) {
  const inside = eventPlace(event.refs);
  // A Slack ref holds the channel id when it lacks the name, so a channel
  // page keeps its own label. A service-wide page names each event's own place.
  const place = serviceWide
    ? inside ?? placeLabel
    : inside !== null && inside.startsWith(`${placeLabel}#`) ? inside : placeLabel;
  return (
    <WorkRow
      title={(
        <Link to="/presence/events/$eventId" params={{ eventId: event.id }}>
          {eventInWords(event.eventKey)} in {place}
        </Link>
      )}
      time={event.occurredAt}
      detail={event.summary}
    />
  );
}
