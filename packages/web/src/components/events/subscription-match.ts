import type { FilterField } from "./filter-editor";

export interface CatalogService {
  service: string;
  entries: { key: string; description: string; filters?: FilterField[] }[];
}

/** Filter fields the selected events declare, unioned and deduped by field —
 * a filter is valid when any selected event declares it (the same rule the
 * server's validateSubscription applies). */
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
