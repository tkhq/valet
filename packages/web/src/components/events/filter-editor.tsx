/**
 * FilterEditor — the field/operator/value rows that build an event
 * subscription's filters. Shared by the workflow TriggerDialog and the event
 * SubscriptionCreateDialog, which post the same `{field, op, value}` shape to
 * the same `validateSubscription` on the server.
 *
 * A row's `value` is held as the raw text the user typed. The `in` operator
 * splits it into a list at submit (`toWireFilters`), so the form never needs
 * a separate list widget.
 */
import type { EventSubscriptionFilterWire } from "@valet/api/wire";
import { Button, Input } from "~/components/primitives";

export type FilterOp = "eq" | "in" | "prefix" | "contains";

export interface UiFilterRow {
  field: string;
  op: FilterOp;
  value: string;
}

/** One filterable field the selected event declares. `description` is a hint. */
export interface FilterField {
  field: string;
  description?: string;
}

const OP_OPTIONS: { value: FilterOp; label: string }[] = [
  { value: "eq", label: "equals" },
  { value: "in", label: "is one of" },
  { value: "prefix", label: "starts with" },
  { value: "contains", label: "contains" },
];

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
      out.push({ field: row.field, op: row.op, value });
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
    const op: FilterOp = r.op === "in" || r.op === "prefix" || r.op === "contains" ? r.op : "eq";
    const value = Array.isArray(r.value)
      ? r.value.filter((v): v is string => typeof v === "string").join(", ")
      : typeof r.value === "string"
        ? r.value
        : "";
    rows.push({ field, op, value });
  }
  return rows;
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
    onChange([...rows, { field: fields[0]?.field ?? "", op: "eq", value: "" }]);
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
        const options =
          row.field && !fields.some((f) => f.field === row.field)
            ? [{ field: row.field }, ...fields]
            : fields;
        return (
          <div key={i} className="flex items-center gap-2">
            <select
              aria-label="Filter field"
              value={row.field}
              onChange={(e) => update(i, { field: e.target.value })}
              className="min-w-0 flex-1 rounded border border-line bg-paper px-2 py-1.5 text-sm text-ink"
            >
              {options.map((f) => (
                <option key={f.field} value={f.field}>
                  {f.field}
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
            <Input
              aria-label="Filter value"
              value={row.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={row.op === "in" ? "a, b, c" : "value"}
              className="min-w-0 flex-1"
            />
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
        );
      })}
      <Button type="button" variant="secondary" size="sm" disabled={fields.length === 0} onClick={add}>
        Add filter
      </Button>
    </div>
  );
}
