/**
 * A line's conditions as form rows: the field catalog, the helpers that
 * turn rows into the `{field, op, value}` shape the server's
 * `validateSubscription` reads and back, and the provider-populated value
 * picker. The editor's When section uses all three.
 *
 * A row's `value` is held as the raw text the user typed. The list
 * operators (`in`, `not_in`) split it into a list at submit
 * (`toWireFilters`), so the form never needs a separate list widget.
 */
import { useMemo, useState } from "react";
import type { EventSubscriptionFilterWire } from "@valet/api/wire";
import { useFilterOptions } from "~/api/events";
import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { Input } from "~/components/primitives";

/** What a SUCCESSFUL but empty channel picker means, and the one action that
 * fixes it. Only show it when the lookup answered. A failed lookup also leaves
 * the list empty, and telling somebody to invite the app would be a confident
 * wrong diagnosis for an outage.
 *
 * The picker lists the channels the Valet Slack app has JOINED, public and
 * private alike. That is the right set: Slack delivers a message or a mention
 * event only for a channel the app is in, so a rule naming any other channel
 * could never fire. But an empty result read as "private channels are not
 * supported", because nothing said otherwise, and people asked whether a team
 * assistant could work in one at all. It can. Somebody has to invite the app
 * to that channel first. */
export const NO_CHANNEL_MATCH_HELP =
  "No matches. This lists channels the Valet app has joined. To use a private channel, invite the app to it in Slack first.";

export type FilterOp = EventSubscriptionFilterWire["op"];

const FILTER_OPS: readonly FilterOp[] = ["eq", "in", "prefix", "contains", "regex", "not_in", "not_prefix", "not_regex"];

/** True for an op whose value is a list: `in` and `not_in`. */
export function isListOp(op: FilterOp): op is "in" | "not_in" {
  return op === "in" || op === "not_in";
}

export interface UiFilterRow {
  /** A stable, view-only row identity. Each row holds picker state (query,
   * debounce), so React must key the row by this, not by array index. An
   * index key hands one row's state to another when a row is removed or the
   * list reorders. Never sent on the wire. */
  id: string;
  field: string;
  op: FilterOp;
  value: string;
  /** Display name for a picker value (a resolved id → "Alice"). Persisted on
   * the wire filter, ignored by matching, shown as the selected label. */
  label?: string;
  /** A stored list filter's display labels, aligned with its original value
   * list, plus the field they were stored under. Reattached on submit only
   * while the edited row still matches both — an edited list or a switched
   * field drops them rather than mislabel a value. */
  inLabels?: { field: string; values: string[]; labels: string[] };
}

/** Mint a stable row id. `crypto.randomUUID` is present in every browser this
 * app targets and in the jsdom test runtime. */
function newRowId(): string {
  return crypto.randomUUID();
}

/** One filterable field the selected event declares. `description` is a hint. */
export interface FilterField {
  field: string;
  description?: string;
  /** When set, the value is picked from a provider-populated list, not typed.
   * `dependsOn` names sibling fields whose values scope the list. */
  options?: { source: string; dependsOn?: string[] };
}

/** Plain-language names for the fields a person recognizes, in place of the raw
 * catalog field key. Unknown fields fall back to a title-cased key. */
