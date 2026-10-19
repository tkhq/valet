import { useRef, useState } from "react";
import type { EventSubscriptionFilterWire } from "@valet/api/wire";
import { hasChannelScopeFilter } from "~/lib/slack-mention";
import { incompleteFilterRow, pruneFilterRows, toWireFilters, type FilterField, type UiFilterRow } from "./filter-editor";

export interface CatalogService {
  service: string;
  entries: { key: string; description: string; filters?: FilterField[] }[];
}

/** Filter fields the selected events declare, unioned and deduped by field —
 * a filter is valid when any selected event declares it (the same rule the
 * server's validateSubscription applies). Shared with the edit dialog. */
export function unionFilterFields(
  services: CatalogService[],
  selected: ReadonlySet<string>,
): FilterField[] {
  const out: FilterField[] = [];
  const seen = new Set<string>();
  for (const s of services) {
    for (const entry of s.entries) {
      if (!selected.has(entry.key)) continue;
      for (const f of entry.filters ?? []) {
        if (seen.has(f.field)) continue;
        seen.add(f.field);
        out.push({ field: f.field, description: f.description, options: f.options });
      }
    }
  }
  return out;
}

/**
 * The pinned rows the pruned rows lack, put back when the fields allow them.
 * A pinned row is one the caller chose for the reader, such as a preselected
 * place's filter: an event without its field drops it, and a later event
 * with the field brings it back. The caller passes only the pins that
 * pruning dropped, so a pin the reader removed stays removed.
 */
export function restorePinnedRows(rows: UiFilterRow[], pinned: readonly UiFilterRow[], fields: FilterField[]): UiFilterRow[] {
  const missing = pinned.filter(
    (pin) => fields.some((f) => f.field === pin.field) && !rows.some((row) => row.id === pin.id || row.field === pin.field),
  );
  return missing.length === 0 ? rows : [...missing, ...rows];
}

/** Both forms mount when opened. Keep their event selection and filter rows
 * together. `pinnedRows` survive an event change (see `restorePinnedRows`),
 * unless the reader removed them. */
export function useSubscriptionMatch(
  services: CatalogService[],
  initialKeys: string[] = [],
  initialRows: () => UiFilterRow[] = () => [],
  pinnedRows: readonly UiFilterRow[] = [],
) {
  const [keys, setKeys] = useState(() => new Set(initialKeys));
  const [filterRows, setFilterRows] = useState(initialRows);
  const filterFields = unionFilterFields(services, keys);
  // The ids of pinned rows that an event change pruned. Only these come
  // back: a pin the reader removed is not in the rows when an event changes.
  const prunedPins = useRef(new Set<string>());

  function toggleKey(key: string) {
    const next = new Set(keys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setKeys(next);
    const fields = unionFilterFields(services, next);
    const pruned = pruneFilterRows(filterRows, fields);
    for (const pin of pinnedRows) {
      if (filterRows.some((row) => row.id === pin.id) && !pruned.some((row) => row.id === pin.id)) prunedPins.current.add(pin.id);
    }
    const restored = restorePinnedRows(pruned, pinnedRows.filter((pin) => prunedPins.current.has(pin.id)), fields);
    for (const row of restored) prunedPins.current.delete(row.id);
    setFilterRows(restored);
  }

  return { keys, setKeys, filterRows, setFilterRows, filterFields, toggleKey };
}

/** Preserve the edit form's stricter scope gate; create delegates missing scope to the server. */
export function validateSubscriptionFilters(
  rows: UiFilterRow[],
  { mention, anyChannel, requireChannelScope = false }: {
    mention: boolean;
    anyChannel: boolean;
    requireChannelScope?: boolean;
  },
): { filters: EventSubscriptionFilterWire[]; error?: never } | { error: string; filters?: never } {
  const incomplete = incompleteFilterRow(rows);
  if (incomplete) return { error: `Enter a value for the "${incomplete}" filter, or remove the row.` };
  const filters = toWireFilters(rows);
  if (mention) {
    const scoped = hasChannelScopeFilter(filters);
    if (requireChannelScope && !anyChannel && !scoped) {
      return { error: 'A mention rule needs a channel filter (equals, or is one of). Add one, or check "Any channel".' };
    }
    if (anyChannel && scoped) {
      return { error: '"Any channel" removes the channel restriction. Remove the channel filters, or turn "Any channel" off.' };
    }
  }
  return { filters };
}
