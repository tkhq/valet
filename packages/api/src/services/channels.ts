/**
 * Channels as a workspace sees them: every Slack channel and pull request its
 * runtime talks in, who listens there, and the conversations and messages that
 * link Valet threads to the channel. A channel is derived, never stored.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { assistants, channelMessages, eventSubscriptions, teams } from "../schema/index.js";
import { selectsSlackMention } from "../events/mention-scope.js";
import type {
  ChannelConversation, ChannelDetailResponse, ChannelListener, ChannelMessage, ChannelSummary, ListChannelsResponse,
  ThreadChannel, ThreadPullRequest,
} from "../wire/types.js";
import {
  channelUrl, githubPullRequestKey, parseChannelKey, slackChannelKey, slackConversationFromThreadKey, slackMessageUrl,
} from "./channel-messages.js";
import { parsePullRequestUrl } from "./thread-read-state.js";

/** Resolves Slack channel ids to names. Missing ids keep their id. */
export type ChannelNames = (channelIds: string[]) => Promise<Map<string, string>>;

interface ChannelState {
  summary: ChannelSummary;
  conversations: Map<string, ChannelConversation>;
}

interface Loaded {
  sessionId: string | null;
  channels: Map<string, ChannelState>;
  /** The runtime's threads the viewer may see. */
  shown: Set<string>;
}

/** The session of the workspace's runtime, or null before its first use. */
async function runtimeSessionId(db: AppDb, orgId: string, owner: Principal): Promise<string | null> {
  const [row] = await db.select({ sessionId: assistants.sessionId }).from(assistants)
    .where(and(eq(assistants.orgId, orgId), eq(assistants.ownerType, owner.type), eq(assistants.ownerId, owner.id),
      sql`${assistants.archivedAt} IS NULL`))
    .limit(1);
  return row?.sessionId ?? null;
}

