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
import { computeTargetDirs } from "./workspace-prep.js";
import type { RepoBinding } from "../wire/types.js";

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
  /** Force Docker sandbox backend. Omitted by orchestrator/child callers. */
  docker?: boolean;
}

/**
 * Target dirs for sessions created BEFORE spec decision 15 (target_dir NULL
 * rows). Preserves the pre-change layout so convergence never relocates an
 * existing clone: single repo → workspace root "."; multiple repos → plain
 * repo name subdirs (with collision disambiguation, matching the old
 * computeTargetDirs behavior). Used ONLY for null target_dir rows.
 */
function legacyTargetDirs(repos: RepoBinding[]): string[] {
  // Sessions predating decision 15 keep root layout; convergence must not relocate.
  if (repos.length === 1) return ["."];
  return computeTargetDirs(repos);
}

/**
 * Assemble the COMPLETE {@link SessionMeta} for a session: identity + profile
 * from `src`, plus repo bindings (from `session_repos`, in position order) and
 * git identity (from `users`). Returns empty/absent bindings when the session
 * has none — an orchestrator or unbound session then gets credential-only
 * prep (helper + `gh` shim, no clones) instead of the full workspace prep.
 *
 * Each repo binding carries `targetDir`: the workspace-relative clone dir,
 * read verbatim from the persisted `target_dir` column (spec decision 15).
 * Rows with a NULL `target_dir` (sessions predating the decision) fall back
 * to `legacyTargetDirs` so their existing clones are never relocated.
 */
export async function loadSessionMeta(db: AppDb, src: SessionMetaSource): Promise<SessionMeta> {
  const [repoRows, userRows] = await Promise.all([
    db.select().from(sessionRepos).where(eq(sessionRepos.sessionId, src.id)).orderBy(sessionRepos.position),
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, src.userId)).limit(1),
  ]);

  let reposWithDirs: (RepoBinding & { targetDir: string })[] | undefined;
  if (repoRows.length > 0) {
    const bindings: RepoBinding[] = repoRows.map((r) => ({
      host: r.host,
      fullName: r.fullName,
      cloneUrl: r.cloneUrl,
      ref: r.ref ?? undefined,
      auth: r.auth,
    }));
    // Check whether any row is missing a target_dir (legacy session).
    const hasNullDirs = repoRows.some((r) => r.targetDir === null || r.targetDir === undefined);
    const fallbackDirs = hasNullDirs ? legacyTargetDirs(bindings) : [];
    reposWithDirs = repoRows.map((r, i) => ({
      ...bindings[i]!,
      targetDir: r.targetDir ?? fallbackDirs[i] ?? ".",
    }));
  }

  return {
    userId: src.userId,
    orgId: src.orgId,
    workspace: src.workspace,
    ...(src.profile !== undefined ? { profile: src.profile } : {}),
    ...(src.docker !== undefined ? { docker: src.docker } : {}),
    repos: reposWithDirs,
    userName: userRows[0]?.name,
    userEmail: userRows[0]?.email,
  };
}
