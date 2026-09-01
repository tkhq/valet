/**
 * Write-time scope enforcement for event subscriptions (TKAI-299, TKAI-302).
 *
 * A catalog entry opts into scoping through `EventCatalogEntry.scope`:
 *
 * 1. **Creator pinning** (`creatorUserField` — `slack.app_mention`). The
 *    filters must carry a filter on that field equal to the creator's linked
 *    identity on the owning plugin's service. Absent, the server injects it;
 *    present with any other value, the write is refused. A pinned key cannot
 *    share a subscription with any other key: the injected filter applies to
 *    every selected key and would silently narrow or kill the others.
 * 2. **Channel scope** (`channelField` — `slack.app_mention`,
 *    `slack.message`). The filters must constrain that field to a non-empty
 *    fixed set (`eq`, or `in` with values), unless the request sets the
 *    explicit `anyChannel` flag. `anyChannel` is not persisted: a stored
 *    scope-required subscription with no channel filter IS the any-channel
 *    state. When the channel filter is required and stored, every selected
 *    key must declare the field, or the filter would silently kill the keys
 *    that do not — the gate refuses the mix instead.
 *
 * Every writer reaches this through `validateSubscriptionWrite`
 * (`events/subscription-write.ts`), the one gate in front of every
 * `event_subscriptions` write. The matcher carries one arm of the pinning
 * rule: `subscriptionMatchesEvent` fails closed on a pinned key with no
 * filter on the pinned field, so a row from before the gate cannot keep
 * firing unscoped. Channel scope has NO match-time arm: a stored row with no
 * channel filter is indistinguishable from the legitimate any-channel state,
 * so rows from before this gate keep firing (accepted pre-1.0; revisit with
 * a persisted flag if that ever pages someone).
 */
