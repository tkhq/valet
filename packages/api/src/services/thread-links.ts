/**
 * Threads that forks and moves connect, and the audience rule for sending
 * content from one to another (docs/specs/2026-10-22-thread-edit-fork-design.md).
 *
 * A fork records the thread it came from (`metadata.forkOf`); a moved
 * thread records where it went (`metadata.movedTo`). Two threads linked by a
 * fork may message each other. A message never reaches people who could not
 * read the sending thread unless a person approves it: `sendWidens` decides.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ThreadData } from "@valet/engine";
import type { Providers } from "../providers/types.js";
import { agentSessions, sessionThreads, teams } from "../schema/index.js";
import { isTeamMember } from "./teams.js";
import { threadAudience, visibleThreadIds, type AccessDeps } from "./thread-access.js";

/** Engine thread metadata: the thread this fork was copied from. */
export const FORK_OF_METADATA_KEY = "forkOf";
/** Engine thread metadata: the thread a move copied this thread into. */
export const MOVED_TO_METADATA_KEY = "movedTo";

export interface ThreadAt { sessionId: string; threadId: string }

/** Who reads a thread: one person, or a team narrowed by Slack channel gates. */
export type ThreadReaders =
  | { kind: "person"; userId: string }
  | { kind: "team"; teamId: string; channels: string[] };

export interface ThreadOwner { ownerType: "user" | "team"; ownerId: string; orgId: string }

/** The workspace that owns a thread's session, or null for any other session (a workflow run, a child). */
export async function threadOwner(db: Providers["db"], sessionId: string): Promise<ThreadOwner | null> {
  const [row] = await db.select({ ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId, userId: agentSessions.userId, orgId: agentSessions.orgId })
    .from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  if (!row || (row.ownerType !== "user" && row.ownerType !== "team")) return null;
  return { ownerType: row.ownerType, ownerId: row.ownerId || row.userId, orgId: row.orgId };
}

/** Who reads a thread, by the rules the read gate uses (`threadVisibility`). */
export async function threadReaders(db: Providers["db"], owner: ThreadOwner, at: ThreadAt): Promise<ThreadReaders> {
  if (owner.ownerType === "user") return { kind: "person", userId: owner.ownerId };
  const audience = await threadAudience(db, at.sessionId, at.threadId);
  if (audience.privateTo !== undefined) return { kind: "person", userId: audience.privateTo };
  return { kind: "team", teamId: owner.ownerId, channels: audience.channels };
}

/** Whether `userId` may read the thread now: its owner, or a team member the thread's gates admit. */
export async function userCanReadThread(deps: AccessDeps, user: { id: string; orgId: string }, owner: ThreadOwner, at: ThreadAt): Promise<boolean> {
  if (owner.orgId !== user.orgId) return false;
  if (owner.ownerType === "user") return owner.ownerId === user.id;
  if (!await isTeamMember(deps.db, owner.ownerId, user.id)) return false;
  const shown = await visibleThreadIds(deps, { ownerType: "team" }, { orgId: user.orgId, userId: user.id }, [at]);
  return shown.has(`${at.sessionId}:${at.threadId}`);
}

/**
 * Whether content from `from` would reach a reader of `to` who cannot read
 * `from`. A person's thread is read by that person only, so content may go
 * there when the person reads the source. A team thread is read by the team
 * through its channel gates, so content may go there only from a thread of
 * the same team that every one of those readers can already read: one whose
 * gates `to` keeps.
 */
export async function sendWidens(deps: AccessDeps, from: { owner: ThreadOwner; at: ThreadAt; readers: ThreadReaders }, to: ThreadReaders): Promise<boolean> {
  if (to.kind === "person") {
    if (from.readers.kind === "person") return from.readers.userId !== to.userId;
    return !await userCanReadThread(deps, { id: to.userId, orgId: from.owner.orgId }, from.owner, from.at);
  }
  if (from.readers.kind !== "team" || from.readers.teamId !== to.teamId) return true;
  return from.readers.channels.some((channel) => !to.channels.includes(channel));
}

/** A thread's lineage link, read from its engine metadata. */
function linkFrom(metadata: Record<string, unknown> | null | undefined, key: typeof FORK_OF_METADATA_KEY | typeof MOVED_TO_METADATA_KEY): ThreadAt | undefined {
  const value = metadata?.[key];
  if (!value || typeof value !== "object") return undefined;
  const { sessionId, threadId } = value as Record<string, unknown>;
  return typeof sessionId === "string" && typeof threadId === "string" ? { sessionId, threadId } : undefined;
}

export interface LinkedThread extends ThreadAt {
  /** How this thread relates to the asking one. */
  relation: "source" | "fork";
  title: string | null;
  owner: ThreadOwner;
}

/**
 * The threads linked to `at` by a fork: the thread it was copied from, and
 * the forks copied from it. A thread with no engine row or no workspace
 * owner is left out.
 */
export async function linkedThreads(db: Providers["db"], thread: ThreadData): Promise<LinkedThread[]> {
  const links: Array<ThreadAt & { relation: LinkedThread["relation"] }> = [];
  const source = linkFrom(thread.metadata, FORK_OF_METADATA_KEY);
  if (source) links.push({ ...source, relation: "source" });
  const forks = await db.execute(sql`SELECT session_id, id FROM engine_threads
    WHERE metadata IS NOT NULL AND metadata::jsonb -> ${FORK_OF_METADATA_KEY} ->> 'threadId' = ${thread.id}
      AND metadata::jsonb -> ${FORK_OF_METADATA_KEY} ->> 'sessionId' = ${thread.sessionId}
    ORDER BY created_at LIMIT 50`) as { rows: Array<{ session_id: string; id: string }> };
  for (const row of forks.rows) links.push({ sessionId: row.session_id, threadId: row.id, relation: "fork" });
  if (links.length === 0) return [];
  const titles = await db.select({ id: sessionThreads.id, title: sessionThreads.title }).from(sessionThreads)
    .where(inArray(sessionThreads.id, links.map((link) => link.threadId)));
  const out: LinkedThread[] = [];
  for (const link of links) {
    const owner = await threadOwner(db, link.sessionId);
    if (!owner) continue;
    out.push({ ...link, owner, title: titles.find((row) => row.id === link.threadId)?.title ?? null });
  }
  return out;
}

/** The name a person sees for a thread's workspace: "your private threads", or the team's name. */
export async function workspaceName(db: Providers["db"], owner: ThreadOwner, viewerId?: string): Promise<string> {
  if (owner.ownerType === "user") return owner.ownerId === viewerId ? "your private threads" : "a teammate's private threads";
  const [team] = await db.select({ name: teams.name }).from(teams).where(and(eq(teams.id, owner.ownerId), eq(teams.orgId, owner.orgId))).limit(1);
  return team?.name ?? "a team";
}
