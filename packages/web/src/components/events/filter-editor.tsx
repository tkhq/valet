/**
 * FilterEditor — the field/operator/value rows that build an event
 * subscription's filters. Shared by the workflow TriggerDialog and the event
 * AutomationWizard, which post the same `{field, op, value}` shape to the same
 * `validateSubscription` on the server.
 *
 * A row's `value` is held as the raw text the user typed. The `in` operator
 * splits it into a list at submit (`toWireFilters`), so the form never needs
 * a separate list widget.
 */
import { useMemo, useState } from "react";
import type { EventSubscriptionFilterWire } from "@valet/api/wire";
import { useFilterOptions } from "~/api/events";
import { useDebouncedValue } from "~/hooks/use-debounced-value";
import { Button, Input } from "~/components/primitives";

export type FilterOp = "eq" | "in" | "prefix" | "contains" | "regex";

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

const OP_OPTIONS: { value: FilterOp; label: string }[] = [
  { value: "eq", label: "equals" },
  { value: "in", label: "is one of" },
  { value: "prefix", label: "starts with" },
  { value: "contains", label: "contains" },
  { value: "regex", label: "matches pattern" },
];

/** Plain-language names for the fields a person recognizes, in place of the raw
 * catalog field key. Unknown fields fall back to a title-cased key. */
const FIELD_LABELS: Record<string, string> = {
  channel: "Channel",
  user: "User",
  text: "Message text",
  channel_type: "Conversation type",
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
 * dropped, because a half-filled row is not a filter and would 400. The `in`
 * operator splits its value on commas into a list.
 */
export function toWireFilters(rows: UiFilterRow[]): EventSubscriptionFilterWire[] {
  const out: EventSubscriptionFilterWire[] = [];
  for (const row of rows) {
    if (!row.field) continue;
    if (row.op === "in") {
      const values = row.value
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (values.length === 0) continue;
      out.push({ field: row.field, op: "in", value: values });
    } else {
      const value = row.value.trim();
      if (value.length === 0) continue;
      // The label is a display name for a single picked value. The `in`
      // operator is multi-value, so it carries no single label.
      const label = row.label?.trim();
      out.push(label ? { field: row.field, op: row.op, value, label } : { field: row.field, op: row.op, value });
    }
  }
  return out;
}

/**
 * Rebuild form rows from stored filters when editing. Tolerant of the
 * `unknown[]` the wire hands back: an `in` list rejoins with ", " so the one
 * value input round-trips.
 */
export function fromWireFilters(filters: unknown[]): UiFilterRow[] {
  const rows: UiFilterRow[] = [];
  for (const f of filters) {
    if (typeof f !== "object" || f === null) continue;
    const r = f as Record<string, unknown>;
    const field = typeof r.field === "string" ? r.field : "";
    const op: FilterOp =
      r.op === "in" || r.op === "prefix" || r.op === "contains" || r.op === "regex" ? r.op : "eq";
    const value = Array.isArray(r.value)
      ? r.value.filter((v): v is string => typeof v === "string").join(", ")
      : typeof r.value === "string"
        ? r.value
        : "";
    const label = typeof r.label === "string" ? r.label : undefined;
    const id = newRowId();
    rows.push(label !== undefined ? { id, field, op, value, label } : { id, field, op, value });
  }
  return rows;
}

/**
 * The field of the first row that has a field selected but no usable value, or
 * null when every row is complete. A dialog calls this before submit so a
 * half-filled row is a named error, not a silently dropped filter.
 */
export function incompleteFilterRow(rows: UiFilterRow[]): string | null {
  for (const row of rows) {
    if (!row.field) continue;
    const hasValue =
      row.op === "in"
        ? row.value.split(",").some((v) => v.trim().length > 0)
        : row.value.trim().length > 0;
    if (!hasValue) return row.field;
  }
  return null;
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
 * The value of each `dependsOn` field, read from the sibling rows. A field's
 * picker is scoped by these (a channel list scoped to a repo). `skipIndex` is
 * the picker's own row, so a field cannot depend on itself. Only the first
 * matching row's value is used.
 */
function depsFor(
  dependsOn: string[] | undefined,
  rows: UiFilterRow[],
  skipIndex: number,
): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const field of dependsOn ?? []) {
    const sibling = rows.find((r, idx) => idx !== skipIndex && r.field === field && r.value.trim().length > 0);
    if (sibling) deps[field] = sibling.value.trim();
  }
  return deps;
}

