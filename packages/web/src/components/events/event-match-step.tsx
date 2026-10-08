import { ErrorRow, LoadingRow } from "~/components/primitives";
import { SLACK_APP_MENTION } from "~/lib/slack-mention";
import { FilterEditor, type FilterField, type UiFilterRow } from "./filter-editor";
import type { CatalogService } from "./subscription-match";

export function EventMatchStep({
  services,
  catalogLoading,
  catalogError,
  keys,
  onToggleKey,
  filterFields,
  filterRows,
  onFilterChange,
  singleEvent,
  anyChannel,
  onAnyChannelChange,
}: {
  services: CatalogService[];
  catalogLoading: boolean;
  catalogError: boolean;
  keys: Set<string>;
  onToggleKey: (key: string) => void;
  filterFields: FilterField[];
  filterRows: UiFilterRow[];
  onFilterChange: (rows: UiFilterRow[]) => void;
  singleEvent: boolean;
  anyChannel: boolean;
  onAnyChannelChange: (v: boolean) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">
          {singleEvent ? "Run this when this happens" : "Run this when any of these happens"}
        </p>
        {catalogLoading && <LoadingRow label="Loading catalog…" className="py-2 text-xs" />}
        {catalogError && (
          <ErrorRow className="py-2 text-xs">
            Could not load the event catalog. Retry, or check your integrations in Settings.
          </ErrorRow>
        )}
        {!catalogLoading && !catalogError && services.length === 0 && (
          <p className="py-2 text-xs text-muted">
            No plugin publishes events yet. Connect an integration with triggers first.
          </p>
        )}
        <div className="max-h-56 space-y-3 overflow-y-auto">
          {services.map((s) => (
            <div key={s.service}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
                {s.service.charAt(0).toUpperCase() + s.service.slice(1)}
              </p>
              <div className="space-y-0.5">
                {s.entries.map((entry) => (
                  <label
                    key={entry.key}
                    className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={keys.has(entry.key)}
                      onChange={() => onToggleKey(entry.key)}
                    />
                    <span className="min-w-0">
                      {/* Plain language first — what the person recognizes, not
                          the event key (how the system is built). */}
                      <span className="block text-sm text-ink">{entry.description}</span>
                      <span className="block break-all font-mono text-[11px] leading-tight text-muted">{entry.key}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {keys.size > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">Filters</p>
          <FilterEditor fields={filterFields} rows={filterRows} onChange={onFilterChange} />
          <p className="mt-1.5 text-xs text-muted">
            A rule matches only when every filter matches. Add none to match every selected event.
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
                  Personal rules accept your own mentions. Team assistant rules accept linked team members. A channel filter is required.
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