function channelFilterIds(filters: unknown): { ids: string[]; labels: Map<string, string> } {
  const ids: string[] = [];
  const labels = new Map<string, string>();
  if (!Array.isArray(filters)) return { ids, labels };
  for (const filter of filters) {
    if (!filter || typeof filter !== "object") continue;
    const f = filter as { field?: unknown; op?: unknown; value?: unknown; label?: unknown; labels?: unknown };
    // Only an exact match names channels. A prefix, contains, or regex filter
    // reaches channels no id list can show, so the rule reads as broad.
    if (f.field !== "channel" || (f.op !== "eq" && f.op !== "in")) continue;
    const values = (Array.isArray(f.value) ? f.value : [f.value]).filter((v): v is string => typeof v === "string");
    const names = Array.isArray(f.labels) ? f.labels : typeof f.label === "string" ? [f.label] : [];
    values.forEach((id, index) => {
      ids.push(id);
      const name = names[index];
      if (typeof name === "string" && name !== "" && name !== id) labels.set(id, name.replace(/^#/, ""));
    });
  }
  return { ids, labels };
}

function emptyChannel(key: string): ChannelState | null {
  const parsed = parseChannelKey(key);
  if (!parsed) return null;
  const url = channelUrl(key);
  return {
    summary: {
      key,
      provider: parsed.provider,
      name: parsed.provider === "slack" ? parsed.channelId : `${parsed.repo} #${parsed.number}`,
      ...(url ? { url } : {}),
      listeners: [],
      conversationCount: 0,
      messageCount: 0,
      lastActivityAt: null,
    },
    conversations: new Map(),
  };
}

function touch(state: ChannelState, at: number | null): void {
  if (at !== null && (state.summary.lastActivityAt === null || at > state.summary.lastActivityAt)) {
    state.summary.lastActivityAt = at;
  }
}

async function loadChannels(db: AppDb, orgId: string, owner: Principal, names: ChannelNames, threadsShown: ThreadsShown): Promise<Loaded> {
  const sessionId = await runtimeSessionId(db, orgId, owner);
  const channels = new Map<string, ChannelState>();
  const channelFor = (key: string): ChannelState | null => {
    const existing = channels.get(key);
    if (existing) return existing;
    const created = emptyChannel(key);
    if (created) channels.set(key, created);
    return created;
  };
  const addConversation = (state: ChannelState, conversation: ChannelConversation) => {
    const id = `${conversation.sessionId}:${conversation.threadId}`;
    const existing = state.conversations.get(id);
    if (!existing || conversation.lastActivityAt > existing.lastActivityAt) {
      state.conversations.set(id, { ...conversation, url: conversation.url ?? existing?.url });
    }
    touch(state, conversation.lastActivityAt);
  };

  // Listeners: every enabled mention rule with an orchestrator target. The
  // workspace's own rules add their channels; other rules only annotate a
  // channel the workspace already talks in.
  const rules = await db.select().from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));
  const teamRows = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.orgId, orgId));
  const teamNames = new Map(teamRows.map((row) => [row.id, row.name]));
  const labels = new Map<string, string>();
  const listenerRows: Array<{ listener: ChannelListener; channelIds: string[] }> = [];
  for (const rule of rules) {
    const keys = Array.isArray(rule.eventKeys) ? rule.eventKeys.filter((k): k is string => typeof k === "string") : [];
    const target = rule.target as { kind?: unknown } | null;
    if (!selectsSlackMention(keys) || target?.kind !== "orchestrator") continue;
    const { ids, labels: ruleLabels } = channelFilterIds(rule.filters);
    for (const [id, label] of ruleLabels) labels.set(id, label);
    const own = rule.ownerType === owner.type && rule.ownerId === owner.id;
    const ownerName = rule.ownerType === "team" ? teamNames.get(rule.ownerId) ?? "Another team"
      : rule.ownerType === "org" ? "Organization" : own ? "Personal" : "A personal Valet";
    listenerRows.push({
      listener: {
        subscriptionId: rule.id, ownerType: rule.ownerType, ownerId: rule.ownerId, ownerName,
        everywhere: ids.length === 0, editable: own,
      },
      channelIds: ids,
    });
    if (own) for (const id of ids) channelFor(slackChannelKey(id));
  }

  let shown = new Set<string>();
  if (sessionId) {
    // Slack conversations: the runtime's threads keyed by a Slack thread.
    const slackThreads = await db.execute(sql`
      SELECT et.id, et.key, et.updated_at, st.title FROM engine_threads et
      LEFT JOIN session_threads st ON st.session_id = et.session_id AND st.id = et.id
      WHERE et.session_id = ${sessionId} AND et.key LIKE 'slack:%' AND st.archived_at IS NULL`) as {
      rows: Array<{ id: string; key: string; updated_at: string | number; title: string | null }>;
    };
    // The runtime's threads this viewer may see; another person's helper
    // thread or a private channel's thread adds nothing (`thread-access.ts`).
    const ids = (await db.execute(sql`SELECT id FROM engine_threads WHERE session_id = ${sessionId}`) as { rows: Array<{ id: string }> }).rows.map((row) => row.id);
    shown = await threadsShown(sessionId, ids);
    for (const row of slackThreads.rows) {
      if (!shown.has(row.id)) continue;
      const conversation = slackConversationFromThreadKey(row.key);
      const state = conversation ? channelFor(slackChannelKey(conversation.channelId)) : null;
      if (!conversation || !state) continue;
      addConversation(state, {
        sessionId, threadId: row.id, title: row.title || "Slack thread",
        url: slackMessageUrl(conversation.channelId, conversation.threadTs), lastActivityAt: Number(row.updated_at),
      });
    }

    // Pull requests the runtime's threads opened.
    const pullRequests = await db.execute(sql`
      SELECT pr.thread_id, pr.url, pr.state, pr.updated_at, st.title FROM thread_pull_requests pr
      LEFT JOIN session_threads st ON st.session_id = pr.session_id AND st.id = pr.thread_id
      WHERE pr.session_id = ${sessionId}`) as {
      rows: Array<{ thread_id: string; url: string; state: "open" | "merged" | "closed"; updated_at: string | number; title: string | null }>;
    };
    for (const row of pullRequests.rows) {
      if (!shown.has(row.thread_id)) continue;
      const parsed = parsePullRequestUrl(row.url);
      if (!parsed) continue;
      const state = channelFor(githubPullRequestKey(parsed.owner, parsed.repo, parsed.number));
      if (!state) continue;
      state.summary.url = row.url;
      state.summary.state = row.state;
      addConversation(state, {
        sessionId, threadId: row.thread_id, title: row.title || `Pull request #${parsed.number}`,
        url: row.url, lastActivityAt: Number(row.updated_at),
      });
    }

    // Recorded messages, and the threads that sent or received them.
    const recorded = await db.execute(sql`
      SELECT cm.channel_key, cm.thread_id, cm.conversation_key, COUNT(*)::int AS count, MAX(cm.created_at) AS last_at,
        st.title
      FROM channel_messages cm
      LEFT JOIN session_threads st ON st.session_id = cm.session_id AND st.id = cm.thread_id
      WHERE cm.org_id = ${orgId} AND cm.session_id = ${sessionId}
      GROUP BY cm.channel_key, cm.thread_id, cm.conversation_key, st.title`) as {
      rows: Array<{ channel_key: string; thread_id: string; conversation_key: string; count: number; last_at: string | number; title: string | null }>;
    };
    for (const row of recorded.rows) {
      if (!shown.has(row.thread_id)) continue;
      const state = channelFor(row.channel_key);
      if (!state) continue;
      state.summary.messageCount += Number(row.count);
      const conversation = slackConversationFromThreadKey(row.conversation_key);
      addConversation(state, {
        sessionId, threadId: row.thread_id, title: row.title || "Conversation",
        ...(conversation ? { url: slackMessageUrl(conversation.channelId, conversation.threadTs) } : {}),
        lastActivityAt: Number(row.last_at),
      });
    }
  }

  for (const { listener, channelIds } of listenerRows) {
    for (const state of channels.values()) {
      if (state.summary.provider !== "slack") continue;
      const parsed = parseChannelKey(state.summary.key);
      if (parsed?.provider !== "slack") continue;
      if (listener.everywhere || channelIds.includes(parsed.channelId)) state.summary.listeners.push(listener);
    }
  }

  const slackIds = [...channels.values()].flatMap((state) => {
    const parsed = parseChannelKey(state.summary.key);
    return parsed?.provider === "slack" ? [parsed.channelId] : [];
  });
  const resolved = slackIds.length > 0 ? await names(slackIds).catch(() => new Map<string, string>()) : new Map<string, string>();
  for (const state of channels.values()) {
    const parsed = parseChannelKey(state.summary.key);
    if (parsed?.provider !== "slack") continue;
    const name = resolved.get(parsed.channelId) ?? labels.get(parsed.channelId);
    state.summary.name = name ? `#${name.replace(/^#/, "")}` : parsed.channelId;
  }
  for (const state of channels.values()) state.summary.conversationCount = state.conversations.size;
  return { sessionId, channels, shown };
}

