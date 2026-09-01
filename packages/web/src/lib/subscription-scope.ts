/**
 * Client-side mirror of the server's catalog-declared scope predicates
 * (packages/api/src/events/subscription-scope.ts, TKAI-299/TKAI-302). One
 * home, so the subscriptions list, the trigger dialog, and the wizard cannot
 * drift from each other — or from the server — on what counts as a scoped
 * key or as channel scope. Scope requirements ride the catalog wire
 * (`EventCatalogEntryWire.scope`); nothing here hardcodes a key except the
 * wizard's mention-specific reply outcome.
 */

export const SLACK_APP_MENTION = "slack.app_mention";

/** The subset of a catalog entry the scope predicates need. Both the wire's
 * `EventCatalogEntryWire` and the wizard's own entry shapes satisfy it. */
export interface ScopedEntry {
  key: string;
  scope?: { channelField?: string; creatorUserField?: string };
}

/** Whether one eventKeys pattern selects `key` — the exact key or a trailing
 * wildcard, mirroring the server's `eventKeyMatches`. */
export function keySelected(key: string, eventKeys: string[]): boolean {
  return eventKeys.some((k) => k === key || (k.endsWith(".*") && key.startsWith(k.slice(0, -1))));
}

/** The channel fields the selected entries require scoping on. */
export function channelScopeFields(entries: ScopedEntry[], eventKeys: string[]): Set<string> {
  const fields = new Set<string>();
  for (const e of entries) {
    const f = e.scope?.channelField;
    if (f !== undefined && keySelected(e.key, eventKeys)) fields.add(f);
  }
  return fields;
}

/** Whether any selected entry requires channel scope. */
export function requiresChannelScope(entries: ScopedEntry[], eventKeys: string[]): boolean {
  return channelScopeFields(entries, eventKeys).size > 0;
}

/** Whether any selected entry pins its filters to the creator's identity —
 * decides the mention-specific copy on the shared "Any channel" checkbox. */
export function pinnedToCreator(entries: ScopedEntry[], eventKeys: string[]): boolean {
  return entries.some((e) => e.scope?.creatorUserField !== undefined && keySelected(e.key, eventKeys));
}

/** Whether the filters constrain a channel field to a non-empty fixed set —
 * op `eq`, or op `in` with at least one value. Accepts the loose `unknown[]`
 * the wire hands back. */
export function hasChannelScopeFilter(
  filters: unknown[],
  fields: ReadonlySet<string>,
): boolean {
  return filters.some((f) => {
    if (typeof f !== "object" || f === null) return false;
    // Narrows the wire's unknown filter entry; shape is owned by the server's
    // subscription validator, the only writer of these rows.
    const r = f as Record<string, unknown>;
    if (typeof r.field !== "string" || !fields.has(r.field)) return false;
    if (r.op === "eq") return true;
    return r.op === "in" && Array.isArray(r.value) && r.value.length > 0;
  });
}

/** A stored scope-required subscription is in the any-channel state when the
 * selected entries declare at least one channel field AND at least one of
 * those fields has no constraining filter. The server never persists the
 * `anyChannel` flag, so this derivation IS the stored state. Editors seed
 * their "Any channel" checkbox from this so an edit round-trips without
 * re-checking it.
 *
 * Per-field: a subscription with two channel fields where one is constrained
 * and one is not still counts as any-channel (mirrors the server's
 * `storedAnyChannelState`). */
export function storedAnyChannel(
  entries: ScopedEntry[],
  eventKeys: string[],
  filters: unknown[],
): boolean {
  const fields = channelScopeFields(entries, eventKeys);
  if (fields.size === 0) return false;
  for (const field of fields) {
    if (!hasChannelScopeFilter(filters, new Set([field]))) return true;
  }
  return false;
}
