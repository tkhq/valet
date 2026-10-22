import { validateAppearance } from "@valet/shared";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, gte, lte, ne, sql } from "drizzle-orm";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { ActionPlugin, PluginAction, PluginActionContext, PluginActionResult, ValetPlugin } from "@valet/engine";
import type { AppDb, AppQueryable } from "../lib/drizzle.js";
import { eventDropLog, eventReceipts, eventSubscriptions, orgMembers, type EventDropLogRow, type EventSubscriptionRow } from "../schema/index.js";

import { withAuthorizedTeamOwnership } from "../services/teams.js";
import { FILTER_OPS } from "./match.js";
import { validateSubscriptionWrite } from "./subscription-write.js";
import { proposalId, proposalResult } from "./proposals.js";
import { receiptWire, RECEIPT_RETENTION_DAYS } from "./receipts.js";
import { readStoredTarget } from "./target-names.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MIN_TIMESTAMP = Number.MIN_SAFE_INTEGER;
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    execute: (args: Static<TParams>, ctx: PluginActionContext) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadata(row: EventDropLogRow): Record<string, unknown> {
  return isRecord(row.eventMetadata) ? row.eventMetadata : {};
}

function timestampIsSafe(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= MIN_TIMESTAMP && value <= MAX_TIMESTAMP);
}

/** A channel sender with no Valet account runs as the rule's creator, but is
 * not that person: they may not manage or inspect the workspace's events. */
const EXTERNAL_SENDER = {
  success: false as const,
  error: "Only a teammate with a linked Valet account can manage events. Ask them, or link your Slack account in Valet.",
};

function transcriptIsShared(ctx: PluginActionContext): boolean {
  // A missing owner cannot prove that the transcript is private. A channel
  // origin also makes this turn member-visible, even in a user-owned session.
  return ctx.owner?.type !== "user" || ctx.origin !== undefined || ctx.sharedTranscript === true;
}

function publicMetadata(eventMetadata: Record<string, unknown>): Record<string, unknown> {
  const safeKeys = ["channel", "rawEventType", "rawSubtype"];
  return Object.fromEntries(safeKeys.flatMap((key) =>
    Object.hasOwn(eventMetadata, key) ? [[key, eventMetadata[key]]] : [],
  ));
}

function matchOutcome(reason: string): "excluded_by_filter" | null {
  return reason === "filter_excluded" ? "excluded_by_filter" : null;
}

/** Agent-facing counterpart of the Problems page. The drop log remains the
 * only store: it retains a small, redacted event identity for filter misses,
 * never the source payload. */
