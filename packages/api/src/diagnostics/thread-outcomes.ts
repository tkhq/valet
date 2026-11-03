/**
 * Per-thread session outcomes for the friction scan. The Usage page shows
 * outcome counts only; this read returns the threads behind the counts, so
 * an agent can say where people got stuck and link the threads.
 *
 * It reads labels the session-outcome tagger already wrote, plus the
 * thread's tool calls in the same window. Transcript text is limited to a
 * thread title and a short excerpt of the first request, and only for
 * threads the caller can open. The caller decides scope and visibility.
 */
import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { formatTranscriptText } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { externalCalls, teams, users } from "../schema/index.js";
import { readRegistry } from "../tagging/registry.js";
import { intentJoins, intentKey } from "../tagging/usage.js";

/** Every outcome except `completed`. */
export const FRICTION_OUTCOMES = ["failed", "partial", "abandoned", "blocked_on_human", "unclear", "other"] as const;
/** Friction threads read per call. Groups count all of them; `threads` returns `limit`. */
const MAX_SCAN = 500;
const MAX_GROUPS = 25;
const LINKS_PER_GROUP = 5;
const CODES_PER_THREAD = 3;
const TITLE_CHARS = 120;
export const EXCERPT_CHARS = 160;

export type OutcomeScope = { kind: "organization" } | { kind: "team"; teamId: string };

export interface Person {
  kind: "user" | "team";
  id: string;
  name: string;
}

export interface Intent {
  key: string;
  label: string;
}

/** One labeled thread, before visibility decides about text. */
export interface OutcomeThreadRow {
  sessionId: string;
  threadId: string;
  outcome: string;
  classifiedAt: number;
  userId: string;
  ownerType: string;
  ownerId: string;
  child: boolean;
}

/** One group of tool calls in one thread, as SQL returns it. */
export interface ThreadCallRow {
  sessionId: string;
  threadId: string;
  tool: string;
  outcome: string;
  errorCode: string | null;
  intent: string | null;
  calls: number;
}

export interface FrictionThread {
  threadId: string;
  sessionId: string;
  link: string;
  outcome: string;
  classifiedAt: number;
  workspace: "personal" | "team";
  person: Person;
  child: boolean;
  intent: Intent;
  toolCalls: number;
  toolErrors: number;
  errorCodes: Array<{ tool: string; code: string; calls: number }>;
  canOpen: boolean;
  title?: string;
  excerpt?: string;
}

export interface FrictionGroup {
  person: Person;
  intent: Intent;
  threads: number;
  outcomes: Record<string, number>;
  toolErrors: number;
  links: string[];
}

const NO_TOOL_CALLS: Intent = { key: "no_tool_calls", label: "No tool calls" };
const UNLABELED: Intent = { key: "unlabeled", label: "Unlabeled tool calls" };

function personKey(person: Person): string {
  return `${person.kind}:${person.id}`;
}

/** The person a thread belongs to: its member, or the team for an unattended team run. */
export function threadPerson(row: Pick<OutcomeThreadRow, "userId" | "ownerType" | "ownerId">, names: ReadonlyMap<string, string>): Person {
  if (row.userId && !row.userId.startsWith("team:")) return { kind: "user", id: row.userId, name: names.get(`user:${row.userId}`) ?? row.userId };
  const teamId = row.ownerType === "team" ? row.ownerId : row.userId.slice("team:".length);
  return { kind: "team", id: teamId, name: names.get(`team:${teamId}`) ?? teamId };
}

/**
 * Per-thread tool counts and the thread's main intent: the intent key with
 * the most calls, ties broken by key so the result is stable.
 */
export function summarizeThreadCalls(rows: readonly ThreadCallRow[], intentLabels: ReadonlyMap<string, string>) {
  const out = new Map<string, { toolCalls: number; toolErrors: number; errorCodes: FrictionThread["errorCodes"]; intent: Intent }>();
  const byThread = new Map<string, ThreadCallRow[]>();
  for (const row of rows) {
    const id = `${row.sessionId}:${row.threadId}`;
    byThread.set(id, [...(byThread.get(id) ?? []), row]);
  }
  for (const [id, calls] of byThread) {
    const intents = new Map<string, number>();
    const codes = new Map<string, { tool: string; code: string; calls: number }>();
    let toolCalls = 0;
    let toolErrors = 0;
    for (const row of calls) {
      toolCalls += row.calls;
      if (row.intent) intents.set(row.intent, (intents.get(row.intent) ?? 0) + row.calls);
      if (row.outcome !== "error") continue;
      toolErrors += row.calls;
      const code = row.errorCode ?? "unspecified";
      const prior = codes.get(`${row.tool}\u0000${code}`);
      codes.set(`${row.tool}\u0000${code}`, { tool: row.tool, code, calls: (prior?.calls ?? 0) + row.calls });
    }
    const [top] = [...intents].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.set(id, {
      toolCalls, toolErrors,
      errorCodes: [...codes.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)).slice(0, CODES_PER_THREAD),
      intent: top ? { key: top[0], label: intentLabels.get(top[0]) ?? top[0] } : toolCalls > 0 ? UNLABELED : NO_TOOL_CALLS,
    });
  }
  return out;
}