const FIELD_LABELS: Record<string, string> = {
  channel: "Channel",
  user: "User",
  text: "Message text",
  channel_type: "Conversation type",
  bot_id: "Bot",
  app_id: "App",
  reaction: "Reaction",
  item_user: "Message author",
  creator: "Creator",
  repo: "Repository",
  base_branch: "Base branch",
  head_branch: "Head branch",
  team: "Team",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Convert form rows to the wire shape. A row with no field or no value is
 * dropped, because a half-filled row is not a filter and would 400. A list
 * operator (`in`, `not_in`) splits its value on commas into a list.
 */
export function toWireFilters(rows: UiFilterRow[]): EventSubscriptionFilterWire[] {
  const out: EventSubscriptionFilterWire[] = [];
  for (const row of rows) {
    if (!row.field) continue;
    if (isListOp(row.op)) {
      const values = row.value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (values.length === 0) continue;
      const orig = row.inLabels;
      if (
        orig !== undefined &&
        orig.field === row.field &&
        orig.values.length === values.length &&
        orig.values.every((v, i) => v === values[i])
      ) {
        out.push({ field: row.field, op: row.op, value: values, labels: orig.labels });
      } else {
        out.push({ field: row.field, op: row.op, value: values });
      }
    } else {
      const value = row.value.trim();
      if (value.length === 0) continue;
      // The label is a display name for a single picked value. A list
      // operator is multi-value, so it carries no single label.
      const label = row.label?.trim();
      out.push(label ? { field: row.field, op: row.op, value, label } : { field: row.field, op: row.op, value });
    }
  }
  return out;
}

/**
 * Rebuild form rows from stored filters when editing. Tolerant of the
 * `unknown[]` the wire hands back: a list rejoins with ", " so the one
 * value input round-trips. An op this form does not know reads as `eq`.
 */
export function fromWireFilters(filters: unknown[]): UiFilterRow[] {
  const rows: UiFilterRow[] = [];
  for (const f of filters) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    const field = typeof r.field === "string" ? r.field : "";
    const op = FILTER_OPS.find((known) => known === r.op) ?? "eq";
    const value = Array.isArray(r.value)
      ? r.value.filter((v): v is string => typeof v === "string").join(", ")
      : typeof r.value === "string"
        ? r.value
        : "";
    const label = typeof r.label === "string" ? r.label : undefined;
    const id = newRowId();
    const row: UiFilterRow = { id, field, op, value };
    if (label !== undefined) row.label = label;
    // Keep a list filter's aligned display labels so an untouched list
    // round-trips them (see `UiFilterRow.inLabels`).
    if (isListOp(op) && Array.isArray(r.value) && Array.isArray(r.labels)) {
      const values = r.value.filter((v): v is string => typeof v === "string");
      const labels = r.labels.filter((v): v is string => typeof v === "string");
      if (labels.length === values.length && labels.length === r.labels.length) {
        row.inLabels = { field, values, labels };
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Whether two filter lists are the same rule, compared through the form
 * round trip (`fromWireFilters` → `toWireFilters`). Raw comparison lies in
 * both directions: stored jsonb reorders keys (by length, then bytewise),
 * and corners the form cannot represent (comma-bearing `in` values,
 * misaligned label arrays) would make an untouched list look edited —
 * turning a rename into a filters rewrite. One canonical form on both sides
 * also means no hand-maintained field list to drift from the wire type.
 */
export function sameWireFilters(a: unknown[], b: unknown[]): boolean {
  const canon = (fs: unknown[]) => JSON.stringify(toWireFilters(fromWireFilters(fs)));
  return canon(a) === canon(b);
}

/**
 * Drop rows whose field the selected event(s) no longer declare. Called when
 * the event selection changes, so a filter left over from a previous event
 * cannot reach the server and 400. A row with no field yet is kept.
 */
export function pruneFilterRows(rows: UiFilterRow[], fields: FilterField[]): UiFilterRow[] {
  return rows.filter((r) => !r.field || fields.some((f) => f.field === r.field));
}

/**
 * A searchable, provider-populated value cell. It queries `useFilterOptions`
 * for the field's `source`, shows each option's label (and hint), and stores
 * the picked id plus its label on the row. It falls back to a free-text input
 * when the source cannot resolve, so a rule stays creatable.
 *
 * `dependsOn` fields scope the list. Until every dependsOn value is present in
 * `deps`, the picker is disabled and names the field to fill first.
 */
export function FilterValuePicker({
  source,
  dependsOn,
  deps,
  value,
  label,
  onPick,
  onFreeText,
}: {
  source: string;
  dependsOn?: string[];
  deps: Record<string, string>;
  value: string;
  label?: string;
  onPick: (value: string, label: string) => void;
  onFreeText: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Debounce the typed query ~200ms so a keystroke burst is one lookup.
  const debounced = useDebouncedValue(query, 200);
  // The results are a popover: shown while the search input has focus, hidden
  // otherwise, so the list never pushes the form open or spills out of it.
  const [open, setOpen] = useState(false);

  // A dependsOn value is missing until its sibling row is filled. The picker
  // cannot scope the list without it, so it stays disabled and names the gap.
  const missingDep = (dependsOn ?? []).find((field) => !deps[field]);
  const ready = missingDep === undefined;

  const optionsQ = useFilterOptions({ source, q: debounced, deps }, { enabled: ready });
  const reason = optionsQ.data?.reason;
  const options = useMemo(() => optionsQ.data?.options ?? [], [optionsQ.data]);

  // The endpoint could not resolve the source now (unconnected integration,
  // provider error). Explain it and fall back to a free-text input so the rule
  // is still creatable.
  if (ready && reason) {
    return (
      <div className="min-w-0 flex-1 space-y-1">
        <Input
          aria-label="Filter value"
          value={value}
          onChange={(e) => onFreeText(e.target.value)}
          placeholder="value"
          className="min-w-0 flex-1"
        />
        <p className="text-xs text-muted">{reason}</p>
      </div>
    );
  }

  return (
    <div className="relative min-w-0 flex-1">
      <Input
        aria-label="Filter value search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        // Delay the close so a click on an option registers first.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        // Once picked, the resolved name shows as the placeholder; typing searches again.
        placeholder={ready ? (label ?? (value || "Search…")) : `Pick a ${missingDep} first`}
        disabled={!ready}
        className="min-w-0 flex-1"
      />
      {value && !open && (
        <p className="mt-0.5 pl-1 text-xs text-muted">
          Selected: <span className="text-ink">{label ?? value}</span>
        </p>
      )}
      {open && ready && (
        <div
          role="listbox"
          aria-label="Filter value options"
          className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-md border border-line bg-paper py-1 shadow-lg"
        >
          {optionsQ.isLoading && <p className="px-2 py-1 text-xs text-muted">Loading…</p>}
          {!optionsQ.isLoading && options.length === 0 && (
            // A rejected lookup settles with no data and an empty list, the
            // same shape as a real empty answer. Say so instead of naming a
            // fix that cannot apply. `answered` is the test: the channel
            // advice only goes out when the lookup actually returned.
            <p className="px-2 py-1 text-xs text-muted">
              {optionsQ.data === undefined
                ? "Could not load the options. Check your connection and try again."
                : source === "slack.channels"
                  ? NO_CHANNEL_MATCH_HELP
                  : "No matches"}
            </p>
          )}
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === value}
              // Keep the input focused through the click so onBlur does not
              // close the popover before onClick fires.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(o.id, o.label);
                setQuery("");
                setOpen(false);
              }}
              className={`block min-h-11 w-full break-words px-2 py-1 text-left sm:min-h-0 text-sm text-ink hover:bg-hover ${
                o.id === value ? "bg-hover" : ""
              }`}
            >
              {o.label}
              {o.hint && <span className="ml-1 text-xs text-muted">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