export function eventsActionPlugin(db: AppDb, plugins: ValetPlugin[] | (() => ValetPlugin[]) = []): ActionPlugin {
  async function withSubscriptionScope(
    ctx: PluginActionContext,
    operation: (tx: AppQueryable, scope: { orgId: string; ownerType: "user" | "team"; ownerId: string }) => Promise<PluginActionResult>,
  ): Promise<PluginActionResult> {
    if (ctx.externalSender) return EXTERNAL_SENDER;
    const userId = ctx.actor?.id ?? ctx.userId;
    if (!userId || !ctx.orgId || (ctx.owner && ctx.owner.type !== "user" && ctx.owner.type !== "team") ||
        (ctx.owner?.type === "user" && ctx.owner.id !== userId)) {
      return { success: false, error: "Open your personal or team assistant to manage its subscriptions." };
    }
    const [membership] = await db.select({ userId: orgMembers.userId }).from(orgMembers)
      .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, userId))).limit(1);
    if (!membership) return { success: false, error: "Sign in as an organization member to manage subscriptions." };
    const ownerType = ctx.owner?.type === "team" ? "team" as const : "user" as const;
    const scope = { orgId: ctx.orgId, ownerType, ownerId: ownerType === "team" ? ctx.owner!.id : userId };
    const result = ownerType === "team"
      ? await withAuthorizedTeamOwnership(db, { teamId: scope.ownerId, orgId: scope.orgId, userId, principalTeamId: scope.ownerId, requireMembership: true }, (tx) => operation(tx, scope))
      : await operation(db, scope);
    return result ?? { success: false, error: "Team is no longer available. Open a team you belong to and retry." };
  }

  const listSubscriptions = action(Type.Object({
    name: Type.Optional(Type.String({ description: "Exact subscription name." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  }))({
    id: "events.list_subscriptions",
    name: "List workspace event subscriptions",
    description: "List event subscriptions owned by the current personal or team workspace, including IDs and each configured appearance (the reply name and avatar). Uses exact name matching. Defaults to 25 records; use nextOffset for the next page.",
    riskLevel: "low",
    execute: async ({ name, limit, offset }, ctx) => withSubscriptionScope(ctx, async (tx, scope) => {
      const pageLimit = limit ?? DEFAULT_LIMIT;
      const pageOffset = offset ?? 0;
      if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_LIMIT || !Number.isSafeInteger(pageOffset) || pageOffset < 0) {
        return { success: false, error: "Use a limit from 1 to 100 and a nonnegative integer offset." };
      }
      const rows = await tx.select().from(eventSubscriptions).where(and(
        eq(eventSubscriptions.orgId, scope.orgId), eq(eventSubscriptions.ownerType, scope.ownerType), eq(eventSubscriptions.ownerId, scope.ownerId),
        name !== undefined ? eq(eventSubscriptions.name, name) : undefined,
      )).orderBy(eventSubscriptions.id).limit(pageLimit + 1).offset(pageOffset);
      // Stored rows may carry the old target names; the tool answers with the new ones.
      const subscriptions = rows.slice(0, pageLimit).map((row) => ({ ...row, target: readStoredTarget(row.target) }));
      return { success: true, data: { subscriptions, nextOffset: rows.length > pageLimit ? pageOffset + pageLimit : null } };
    }),
  });

  const setSubscriptionPresence = action(Type.Object({
    subscription_id: Type.String({ minLength: 1 }),
    presence: Type.Union([Type.Object({ displayName: Type.Optional(Type.String()), avatarUrl: Type.Optional(Type.String()) }), Type.Null()]),
  }))({
    id: "events.set_subscription_presence",
    name: "Set event subscription presence",
    description: "Replace the reply display name and avatar (the appearance) for an existing subscription in the current personal or team workspace. Use null to clear the override. Does not enable the subscription or change its target, prompts, or matching rules.",
    riskLevel: "low",
    execute: async ({ subscription_id, presence }, ctx) => withSubscriptionScope(ctx, async (tx, scope) => {
      if (presence !== null) {
        const error = validateAppearance(presence);
        if (error) return { success: false, error };
      }
      // The row stores `appearance`. The old `presence` key goes too, so a
      // row written before the rename cannot keep a stale identity.
      const [row] = await tx.update(eventSubscriptions).set({
        target: presence === null
          ? sql`${eventSubscriptions.target} - 'presence' - 'appearance'`
          : sql`jsonb_set(${eventSubscriptions.target} - 'presence', '{appearance}', ${JSON.stringify(presence)}::jsonb, true)`,
        updatedAt: sql`greatest(${eventSubscriptions.updatedAt} + 1, ${Date.now()})`,
      }).where(and(eq(eventSubscriptions.id, subscription_id), eq(eventSubscriptions.orgId, scope.orgId),
        eq(eventSubscriptions.ownerType, scope.ownerType), eq(eventSubscriptions.ownerId, scope.ownerId))).returning();
      return row ? { success: true, data: { subscription: { ...row, target: readStoredTarget(row.target) } } }
        : { success: false, error: "Subscription not found in this workspace. Use events.list_subscriptions to select one." };
    }),
  });

  const proposeSubscription = action(Type.Object({
    proposal_key: Type.String({ minLength: 1, maxLength: 200, description: "Stable proposal key. Reuse on retries; use a new key for a different proposal." }),
    name: Type.String({ minLength: 1 }),
    event_keys: Type.Array(Type.String(), { minItems: 1 }),
    filters: Type.Optional(Type.Array(Type.Object({
      field: Type.String(), op: Type.Union(FILTER_OPS.map((op) => Type.Literal(op))),
      value: Type.Unknown(),
    }), { description: "Conditions on fields the selected event keys declare. To cover Slack channels by name, including channels created later, filter channel_name with prefix (such as alerts-) or regex. To skip events, such as posts from one bot, use not_in with a list or not_prefix; an event without the field still matches." })),
    any_channel: Type.Optional(Type.Boolean({ description: "For slack.app_mention only: listen in every channel the app can see. A channel_name condition needs it too, because it is not a fixed channel list." })),
    follow: Type.Optional(Type.Boolean({ description: "For slack.app_mention only: also deliver later replies from the source thread. Defaults to true for a slack.app_mention rule." })),
    delivery_policy: Type.Optional(Type.Union([
      Type.Literal("always"), Type.Literal("ignoreIfMyTeamSubscribed"), Type.Literal("ignoreIfAnyTeamSubscribed"),
    ], { description: "Personal target only: choose whether matching team subscriptions suppress delivery." })),
    pause_on_overlap: Type.Optional(Type.Boolean({ description: "Personal target only: pause following when a team subscription covers the thread." })),
    presence: Type.Optional(Type.Object({
      displayName: Type.Optional(Type.String()),
      avatarUrl: Type.Optional(Type.String()),
    })),
    user_prompt_template: Type.Optional(Type.String()),
    system_prompt: Type.Optional(Type.String()),
    audience: Type.Optional(Type.Union([Type.Literal("team"), Type.Literal("organization")])),
    replaces: Type.Optional(Type.String({ minLength: 1, description: "ID of the enabled subscription in this workspace that this proposal updates. When a person enables the proposal, Valet disables that subscription." })),
  }))({
    id: "events.propose_subscription",
    name: "Propose assistant event subscription",
    description: "Save a disabled event subscription for the current personal or team assistant. Pick event keys from workflows.list_event_types. Returns the stored configuration and a Presence review link. The user must review and enable it. Repeated proposal keys do not change the existing record. To revise an enabled subscription, set replaces to its ID from events.list_subscriptions; enabling the proposal disables the replaced subscription, so only one version replies.",
    riskLevel: "low",
    execute: async (input, ctx) => {
      if (ctx.externalSender) return EXTERNAL_SENDER;
      const userId = ctx.actor?.id ?? ctx.userId;
      if (!userId || !ctx.orgId || (ctx.owner && ctx.owner.type !== "user" && ctx.owner.type !== "team") ||
          (ctx.owner?.type === "user" && ctx.owner.id !== userId)) {
        return { success: false, error: "Open your personal or team assistant to propose a subscription." };
      }
      const [member] = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, userId))).limit(1);
      if (!member) return { success: false, error: "Sign in as an organization member to propose a subscription." };
      const ownerType = ctx.owner?.type === "team" ? "team" as const : "user" as const;
      const ownerId = ownerType === "team" ? ctx.owner!.id : userId;
      if (ownerType === "team" && (input.delivery_policy !== undefined || input.pause_on_overlap !== undefined)) {
        return { success: false, error: "These delivery preferences apply only to personal subscriptions. Open your personal assistant or omit these fields." };
      }
      if (input.follow === true && (input.event_keys.length !== 1 || input.event_keys[0] !== "slack.app_mention")) {
        return { success: false, error: "Follow is only available for slack.app_mention. Message subscriptions already deliver matching replies." };
      }
      // A mention rule follows its thread by default, as the setup wizard
      // does: Valet answers follow-ups meant for it without a fresh mention.
      const mentionOnly = input.event_keys.length === 1 && input.event_keys[0] === "slack.app_mention";
      const follow = input.follow ?? (mentionOnly ? true : undefined);
      const target = {
        kind: "assistant" as const, assistant: ownerType,
        ...(ownerType === "team" ? { teamId: ownerId } : {}),
        ...(follow !== undefined ? { follow } : {}),
        ...(input.delivery_policy !== undefined ? { deliveryPolicy: input.delivery_policy } : {}),
        ...(input.pause_on_overlap !== undefined ? { pauseOnOverlap: input.pause_on_overlap } : {}),
        ...(input.presence !== undefined ? { appearance: input.presence } : {}),
        ...(input.user_prompt_template !== undefined ? { userPromptTemplate: input.user_prompt_template } : {}),
        ...(input.system_prompt !== undefined ? { systemPrompt: input.system_prompt } : {}),
        ...(input.replaces !== undefined ? { replaces: input.replaces } : {}),
      };
      const write = await validateSubscriptionWrite(db, typeof plugins === "function" ? plugins() : plugins, {
        name: input.name, eventKeys: input.event_keys, filters: input.filters ?? [], target, audience: input.audience,
      }, { creatorUserId: userId, ownerType, anyChannel: input.any_channel === true, matchChanged: true });
      if (!write.ok) return { success: false, error: write.error };
      const now = Date.now();
      const values = {
        id: proposalId("subscription", ctx.orgId, ownerType, ownerId, input.proposal_key),
        orgId: ctx.orgId, ownerType, ownerId, name: input.name, eventKeys: input.event_keys,
        filters: write.filters, target, audience: write.audience ?? null, enabled: false,
        createdBy: userId, createdAt: now, updatedAt: now,
      };
      const insert = async (tx: AppQueryable): Promise<{ error: string } | { row?: EventSubscriptionRow; replaced?: { id: string; name: string } }> => {
        // Only an assistant subscription has versions to replace. A workflow
        // trigger is not one, even when the assistant can list it.
        const findReplaced = async (replacesId: string) => (await tx
          .select({ id: eventSubscriptions.id, name: eventSubscriptions.name, enabled: eventSubscriptions.enabled })
          .from(eventSubscriptions).where(and(eq(eventSubscriptions.id, replacesId), eq(eventSubscriptions.orgId, values.orgId),
            eq(eventSubscriptions.ownerType, ownerType), eq(eventSubscriptions.ownerId, ownerId),
            sql`${eventSubscriptions.target}->>'kind' IN ('assistant', 'orchestrator')`)).limit(1))[0];
        // A repeated proposal key answers with the stored record, whatever
        // happened since to the subscription it replaces.
        const [existing] = await tx.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, values.id)).limit(1);
        if (existing) {
          // Name what the stored proposal replaces, never what this call asks.
          const stored = typeof existing.target === "object" && existing.target !== null ? existing.target : {};
          const link = "replaces" in stored && typeof stored.replaces === "string" ? stored.replaces
            : "replaced" in stored && typeof stored.replaced === "string" ? stored.replaced : undefined;
          const found = link === undefined ? undefined : await findReplaced(link);
          return { row: existing, replaced: found && { id: found.id, name: found.name } };
        }
        let replaced: { id: string; name: string } | undefined;
        if (input.replaces !== undefined) {
          const found = await findReplaced(input.replaces);
          if (!found) return { error: "No assistant subscription with this replaces ID exists in this workspace. Use events.list_subscriptions to find the enabled assistant subscription to replace." };
          // A disabled rule is not the version that replies, so replacing it
          // would leave the live version on.
          if (!found.enabled) {
            return { error: `Subscription "${found.name}" is not enabled. Set replaces to the enabled subscription from events.list_subscriptions.` };
          }
          replaced = { id: found.id, name: found.name };
        }
        const rows = await tx.insert(eventSubscriptions).values(values).onConflictDoNothing().returning();
        return { row: rows[0] ?? (await tx.select().from(eventSubscriptions).where(eq(eventSubscriptions.id, values.id)))[0], replaced };
      };
      const written = ownerType === "team"
        ? await withAuthorizedTeamOwnership(db, { teamId: ownerId, orgId: ctx.orgId, userId, principalTeamId: ownerId, requireMembership: true }, insert)
        : await insert(db);
      if (written && "error" in written) return { success: false, error: written.error };
      const row = written?.row;
      if (!row) return { success: false, error: "Team is no longer available. Open an active team and retry." };
      // A person's enable spends the link: it clears `replaces` and records
      // the ID as `replaced` (PATCH route). A retry of that proposal matches
      // the spent form; a proposal stored with no link never does.
      const { replaces: _spent, ...withoutLink } = target;
      const spentTarget = input.replaces === undefined ? values.target : { ...withoutLink, replaced: input.replaces };
      // A proposal stored before the rename carries the old target names.
      const storedTarget = readStoredTarget(row.target);
      const expected = isDeepStrictEqual(storedTarget, spentTarget) ? spentTarget : values.target;
      if (!isDeepStrictEqual(
        [row.name, row.eventKeys, row.filters, storedTarget, row.audience, row.createdBy],
        [values.name, values.eventKeys, values.filters, expected, values.audience, values.createdBy],
      )) return { success: false, error: "This proposal key already names a different subscription. Use a new proposal_key." };
      return { success: true, data: proposalResult("subscription", row.id, row.enabled, { ...row, target: storedTarget }, written.replaced) };
    },
  });
  const listProblems = action(
    Type.Object({
      event_key: Type.Optional(Type.String({ description: "Normalized event key, such as slack.message." })),
      channel: Type.Optional(Type.String({ description: "Slack channel ID when the received event has one." })),
      text: Type.Optional(Type.String({ description: "Exact redacted event text. Available only to organization admins in private, non-channel sessions." })),
      bot_id: Type.Optional(Type.String({ description: "Slack bot ID when the received event has one. Available only to organization admins in private, non-channel sessions." })),
      since: Type.Optional(Type.Integer({ minimum: MIN_TIMESTAMP, maximum: MAX_TIMESTAMP, description: "Earliest receipt timestamp as a safe epoch-millisecond integer." })),
      until: Type.Optional(Type.Integer({ minimum: MIN_TIMESTAMP, maximum: MAX_TIMESTAMP, description: "Latest receipt timestamp as a safe epoch-millisecond integer." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Maximum records to return. Default ${DEFAULT_LIMIT}; maximum ${MAX_LIMIT}.` })),
    }),
  )({
    id: "events.list_problems",
    name: "List received event problems",
    description:
      "List received events that did not create a workflow run. Filter by normalized event key, Slack channel, receipt time, text, or bot ID. " +
      "Returns the received time, normalized key, raw event metadata, match outcome, and reason. Results are newest first.",
    riskLevel: "low",
    execute: async ({ event_key, channel, text, bot_id, since, until, limit }, ctx) => {
      if (ctx.externalSender) return EXTERNAL_SENDER;
      const userId = ctx.actor?.id ?? ctx.userId;
      if (!userId || !ctx.orgId) return { success: false, error: "No authenticated organization member is available for this event query." };
      if (!timestampIsSafe(since) || !timestampIsSafe(until)) {
        return { success: false, error: "since and until must be safe epoch-millisecond integers." };
      }
      if (since !== undefined && until !== undefined && since > until) {
        return { success: false, error: "since must be earlier than or equal to until." };
      }
      const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers)
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, userId))).limit(1);
      if (!membership) return { success: false, error: "You are not a member of this organization." };
      const canReadAdminMetadata = membership.role === "admin" && !transcriptIsShared(ctx);
      if (!canReadAdminMetadata && (text !== undefined || bot_id !== undefined)) {
        return { success: false, error: "Text and bot ID filters require an organization admin in a private session that did not originate from a channel." };
      }
      const conditions = [eq(eventDropLog.orgId, ctx.orgId)];
      if (!canReadAdminMetadata) conditions.push(ne(eventDropLog.reason, "slack_interaction_unmatched"), ne(eventDropLog.reason, "slack_classifier_rejected"));
      if (event_key !== undefined) conditions.push(eq(eventDropLog.eventKey, event_key));
      if (since !== undefined) conditions.push(gte(eventDropLog.createdAt, since));
      if (until !== undefined) conditions.push(lte(eventDropLog.createdAt, until));
      // JSONB predicates must be part of the SQL query: filtering after LIMIT
      // could hide an older matching diagnostic behind newer unrelated rows.
      if (channel !== undefined) conditions.push(sql`${eventDropLog.eventMetadata}->>'channel' = ${channel}`);
      if (text !== undefined) conditions.push(sql`${eventDropLog.eventMetadata}->>'text' = ${text}`);
      if (bot_id !== undefined) conditions.push(sql`${eventDropLog.eventMetadata}->>'botId' = ${bot_id}`);
      const rows = await db.select().from(eventDropLog).where(and(...conditions))
        .orderBy(desc(eventDropLog.createdAt), desc(eventDropLog.id)).limit(Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      return {
        success: true,
        data: {
          problems: rows.map((row) => {
            const eventMetadata = metadata(row);
            const outputMetadata = canReadAdminMetadata ? eventMetadata : publicMetadata(eventMetadata);
            return {
              id: row.id,
              receivedAt: row.createdAt,
              normalizedEventKey: row.eventKey,
              matchOutcome: matchOutcome(row.reason),
              reason: row.reason,
              detail: row.detail,
              payloadMetadata: outputMetadata,
            };
          }),
          limit: Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT),
        },
      };
    },
  });
  const listLogs = action(Type.Object({
    receipt_id: Type.Optional(Type.String({ description: "Exact receipt reference from Event Logs." })),
    event_key: Type.Optional(Type.String({ description: "Normalized event key, for example slack.message." })),
    channel: Type.Optional(Type.String({ description: "Provider channel ID." })),
    since: Type.Optional(Type.Integer({ minimum: MIN_TIMESTAMP, maximum: MAX_TIMESTAMP })),
    until: Type.Optional(Type.Integer({ minimum: MIN_TIMESTAMP, maximum: MAX_TIMESTAMP })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
  }))({
    id: "events.list_event_logs",
    name: "Inspect event processing logs",
    description: "Read incoming event metadata, classification stages, subscription decisions, and linked event IDs. " +
      "Use events.list_problems for failures before receipt creation. Use workflows.get_run and workflows.get_node_result for workflow execution failures. " +
      "Receipts are retained for up to 7 days; an absent receipt does not prove the provider sent an event. Requires an organization admin in a private, non-channel session.",
    riskLevel: "low",
    execute: async ({ receipt_id, event_key, channel, since, until, limit }, ctx) => {
      if (ctx.externalSender) return EXTERNAL_SENDER;
      const userId = ctx.actor?.id ?? ctx.userId;
      if (!userId || !ctx.orgId || transcriptIsShared(ctx)) return { success: false, error: "Event receipt logs require an organization admin in a private, non-channel session." };
      const [membership] = await db.select({ role: orgMembers.role }).from(orgMembers)
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, userId))).limit(1);
      if (membership?.role !== "admin") return { success: false, error: "Organization admin required." };
      if (!timestampIsSafe(since) || !timestampIsSafe(until) || (since !== undefined && until !== undefined && since > until)) {
        return { success: false, error: "Use safe epoch-millisecond timestamps with since earlier than or equal to until." };
      }
      const conditions = [eq(eventReceipts.orgId, ctx.orgId), gte(eventReceipts.createdAt, Date.now() - RECEIPT_RETENTION_DAYS * 86400000)];
      if (receipt_id !== undefined) conditions.push(eq(eventReceipts.id, receipt_id));
      if (event_key !== undefined) conditions.push(eq(eventReceipts.eventKey, event_key));
      if (channel !== undefined) conditions.push(sql`${eventReceipts.metadata}->>'channelId' = ${channel}`);
      if (since !== undefined) conditions.push(gte(eventReceipts.createdAt, since));
      if (until !== undefined) conditions.push(lte(eventReceipts.createdAt, until));
      const pageLimit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit ?? DEFAULT_LIMIT)));
      const rows = await db.select().from(eventReceipts).where(and(...conditions))
        .orderBy(desc(eventReceipts.createdAt), desc(eventReceipts.id)).limit(pageLimit + 1);
      return { success: true, data: { receipts: rows.slice(0, pageLimit).map(receiptWire), hasMore: rows.length > pageLimit, retentionDays: RECEIPT_RETENTION_DAYS } };
    },
  });
  return { service: "events", description: "Diagnose event delivery, propose disabled subscriptions, and set the reply appearance on existing workspace subscriptions.", actions: [listProblems, listLogs, proposeSubscription, listSubscriptions, setSubscriptionPresence] };
}