export function FilterEditor({
  fields,
  rows,
  onChange,
}: {
  fields: FilterField[];
  rows: UiFilterRow[];
  onChange: (rows: UiFilterRow[]) => void;
}) {
  function update(i: number, patch: Partial<UiFilterRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    onChange(rows.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...rows, { id: newRowId(), field: fields[0]?.field ?? "", op: "eq", value: "" }]);
  }

  // No fields and no existing rows: nothing to configure. Say so, rather than
  // showing an Add button that would build an unmatchable filter.
  if (fields.length === 0 && rows.length === 0) {
    return (
      <p className="text-xs text-muted">
        This event has no filterable fields. It matches every occurrence.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => {
        // Keep the row's own field selectable even if the catalog no longer
        // lists it (the selected events changed), so editing never silently
        // drops a filter the user already set.
        const known = fields.some((f) => f.field === row.field);
        const options = row.field && !known ? [{ field: row.field }, ...fields] : fields;
        const selectedField = fields.find((f) => f.field === row.field);
        const description = selectedField?.description;
        // A field with an option source uses a picker, except under `in`
        // (multi-value), which keeps the comma free-text input.
        const optionSource = row.op === "in" ? undefined : selectedField?.options;
        // The catalog description (e.g. "Slack channel id (C…/D…)") answers
        // "what do I paste here?"; the `in` note explains the comma format.
        const hint = [
          description,
          row.op === "in" ? "Separate values with commas." : undefined,
          row.field && !known ? "Not declared by the selected event — remove or change it." : undefined,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={row.id} className="space-y-1">
            <div className="flex items-center gap-2">
              <select
                aria-label="Filter field"
                value={row.field}
                onChange={(e) => update(i, { field: e.target.value })}
                className="min-w-0 flex-1 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
              >
                {options.map((f) => (
                  <option key={f.field} value={f.field}>
                    {fieldLabel(f.field)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Filter operator"
                value={row.op}
                onChange={(e) => update(i, { op: e.target.value as FilterOp })}
                className="rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
              >
                {OP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {optionSource ? (
                <FilterValuePicker
                  source={optionSource.source}
                  dependsOn={optionSource.dependsOn}
                  deps={depsFor(optionSource.dependsOn, rows, i)}
                  value={row.value}
                  label={row.label}
                  onPick={(value, label) => update(i, { value, label })}
                  onFreeText={(value) => update(i, { value, label: undefined })}
                />
              ) : (
                <Input
                  aria-label="Filter value"
                  value={row.value}
                  onChange={(e) => update(i, { value: e.target.value, label: undefined })}
                  placeholder={row.op === "in" ? "a, b, c" : "value"}
                  className="min-w-0 flex-1"
                />
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove filter"
                onClick={() => remove(i)}
              >
                ✕
              </Button>
            </div>
            {hint && <p className="pl-1 text-xs text-muted">{hint}</p>}
          </div>
        );
      })}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={fields.length === 0}
        title={fields.length === 0 ? "This event has no filterable fields." : undefined}
        onClick={add}
      >
        Add filter
      </Button>
    </div>
  );
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
function FilterValuePicker({
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
            <p className="px-2 py-1 text-xs text-muted">No matches</p>
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
              className={`block w-full px-2 py-1 text-left text-sm text-ink hover:bg-hover ${
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
