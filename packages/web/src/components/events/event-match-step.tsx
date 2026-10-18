import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ErrorRow, LoadingRow } from "~/components/primitives";
import { ServiceMark, SERVICE_NAMES } from "~/components/presence/service-mark";
import { COMMON_EVENTS, eventLabel, type SentenceService } from "~/components/presence/sentences";
import { SLACK_APP_MENTION } from "~/lib/slack-mention";
import { FilterEditor, type FilterField, type UiFilterRow } from "./filter-editor";
import type { CatalogService } from "./subscription-match";

function knownService(service: string): SentenceService | undefined {
  return service === "slack" || service === "github" || service === "linear" ? service : undefined;
}

/** A service's name as the reader knows it: `GitHub`, not `GITHUB` or `github`. */
export function serviceName(service: string): string {
  const known = knownService(service);
  return known !== undefined ? SERVICE_NAMES[known] : service.charAt(0).toUpperCase() + service.slice(1);
}

type Entry = CatalogService["entries"][number];

/** A service's events split into the common ones, in their set order, and the rest. */
function splitCommon(service: CatalogService): { common: Entry[]; more: Entry[] } {
  const known = knownService(service.service);
  const order = known !== undefined ? COMMON_EVENTS[known] : [];
  const common = order.flatMap((key) => service.entries.filter((e) => e.key === key));
  if (common.length === 0) return { common: service.entries, more: [] };
  return { common, more: service.entries.filter((e) => !order.includes(e.key)) };
}

function EventOption({ entry, services, checked, showKey, onToggle }: {
  entry: Entry;
  services: CatalogService[];
  checked: boolean;
  showKey: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover sm:min-h-0">
      <input type="checkbox" className="mt-0.5" checked={checked} onChange={onToggle} />
      <span className="min-w-0">
        {/* Plain language: what the person recognizes. The raw key shows
            only in the advanced flow, for a reader who asked for it. */}
        <span className="block text-sm text-ink">{eventLabel(entry.key, services)}</span>
        {showKey && <span className="block break-all font-mono text-[11px] leading-tight text-muted">{entry.key}</span>}
      </span>
    </label>
  );
}

/** The rest of a service's events, behind a disclosure. It opens at mount when one of them is picked. */
function MoreEvents({ entries, initiallyOpen, children }: { entries: Entry[]; initiallyOpen: boolean; children: ReactNode }) {
  // The reader owns the disclosure after mount; a later pick does not move it.
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="mt-1">
      <summary className="cursor-pointer px-2 py-1 text-xs text-muted hover:text-ink">More events ({entries.length})</summary>
      <div className="space-y-0.5">{children}</div>
    </details>
  );
}

export function EventMatchStep({
  services,
  catalogLoading,
  catalogError,
  keys,
  onToggleKey,
  filterFields,
  filterRows,
  onFilterChange,
  anyChannel,
  onAnyChannelChange,
  showKeys = false,
  isConnected,
}: {
  services: CatalogService[];
  catalogLoading: boolean;
  catalogError: boolean;
  keys: Set<string>;
  onToggleKey: (key: string) => void;
  filterFields: FilterField[];
  filterRows: UiFilterRow[];
  onFilterChange: (rows: UiFilterRow[]) => void;
  anyChannel: boolean;
  onAnyChannelChange: (v: boolean) => void;
  /** Shows each event's raw key, for the advanced flow. */
  showKeys?: boolean;
  /** False for a service that is not connected: its group says so and links to Integrations. Absent means unknown. */
  isConnected?: (service: string) => boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-sm font-medium text-ink">Which events?</p>
        {catalogLoading && <LoadingRow label="Loading events…" className="py-2 text-xs" />}
        {catalogError && (
          <ErrorRow className="py-2 text-xs">
            Could not load the events. Retry, or check your integrations in Settings.
          </ErrorRow>
        )}
        {!catalogLoading && !catalogError && services.length === 0 && (
          <p className="py-2 text-xs text-muted">
            No plugin publishes events yet. Connect an integration that sends events first.
          </p>
        )}
        <div className="max-h-72 space-y-3 overflow-y-auto">
          {services.map((s) => {
            const { common, more } = splitCommon(s);
            const known = knownService(s.service);
            const name = serviceName(s.service);
            const option = (entry: Entry) => (
              <EventOption
                key={entry.key}
                entry={entry}
                services={services}
                checked={keys.has(entry.key)}
                showKey={showKeys}
                onToggle={() => onToggleKey(entry.key)}
              />
            );
            return (
              <section key={s.service} aria-label={name}>
                <h3 className="mb-1 flex items-center gap-2 text-sm font-medium text-ink">
                  {known !== undefined && <ServiceMark service={known} size="sm" />}
                  {name}
                </h3>
                {isConnected !== undefined && !isConnected(s.service) && (
                  <p className="mb-1 px-2 text-xs text-muted">
                    Connect {name} to receive these events.{" "}
                    <Link to="/integrations" className="text-ink underline">Open Integrations</Link>
                  </p>
                )}
                <div className="space-y-0.5">{common.map(option)}</div>
                {more.length > 0 && (
                  <MoreEvents entries={more} initiallyOpen={more.some((e) => keys.has(e.key))}>{more.map(option)}</MoreEvents>
                )}
              </section>
            );
          })}
        </div>
      </div>

      {keys.size > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Filters</p>
          <FilterEditor fields={filterFields} rows={filterRows} onChange={onFilterChange} />
          <p className="mt-1.5 text-xs text-muted">
            Valet acts only when every filter matches. Add none to match every selected event.
          </p>
          {/* A `slack.app_mention` rule is scoped to the creator's own
              mentions and needs a channel filter, unless this explicit
              opt-out is set — the same rule the server enforces. */}
          {keys.has(SLACK_APP_MENTION) && (
            <label className="mt-2 flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={anyChannel}
                onChange={(e) => onAnyChannelChange(e.target.checked)}
              />
              <span>
                Any channel
                <span className="block text-xs text-muted">
                  In your personal workspace, only your own mentions count. For a team assistant, mentions by linked team members count. A channel filter is required.
                  Check this to listen in every channel the app can see instead.
                </span>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