import type { EventCatalogEntry, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { identityForUser } from "../channels/identity-links.js";
import { allCatalogEntriesWithService } from "./ingest.js";
import { eventKeyMatches, type SubscriptionFilter } from "./match.js";

interface Selection {
  service: string;
  entry: EventCatalogEntry;
}

/** Catalog entries the eventKeys patterns select, with their owning service. */
function selections(plugins: ValetPlugin[], eventKeys: string[]): Selection[] {
  return allCatalogEntriesWithService(plugins).filter((s) => eventKeyMatches(s.entry.key, eventKeys));
}

/** The channel fields the selected entries require scoping on. */
function channelFieldsOf(sel: Selection[]): Set<string> {
  const fields = new Set<string>();
  for (const s of sel) {
    const f = s.entry.scope?.channelField;
    if (f !== undefined) fields.add(f);
  }
  return fields;
}

/** True when the filter constrains a required channel field to a non-empty
 * fixed set. `prefix`, `contains` and `regex` do not count: "starts with C"
 * is the whole workspace. An empty `in` list does not count either — it
 * matches nothing, which is not a channel selection. */
function isChannelScopeFilter(f: SubscriptionFilter, fields: Set<string>): boolean {
  if (!fields.has(f.field)) return false;
  if (f.op === "eq") return true;
  return f.op === "in" && Array.isArray(f.value) && f.value.length > 0;
}

function isCreatorFilter(f: SubscriptionFilter, field: string, externalId: string): boolean {
  if (f.field !== field) return false;
  if (f.op === "eq") return f.value === externalId;
  if (f.op === "in") return Array.isArray(f.value) && f.value.length === 1 && f.value[0] === externalId;
  return false;
}

/**
 * Whether a STORED subscription is in the any-channel state: it selects at
 * least one channel-scoped key and carries no channel-scope filter. The
 * `anyChannel` request flag is deliberately not persisted, so this derivation
 * is the stored state. The PATCH paths feed it back as `storedAnyChannel` so
 * an edit that does not touch channel scope is not refused for lacking a
 * flag the server never stored.
 */
export function storedAnyChannelState(
  plugins: ValetPlugin[],
  eventKeys: string[],
  filters: SubscriptionFilter[],
): boolean {
  const fields = channelFieldsOf(selections(plugins, eventKeys));
  return fields.size > 0 && !filters.some((f) => isChannelScopeFilter(f, fields));
}

export type ScopeResult = { ok: true; filters: SubscriptionFilter[] } | { ok: false; error: string };

/**
 * Applies the scope rules above. Returns the filters to store — the input
 * filters, plus the injected creator filter when a pinned key required one —
 * or a human-readable refusal that names the corrective action.
 *
 * `creatorUserId` is the subscription's creator (`created_by`), not the
 * caller: an org-owned pinned subscription patched by a colleague stays
 * scoped to the user who armed it.
 *
 * `storedAnyChannel` (PATCH paths only) carries the row's derived
 * any-channel state, so a patch that leaves channel scope alone passes
 * without the caller re-asserting the flag. The explicit `anyChannel` flag
 * alone trips the contradiction check, so a stored any-channel row can still
 * be narrowed to named channels by just sending channel filters.
 *
 * Unscoped subscriptions pass through unchanged; `anyChannel` has no meaning
 * for them and is ignored.
 */
export async function enforceSubscriptionScope(
  db: AppDb,
  plugins: ValetPlugin[],
  creatorUserId: string,
  args: {
    eventKeys: string[];
    filters: SubscriptionFilter[];
    anyChannel: boolean;
    storedAnyChannel?: boolean;
  },
): Promise<ScopeResult> {
  const sel = selections(plugins, args.eventKeys);
  const pinned = sel.filter((s) => s.entry.scope?.creatorUserField !== undefined);
  const channelFields = channelFieldsOf(sel);
  if (pinned.length === 0 && channelFields.size === 0) return { ok: true, filters: args.filters };

  // A pinned key stands alone: the injected creator filter applies to EVERY
  // event the subscription matches (filters are per-subscription, not
  // per-key), so a second key would be silently narrowed to the creator's
  // own events — or, for a key with no such field, never match again.
  // Refuse the mix instead of storing either surprise.
  if (pinned.length > 0) {
    const other = sel.find((s) => s.entry.key !== pinned[0].entry.key);
    if (other !== undefined) {
      return {
        ok: false,
        error:
          `A mention subscription is scoped to your own @-mentions, so it cannot also subscribe ` +
          `to ${other.entry.key}. Create a separate subscription for ${other.entry.key}.`,
      };
    }
  }

  // An empty `in` list matches nothing, ever — refuse it rather than store a
  // dead filter the UI would have to explain.
  if (
    args.filters.some(
      (f) => channelFields.has(f.field) && f.op === "in" && Array.isArray(f.value) && f.value.length === 0,
    )
  ) {
    return {
      ok: false,
      error: "A channel filter has an empty list. Add channels to it, or remove the filter.",
    };
  }

  const hasChannelScope = args.filters.some((f) => isChannelScopeFilter(f, channelFields));
  if (args.anyChannel && hasChannelScope) {
    return {
      ok: false,
      error: `"Any channel" removes the channel restriction. Remove the channel filters, or turn "Any channel" off.`,
    };
  }
  if (channelFields.size > 0 && !args.anyChannel && !hasChannelScope && args.storedAnyChannel !== true) {
    const noun = pinned.length > 0 ? "A mention subscription" : "This subscription";
    return {
      ok: false,
      error:
        `${noun} needs at least one channel filter (equals, or is one of). ` +
        'Select channels, or choose "Any channel" to listen in every channel the app can see.',
    };
  }

  // A stored channel filter applies to every selected key. A selected key
  // with no channel field would silently never match again — refuse the mix.
  // Under anyChannel no filter is stored, so the mix is harmless.
  if (hasChannelScope) {
    const unscopable = sel.find((s) => s.entry.scope?.channelField === undefined);
    if (unscopable !== undefined) {
      return {
        ok: false,
        error:
          `A channel filter applies to every event in a subscription, and ${unscopable.entry.key} ` +
          `has no channel field, so it would never fire. Create a separate subscription for ` +
          `${unscopable.entry.key}.`,
      };
    }
  }

  if (pinned.length === 0) return { ok: true, filters: args.filters };

  const { service, entry } = pinned[0];
  // Non-null: `pinned` filtered on exactly this field being defined.
  const pinField = entry.scope!.creatorUserField!;
  const identity = await identityForUser(db, service, creatorUserId);
  if (!identity) {
    return {
      ok: false,
      error:
        "A mention subscription fires only for its creator's own @-mentions, so the creator must link " +
        "their Slack account in Settings → Connected accounts first.",
    };
  }

  const pinFilters = args.filters.filter((f) => f.field === pinField);
  if (pinFilters.length === 0) {
    return {
      ok: true,
      filters: [...args.filters, { field: pinField, op: "eq", value: identity.externalId }],
    };
  }
  if (pinFilters.every((f) => isCreatorFilter(f, pinField, identity.externalId))) {
    return { ok: true, filters: args.filters };
  }
  return {
    ok: false,
    error:
      "A mention subscription fires only for the creator's own @-mentions. " +
      "Remove the user filter, or set it to the creator's linked Slack user.",
  };
}
