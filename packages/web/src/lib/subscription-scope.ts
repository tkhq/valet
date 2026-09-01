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
function keySelected(key: string, eventKeys: string[]): boolean {
  return eventKeys.some((k) => k === key || (k.endsWith(".*") && key.startsWith(k.slice(0, -1))));
}

/** Whether the eventKeys patterns select `slack.app_mention`. The wizard's
 * reply outcome is mention-specific by design; everything else derives from
 * catalog scope. */
export function selectsSlackMention(eventKeys: string[]): boolean {
  return keySelected(SLACK_APP_MENTION, eventKeys);
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

const DEFAULT_CHANNEL_FIELDS: ReadonlySet<string> = new Set(["channel"]);

/** Whether the filters constrain a channel field to a non-empty fixed set —
 * op `eq`, or op `in` with at least one value. Accepts the loose `unknown[]`
 * the wire hands back. */
export function hasChannelScopeFilter(
  filters: unknown[],
  fields: ReadonlySet<string> = DEFAULT_CHANNEL_FIELDS,
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

/** A stored scope-required subscription with no channel-scope filter IS the
 * any-channel state (the server refuses the unscoped default and does not
 * persist the flag) — editors seed their "Any channel" checkbox from this,
 * so an edit round-trips without re-checking it. */
export function storedAnyChannel(
  entries: ScopedEntry[],
  eventKeys: string[],
  filters: unknown[],
): boolean {
  const fields = channelScopeFields(entries, eventKeys);
  return fields.size > 0 && !hasChannelScopeFilter(filters, fields);
}
