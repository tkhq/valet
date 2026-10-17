/**
 * Write-time checks for an assistant thread policy (spec
 * 2026-10-16-delivery-threads-and-claims-design.md, Part A). The shape check
 * is `validateThreadPolicy` in `@valet/shared`. This module adds the checks
 * that need the plugin catalog or the database.
 */
import { sql } from "drizzle-orm";
import type { Principal, ValetPlugin } from "@valet/engine";
import { readThreadPolicy, validateThreadPolicy } from "@valet/shared";
import type { Providers } from "../providers/types.js";
import { isPersonalThreadKey, storedThreadRef, threadVisibility, type ThreadViewer } from "../services/thread-access.js";
import { isDeliverableTarget } from "./assistant-delivery.js";
import { eventKeyMatches } from "./match.js";

export const NO_SUBJECT_ERROR = "This rule's events have no subject to group by. Pick another thread option.";
export const CROSS_OWNER_THREAD_ERROR = "This thread belongs to another owner. Pick a thread in your workspace.";
export const ARCHIVED_THREAD_ERROR = "This thread is archived. Pick an open thread.";
export const NOT_ASSISTANT_THREAD_ERROR =
  "This thread is not in a live assistant conversation. Pick a thread in your assistant.";

/**
 * True when a plugin that owns one of `eventKeys` names a natural subject
 * (`ValetPlugin.naturalSubject`). The check is per plugin, not per event: a
 * plugin can return null for one event (a Slack event with no channel), and
 * the resolver then falls back to the rule's own thread.
 */
export function subjectModeAllowed(eventKeys: readonly string[], plugins: readonly ValetPlugin[]): boolean {
  return plugins.some((plugin) =>
    plugin.naturalSubject !== undefined &&
    (plugin.triggers ?? []).some((trigger) =>
      trigger.catalog.some((entry) => eventKeys.some((pattern) => eventKeyMatches(entry.key, [pattern]))),
    ),
  );
}

/** What the `existing` checks read: the database, and the Slack credential
 * the thread read gate uses (`threadVisibility`). */
export type ThreadPolicyWriteDeps = Pick<Providers, "db" | "engineCredentials"> & { onePassword?: Providers["onePassword"] };

/**
 * Validate an `existing` policy's thread for a rule of `owner`, written by
 * `writer` (the person who sends the create or the edit). Returns null when a
 * delivery could land there, else the refusal text. The deliverability gate
 * is the dispatcher's own (`isDeliverableTarget`), so a thread accepted here
 * is one the dispatcher would accept today.
 *
 * The writer controls the rule's prompt and its reply route, so the writer
 * must be able to read the thread, by the same gate the read paths use
 * (`threadVisibility`). A team or org rule never pins one person's thread
 * (`isPersonalThreadKey`). A missing thread, another owner's thread, and a
 * thread the writer cannot read get the same text, so the answer never shows
 * that such a thread exists.
 */
export async function validateExistingThread(
  deps: ThreadPolicyWriteDeps,
  writer: ThreadViewer,
  owner: Principal,
  target: { sessionId: string; threadId: string },
): Promise<string | null> {
  const result = await deps.db.execute(sql`
      SELECT t.key AS key, (m.archived_at IS NOT NULL) AS archived FROM agent_sessions s
      JOIN engine_threads t ON t.session_id = s.id AND t.id = ${target.threadId}
      LEFT JOIN session_threads m ON m.session_id = s.id AND m.id = t.id
      WHERE s.id = ${target.sessionId} AND s.org_id = ${writer.orgId} AND s.status <> 'deleted'
        AND s.owner_type = ${owner.type} AND s.owner_id = ${owner.id}
      LIMIT 1`) as { rows: Array<{ key: string | null; archived: boolean }> }; // Raw SQL rows are untyped; the SELECT names a key and a boolean.
  const row = result.rows[0];
  if (!row) return CROSS_OWNER_THREAD_ERROR;
  if (owner.type !== "user" && isPersonalThreadKey(row.key)) return CROSS_OWNER_THREAD_ERROR;
  const visible = threadVisibility(deps, { ownerType: owner.type, id: target.sessionId }, writer);
  if (!(await visible(await storedThreadRef(deps.db, target.sessionId, target.threadId, row.key)))) {
    return CROSS_OWNER_THREAD_ERROR;
  }
  if (await isDeliverableTarget({ db: deps.db }, writer.orgId, owner, target)) return null;
  // The owner's thread exists. It is archived, or its session is not a live
  // assistant conversation (a plain session, or a retired assistant).
  return row.archived ? ARCHIVED_THREAD_ERROR : NOT_ASSISTANT_THREAD_ERROR;
}

/**
 * `validateExistingThread` for a stored or requested policy value, when its
 * mode is `existing`. Returns null for an absent policy and for every other
 * valid mode. A malformed policy returns the shape text, so a caller that
 * skipped the shape check fails closed. Call it once the rule's owner is known.
 */
export async function existingThreadError(
  deps: ThreadPolicyWriteDeps,
  writer: ThreadViewer,
  owner: Principal,
  policy: unknown,
): Promise<string | null> {
  if (policy === undefined || policy === null) return null;
  const shapeError = validateThreadPolicy(policy);
  if (shapeError) return shapeError;
  const read = readThreadPolicy(policy);
  return read.mode === "existing" ? validateExistingThread(deps, writer, owner, read) : null;
}