/**
 * Group threads by person and intent. Larger groups come first, then the
 * groups with more tool errors. Links keep the threads' newest-first order.
 */
export function groupFrictionThreads(threads: readonly FrictionThread[]): FrictionGroup[] {
  const groups = new Map<string, FrictionGroup>();
  for (const thread of threads) {
    const id = `${personKey(thread.person)}\u0000${thread.intent.key}`;
    const group = groups.get(id) ?? { person: thread.person, intent: thread.intent, threads: 0, outcomes: {}, toolErrors: 0, links: [] };
    group.threads += 1;
    group.outcomes[thread.outcome] = (group.outcomes[thread.outcome] ?? 0) + 1;
    group.toolErrors += thread.toolErrors;
    if (group.links.length < LINKS_PER_GROUP) group.links.push(thread.link);
    groups.set(id, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.threads - a.threads || b.toolErrors - a.toolErrors || a.person.name.localeCompare(b.person.name))
    .slice(0, MAX_GROUPS);
}

/** Collapse whitespace and cap a request excerpt at {@link EXCERPT_CHARS}. */
export function excerptOf(content: string): string | undefined {
  const text = formatTranscriptText(content.trim()).replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS - 1)}…` : text;
}

function pairsSql(pairs: ReadonlyArray<{ sessionId: string; threadId: string }>): SQL {
  return sql.join(pairs.map((pair) => sql`(${pair.sessionId}, ${pair.threadId})`), sql`, `);
}

function scopeSql(scope: OutcomeScope): SQL {
  return scope.kind === "team" ? sql`AND s.owner_type = 'team' AND s.owner_id = ${scope.teamId}` : sql``;
}

const LABELED_THREADS = sql`FROM tag_labels l
  JOIN tag_subjects subject ON subject.org_id = l.org_id AND subject.dimension = l.dimension
    AND subject.subject_type = l.subject_type AND subject.subject_id = l.subject_id
  JOIN engine_threads t ON t.session_id = subject.session_id AND t.id = subject.thread_id
  JOIN agent_sessions s ON s.id = t.session_id AND s.org_id = l.org_id`;

export interface ReadThreadOutcomesOpts {
  orgId: string;
  scope: OutcomeScope;
  since: number;
  until: number;
  outcomes: readonly string[];
  /** Whether provisional tool-intent keys are shown by name (organization admins). */
  canManageIntents: boolean;
}

/**
 * The outcome counts for every key, and up to {@link MAX_SCAN} labeled
 * threads with one of `outcomes`, newest first, with their tool calls.
 * Same thread rules as the Usage card: no deleted sessions, no workflow
 * steps, child-session threads included.
 */
export async function readThreadOutcomes(db: AppDb, opts: ReadThreadOutcomesOpts) {
  const where = sql`WHERE l.org_id = ${opts.orgId} AND l.dimension = 'session_outcome' AND l.subject_type = 'session_thread'
    AND s.status <> 'deleted' AND s.id NOT LIKE 'wf:%'
    AND l.classified_at >= ${opts.since} AND l.classified_at < ${opts.until} ${scopeSql(opts.scope)}`;
  const counts = await db.execute(sql`SELECT l.key, count(*)::int AS threads ${LABELED_THREADS} ${where} GROUP BY l.key`) as {
    rows: Array<{ key: string; threads: unknown }>;
  };
  const wanted = opts.outcomes.length ? sql`AND l.key IN (${sql.join(opts.outcomes.map((key) => sql`${key}`), sql`, `)})` : sql`AND false`;
  const labeled = await db.execute(sql`SELECT l.key AS outcome, l.classified_at AS "classifiedAt", s.id AS "sessionId", t.id AS "threadId",
      s.user_id AS "userId", s.owner_type AS "ownerType", s.owner_id AS "ownerId",
      EXISTS (SELECT 1 FROM child_watches c WHERE c.child_session_id = s.id) AS child
    ${LABELED_THREADS} ${where} ${wanted}
    ORDER BY l.classified_at DESC, t.id LIMIT ${MAX_SCAN + 1}`) as { rows: Array<Omit<OutcomeThreadRow, "classifiedAt"> & { classifiedAt: unknown }> };
  const truncated = labeled.rows.length > MAX_SCAN;
  const threads: OutcomeThreadRow[] = labeled.rows.slice(0, MAX_SCAN).map((row) => ({ ...row, classifiedAt: Number(row.classifiedAt) }));

  const registry = await readRegistry(db, opts.orgId, "tool_intent");
  const join = intentJoins(registry, opts.orgId, opts.canManageIntents);
  const calls: ThreadCallRow[] = threads.length === 0 ? [] : (await db.select({
    sessionId: sql<string>`${externalCalls.sessionId}`, threadId: sql<string>`${externalCalls.threadId}`,
    tool: externalCalls.name, outcome: externalCalls.outcome, errorCode: externalCalls.errorCode,
    intent: intentKey, calls: sql<number>`count(*)`.mapWith(Number),
  }).from(externalCalls).leftJoin(join.join, join.on)
    .where(and(eq(externalCalls.orgId, opts.orgId), gte(externalCalls.createdAt, opts.since), lt(externalCalls.createdAt, opts.until),
      sql`(${externalCalls.sessionId}, ${externalCalls.threadId}) IN (${pairsSql(threads)})`))
    .groupBy(externalCalls.sessionId, externalCalls.threadId, externalCalls.name, externalCalls.outcome, externalCalls.errorCode, intentKey));
  const intentLabels = new Map<string, string>([["__emerging", "Emerging"], ...registry.map((key) => [key.key, key.label] as [string, string])]);

  const userIds = [...new Set(threads.filter((row) => row.userId && !row.userId.startsWith("team:")).map((row) => row.userId))];
  const teamIds = [...new Set(threads.map((row) => threadPerson(row, new Map())).filter((person) => person.kind === "team").map((person) => person.id))];
  const names = new Map<string, string>();
  if (userIds.length) {
    for (const row of await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, userIds))) {
      names.set(`user:${row.id}`, row.name || row.email);
    }
  }
  if (teamIds.length) {
    for (const row of await db.select({ id: teams.id, name: teams.name }).from(teams).where(and(eq(teams.orgId, opts.orgId), inArray(teams.id, teamIds)))) {
      names.set(`team:${row.id}`, row.name);
    }
  }
  const outcomeRegistry = await readRegistry(db, opts.orgId, "session_outcome");
  return {
    counts: counts.rows.map((row) => ({ key: row.key, label: outcomeRegistry.find((key) => key.key === row.key)?.label ?? row.key, threads: Number(row.threads) })),
    threads, truncated, calls: summarizeThreadCalls(calls, intentLabels), names,
  };
}

/** Title and first-request excerpt for threads the caller may open. */
export async function readThreadText(db: AppDb, pairs: ReadonlyArray<{ sessionId: string; threadId: string }>) {
  const text = new Map<string, { title?: string; excerpt?: string }>();
  if (pairs.length === 0) return text;
  const titles = await db.execute(sql`SELECT session_id AS "sessionId", id AS "threadId", metadata FROM engine_threads
    WHERE (session_id, id) IN (${pairsSql(pairs)})`) as { rows: Array<{ sessionId: string; threadId: string; metadata: string | null }> };
  for (const row of titles.rows) {
    let metadata: unknown;
    try { metadata = JSON.parse(row.metadata ?? "null"); } catch { metadata = null; }
    const title = typeof metadata === "object" && metadata !== null && "title" in metadata && typeof metadata.title === "string"
      ? metadata.title.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS) : undefined;
    if (title) text.set(`${row.sessionId}:${row.threadId}`, { title });
  }
  // Only the first EXCERPT_CHARS of the request survive; read a little more
  // than that so whitespace collapse still fills the excerpt.
  const firsts = await db.execute(sql`SELECT DISTINCT ON (session_id, thread_id) session_id AS "sessionId", thread_id AS "threadId",
      left(content, ${EXCERPT_CHARS * 4}) AS content
    FROM engine_entries WHERE (session_id, thread_id) IN (${pairsSql(pairs)})
      AND entry_type = 'message' AND role = 'user' AND content <> ''
    ORDER BY session_id, thread_id, created_at, seq`) as { rows: Array<{ sessionId: string; threadId: string; content: string | null }> };
  for (const row of firsts.rows) {
    const excerpt = excerptOf(row.content ?? "");
    if (!excerpt) continue;
    const id = `${row.sessionId}:${row.threadId}`;
    text.set(id, { ...text.get(id), excerpt });
  }
  return text;
}
