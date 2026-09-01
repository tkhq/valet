/**
 * Mention-scope enforcement for Slack mention subscriptions (TKAI-299).
 *
 * A subscription whose event keys select `slack.app_mention` is a "mention
 * subscription". At write time it is scoped two ways, so it cannot collect
 * other users' mentions or silently listen across the whole workspace:
 *
 * 1. **User scope.** The filters must carry a `user` filter equal to the
 *    creator's linked Slack user id. Absent, the server injects it; present
 *    with any other value, the write is refused. A creator with no linked
 *    Slack account cannot create a mention subscription.
 * 2. **Channel scope.** The filters must carry at least one `channel` filter
 *    (`eq` or `in`), unless the request sets the explicit `anyChannel` flag.
 *    `anyChannel` is not persisted: after this gate, a stored mention
 *    subscription with no channel filter IS the any-channel state.
 *
 * Both subscription writers call this after `validateSubscription` — the
 * events CRUD routes (`routes/events.ts`) and the workflow trigger service
 * (`workflows/trigger-service.ts`) — so the rule cannot be evaded through
 * either surface. Enforcement is write-time only: the ingest matcher applies
 * the stored filters unchanged.
 */
import type { ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { identityForUser } from "../channels/identity-links.js";
import { eventKeyMatches, type SubscriptionFilter } from "./match.js";

export const SLACK_MENTION_KEY = "slack.app_mention";

/** Whether the eventKeys patterns select `slack.app_mention` — exact key or a
 * trailing wildcard ("slack.*"), so the raw API cannot widen around the gate. */
export function selectsSlackMention(eventKeys: string[]): boolean {
  return eventKeyMatches(SLACK_MENTION_KEY, eventKeys);
}

/** True when the filter constrains the channel to a fixed set. `prefix`,
 * `contains` and `regex` do not count: "starts with C" is the whole workspace. */
function isChannelScopeFilter(f: SubscriptionFilter): boolean {
  return f.field === "channel" && (f.op === "eq" || f.op === "in");
}

function isCreatorUserFilter(f: SubscriptionFilter, slackUserId: string): boolean {
  if (f.field !== "user") return false;
  if (f.op === "eq") return f.value === slackUserId;
  if (f.op === "in") return Array.isArray(f.value) && f.value.length === 1 && f.value[0] === slackUserId;
  return false;
}

/** Catalog entries the eventKeys patterns select, across every plugin. */
function selectedEntries(plugins: ValetPlugin[], eventKeys: string[]) {
  return plugins
    .flatMap((p) => p.triggers ?? [])
    .flatMap((t) => t.catalog)
    .filter((e) => eventKeyMatches(e.key, eventKeys));
}

export type MentionScopeResult =
  | { ok: true; filters: SubscriptionFilter[] }
  | { ok: false; error: string };

/**
 * Applies the mention-scope rules above. Returns the filters to store — the
 * input filters, plus the injected creator `user` filter when it was absent —
 * or a human-readable refusal that names the corrective action.
 *
 * `creatorUserId` is the subscription's creator (`created_by`), not the
 * caller: an org-owned mention subscription patched by a colleague stays
 * scoped to the user who armed it.
 *
 * Non-mention subscriptions pass through unchanged; `anyChannel` has no
 * meaning for them and is ignored.
 */
export async function enforceMentionScope(
  db: AppDb,
  plugins: ValetPlugin[],
  creatorUserId: string,
  args: { eventKeys: string[]; filters: SubscriptionFilter[]; anyChannel: boolean },
): Promise<MentionScopeResult> {
  if (!selectsSlackMention(args.eventKeys)) return { ok: true, filters: args.filters };

  // The injected user filter applies to EVERY event the subscription matches
  // (filters are per-subscription, not per-key). A selected key whose catalog
  // entry declares no `user` field would never match again, so refuse the mix
  // instead of storing a silently dead subscription.
  for (const entry of selectedEntries(plugins, args.eventKeys)) {
    if (entry.key === SLACK_MENTION_KEY) continue;
    if (!entry.filters.some((f) => f.field === "user")) {
      return {
        ok: false,
        error:
          `slack.app_mention is scoped to your Slack user, and that user filter can never match ` +
          `${entry.key}, which has no user field. Create a separate subscription for ${entry.key}.`,
      };
    }
  }

  const hasChannelScope = args.filters.some(isChannelScopeFilter);
  if (args.anyChannel && hasChannelScope) {
    return {
      ok: false,
      error: `"Any channel" removes the channel restriction. Remove the channel filters, or turn "Any channel" off.`,
    };
  }
  if (!args.anyChannel && !hasChannelScope) {
    return {
      ok: false,
      error:
        "A mention subscription needs at least one channel. " +
        'Select channels, or choose "Any channel" to listen in every channel the app can see.',
    };
  }

  const identity = await identityForUser(db, "slack", creatorUserId);
  if (!identity) {
    return {
      ok: false,
      error:
        "A mention subscription fires only for the creator's own @-mentions, which needs a linked Slack account. " +
        "Link your Slack account in Settings → Connected accounts, then try again.",
    };
  }

  const userFilters = args.filters.filter((f) => f.field === "user");
  if (userFilters.length === 0) {
    return {
      ok: true,
      filters: [...args.filters, { field: "user", op: "eq", value: identity.externalId }],
    };
  }
  if (userFilters.every((f) => isCreatorUserFilter(f, identity.externalId))) {
    return { ok: true, filters: args.filters };
  }
  return {
    ok: false,
    error:
      "A mention subscription fires only for the creator's own @-mentions. " +
      "Remove the user filter, or set it to the creator's linked Slack user.",
  };
}