/** Whether the viewer may see a channel. A private Slack channel takes membership. */
export type ChannelVisibility = (key: string) => Promise<boolean>;
/** Of a runtime's threads, the ids the viewer may see. */
export type ThreadsShown = (sessionId: string, threadIds: string[]) => Promise<Set<string>>;

/** The channels a workspace talks or listens in, most recent first. */
export async function listChannels(
  db: AppDb, orgId: string, owner: Principal, names: ChannelNames, canSee: ChannelVisibility, threadsShown: ThreadsShown,
): Promise<ListChannelsResponse> {
  const { channels } = await loadChannels(db, orgId, owner, names, threadsShown);
  const all = [...channels.values()].map((state) => state.summary);
  const visible = await Promise.all(all.map((row) => canSee(row.key)));
  const rows = all.filter((_, index) => visible[index]);
  rows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
  return { channels: rows };
}

/** One channel: its summary, conversations, and newest messages. Null when unknown. */
export async function getChannel(
  db: AppDb, orgId: string, owner: Principal, key: string, names: ChannelNames, canSee: ChannelVisibility, threadsShown: ThreadsShown, limit = 50,
): Promise<ChannelDetailResponse | null> {
  if (!parseChannelKey(key) || !(await canSee(key))) return null;
  const { sessionId, channels, shown } = await loadChannels(db, orgId, owner, names, threadsShown);
  const state = channels.get(key);
  if (!state) return null;
  const messages: ChannelMessage[] = sessionId
    ? (await db.select().from(channelMessages)
      .where(and(eq(channelMessages.orgId, orgId), eq(channelMessages.sessionId, sessionId), eq(channelMessages.channelKey, key),
        inArray(channelMessages.threadId, [...shown])))
      .orderBy(desc(channelMessages.createdAt))
      .limit(limit)).map((row) => ({
        id: row.id, sessionId: row.sessionId, threadId: row.threadId, channelKey: row.channelKey,
        direction: row.direction, author: row.author, text: row.text, url: row.url, createdAt: row.createdAt,
      }))
    : [];
  const conversations = [...state.conversations.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { channel: state.summary, conversations, messages };
}

/** The channel a thread talks in, from its key or the newest pull request it opened. */
export function threadChannel(key: string | undefined, pullRequests: readonly ThreadPullRequest[] | undefined): ThreadChannel | undefined {
  const conversation = slackConversationFromThreadKey(key);
  if (conversation) {
    return {
      key: slackChannelKey(conversation.channelId), provider: "slack",
      conversationUrl: slackMessageUrl(conversation.channelId, conversation.threadTs),
    };
  }
  const newest = pullRequests?.at(-1);
  const parsed = newest ? parsePullRequestUrl(newest.url) : null;
  if (!newest || !parsed) return undefined;
  return { key: githubPullRequestKey(parsed.owner, parsed.repo, parsed.number), provider: "github", conversationUrl: newest.url };
}
