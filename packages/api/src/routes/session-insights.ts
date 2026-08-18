/**
 * Two read-only views of one session, both ported from V1 (backlog #8 and
 * #4) and both served from state the engine already keeps:
 *
 *   GET /api/sessions/:id/log            → the session's lifecycle and tool log
 *   GET /api/sessions/:id/files-changed  → the files the session wrote to
 *
 * Neither route touches a sandbox. The log reads `engine_events`, which the
 * engine appends to on every event it emits; the file list reads the diffs
 * `capturePatch` already stored in the blob store at settle time. That is
 * what lets both answer for a session whose sandbox has been released, and
 * what lets both be tested without one.
 *
 * Access follows `routes/messages.ts`: view access, not direct ownership, so
 * a team's orchestrator reads the same way its transcript does. A session
 * the caller may not view answers 404, never 403 — an id must not confirm
 * that a session exists.
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import type { QueueItem } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions, sessionRepos } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import { toLogEntries } from "../sessions/session-log.js";
import { buildFilesChangedResponse, mergePatches } from "../sessions/files-changed.js";
import type { FilesChangedResponse, SessionLogResponse } from "../wire/types.js";

export const sessionInsightsRouter = new Hono<AppEnv>();

/**
 * Event retention, in days. Must match `EVENT_RETENTION_MS` in
 * `engine/host.ts`, which is what actually deletes the rows — the log
 * reports this so a reader knows a short history is retention, not a bug.
 */
const RETENTION_DAYS = 7;

const LOG_DEFAULT_LIMIT = 200;
const LOG_MAX_LIMIT = 500;

/** The session row, or null when the caller may not view it. */
async function loadViewableSession(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, c.req.param("id"))).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, c.var.user.id))) return null;
  return row;
}

/**
 * Reads a positive integer query parameter, clamped to `max`. A value that
 * is absent, empty, or not a number falls back to `fallback` rather than
 * failing the request — a log page size is not worth a 400.
 */
function readLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

sessionInsightsRouter.get("/:id/log", async (c) => {
  const session = await loadViewableSession(c);
  if (!session) return c.json({ error: "session not found" }, 404);

  const { eventStream } = c.var.providers;
  const fromOffset = c.req.query("fromOffset");
  const limit = readLimit(c.req.query("limit"), LOG_DEFAULT_LIMIT, LOG_MAX_LIMIT);

  // Default to the NEWEST page. A log reader without a cursor is asking
  // "what is this session doing", and the answer is at the end of the
  // stream. `read` pages forward from the beginning, so answering with it
  // would serve the session's first minutes forever, and a poll would
  // re-fetch that same page every time.
  //
  // `fromOffset` keeps the forward path for a caller that follows the
  // stream and remembers where it stopped.
  //
  // Both read raw events rather than log rows, because the projection drops
  // the streaming plane: a page of 200 events can yield far fewer rows, and
  // the cursor that makes progress is the STREAM's.
  //
  // `hasOlder` says events exist before this page's first row. On the
  // forward path the caller skipped them itself by passing a cursor; on the
  // tail path the page hit its limit. Either way the reader must not take
  // the page for the session's whole history.
  const page = await (async () => {
    if (fromOffset !== undefined) {
      const forward = await eventStream.read(session.id, { fromOffset, limit });
      return { ...forward, hasOlder: fromOffset !== "" };
    }
    const tail = await eventStream.readLatest(session.id, { limit });
    return { events: tail.events, nextOffset: tail.nextOffset, hasOlder: tail.hasMore };
  })();

  const body: SessionLogResponse = {
    entries: toLogEntries(page.events),
    nextOffset: page.nextOffset,
    retentionDays: RETENTION_DAYS,
    hasOlder: page.hasOlder,
  };
  return c.json(body);
});

/**
 * Why no patch exists, read off the newest settle record that has one.
 *
 * `hasRepo` decides between two sentences that must not be swapped. The
 * engine captures the start-ref best-effort inside the clone step and never
 * retries it, so `no_start_ref` reaches this function for two different
 * sessions: one with no repository at all, and one whose repository is
 * bound in `session_repos` but whose start point was never recorded. Only
 * the first may be told it has no repository.
 */
export function unavailableReason(
  newestWithPatch: QueueItem | null,
  hasRepo: boolean,
): FilesChangedResponse["unavailable"] {
  const patch = newestWithPatch?.settlePatch;
  if (patch === undefined) return "no_patches_yet";
  if (patch.status === "skipped") {
    if (patch.reason === "no_start_ref" || patch.reason === "not_a_git_workspace") {
      return hasRepo ? "repository_unreadable" : "no_repository";
    }
    if (patch.reason === "no_blob_store") return "storage_unavailable";
    // Every other skip reason is a sandbox that was not ready at settle
    // time (`sandbox_{state}`), which resolves on the next completed turn.
    return "no_patches_yet";
  }
  return "capture_failed";
}

async function readBlobText(
  blobs: { get(key: string): Promise<{ data: ReadableStream } | null> },
  key: string,
): Promise<string | null> {
  const blob = await blobs.get(key);
  if (!blob) return null;
  return await new Response(blob.data).text();
}

sessionInsightsRouter.get("/:id/files-changed", async (c) => {
  const session = await loadViewableSession(c);
  if (!session) return c.json({ error: "session not found" }, 404);

  const { db, engineStore, blobs } = c.var.providers;
  // Two bounded reads, not a scan of the session's settled history: this
  // route is polled every ten seconds while the Activity drawer is open,
  // and the `@`-mention popup reads it too.
  const { captured, latestWithPatch } = await engineStore.latestPatchCaptures(session.id);
  const blobKey = captured?.settlePatch?.blobKey;

  if (!captured || blobKey === undefined) {
    // The session's own repo bindings decide which sentence is true. Read
    // them only on this path — a session that captured a patch obviously
    // has a repository.
    const repos = await db
      .select({ sessionId: sessionRepos.sessionId })
      .from(sessionRepos)
      .where(eq(sessionRepos.sessionId, session.id))
      .limit(1);
    return c.json(
      buildFilesChangedResponse({
        files: [],
        unavailable: unavailableReason(latestWithPatch, repos.length > 0),
        truncated: false,
      }),
    );
  }

  let diff: string | null;
  try {
    diff = await readBlobText(blobs, blobKey);
  } catch (err) {
    console.error(`GET /files-changed: reading ${blobKey} failed:`, err);
    diff = null;
  }
  if (diff === null) {
    // The queue item names a patch the blob store no longer holds. That is
    // a storage problem, not an empty diff, and it must not read as "this
    // session changed nothing".
    return c.json(
      buildFilesChangedResponse({ files: [], unavailable: "storage_unavailable", truncated: false }),
    );
  }

  // Stale when a LATER turn settled without capturing. The list below is
  // still right for the turn it came from, but it is not the session's
  // current state, and only the server can tell the difference.
  const stale = latestWithPatch !== null && latestWithPatch.id !== captured.id;

  const body = buildFilesChangedResponse({
    capturedAt: captured.updatedAt,
    stale,
    files: mergePatches([diff]),
    truncated: captured.settlePatch?.truncated === true,
  });
  return c.json(body);
});
