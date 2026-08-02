/**
 * Centralized session-meta loading (GitHub/repo integration plan, Task 9 fix
 * round 1).
 *
 * `EngineHost.sessionFor(sessionId, meta)` builds the engine session ONCE per
 * cache lifetime, on the FIRST touch for a given id — and only that first
 * `meta` decides whether `prepareSandbox` (repo clone) is wired. Every later
 * call is a cache hit that ignores `meta` entirely.
 *
 * The web flow's first touch is the WS route (the browser opens the event
 * stream BEFORE it POSTs the first prompt). If any first-touch caller assembles
 * a partial `meta` (no `repos`), the session caches a prep-less attachment and
 * repo-bound sessions never clone — the later repos-carrying `/messages` call
 * arrives too late to matter.
 *
 * The fix: EVERY `sessionFor` caller assembles the COMPLETE meta via this one
 * function, so repo bindings + git identity survive whichever route touches the
 * session first. Lifted verbatim from what `messages.ts`'s `loadEngineSession`
 * used to assemble inline.
 */
import { eq } from "drizzle-orm";
import type { SessionMeta } from "./host.js";
import type { AppDb } from "../lib/drizzle.js";
import { sessionRepos, users } from "../schema/index.js";

/**
 * Minimal identity a session meta is assembled around. The app session row
 * (`agentSessions.$inferSelect`) satisfies this structurally, so route callers
 * pass their already-loaded row directly. Orchestrator/child callers that only
 * hold an engine-store `SessionData` construct this from the id + that data
 * (they carry no repos and no `profile`, so the loader returns empty bindings
 * and leaves `profile` unset — headless default — preserving their semantics).
 */
export interface SessionMetaSource {
  id: string;
  userId: string;
  orgId: string;
  workspace: string;
  /** Present on the app row; omitted by orchestrator/child callers (headless). */
  profile?: "headless" | "full";
}

/**
 * Assemble the COMPLETE {@link SessionMeta} for a session: identity + profile
 * from `src`, plus repo bindings (from `session_repos`, in position order) and
 * git identity (from `users`). Returns empty/absent bindings when the session
 * has none — an orchestrator or unbound session then gets credential-only
 * prep (helper + `gh` shim, no clones) instead of the full workspace prep.
 */
export async function loadSessionMeta(db: AppDb, src: SessionMetaSource): Promise<SessionMeta> {
  const [repoRows, userRows] = await Promise.all([
    db.select().from(sessionRepos).where(eq(sessionRepos.sessionId, src.id)).orderBy(sessionRepos.position),
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, src.userId)).limit(1),
  ]);

  return {
    userId: src.userId,
    orgId: src.orgId,
    workspace: src.workspace,
    ...(src.profile !== undefined ? { profile: src.profile } : {}),
    repos: repoRows.length
      ? repoRows.map((r) => ({
          host: r.host,
          fullName: r.fullName,
          cloneUrl: r.cloneUrl,
          ref: r.ref ?? undefined,
          auth: r.auth,
        }))
      : undefined,
    userName: userRows[0]?.name,
    userEmail: userRows[0]?.email,
  };
}
