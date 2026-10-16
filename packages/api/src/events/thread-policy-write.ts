/**
 * Write-time checks for an assistant thread policy (spec
 * 2026-10-16-delivery-threads-and-claims-design.md, Part A). The shape check
 * is `validateThreadPolicy` in `@valet/shared`. This module adds the checks
 * that need the plugin catalog or the database.
 */
import { sql } from "drizzle-orm";
import type { Principal, ValetPlugin } from "@valet/engine";
import { readThreadPolicy } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
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

/**
 * Validate an `existing` policy's thread for a rule of `owner` in `orgId`.
 * Returns null when a delivery could land there, else the refusal text. The
 * deliverability gate is the dispatcher's own (`isDeliverableTarget`), so a
 * thread accepted here is one the dispatcher would accept today.
 *
 * A missing thread and another owner's thread get the same text, so the
 * answer never shows that another owner's thread exists.
 */
export async function validateExistingThread(
  db: AppDb,
  orgId: string,
  owner: Principal,
  target: { sessionId: string; threadId: string },
): Promise<string | null> {
  if (await isDeliverableTarget({ db }, orgId, owner, target)) return null;
  const result = await db.execute(sql`
      SELECT (m.archived_at IS NOT NULL) AS archived FROM agent_sessions s
      JOIN engine_threads t ON t.session_id = s.id AND t.id = ${target.threadId}
      LEFT JOIN session_threads m ON m.session_id = s.id AND m.id = t.id
      WHERE s.id = ${target.sessionId} AND s.org_id = ${orgId} AND s.status <> 'deleted'
        AND s.owner_type = ${owner.type} AND s.owner_id = ${owner.id}
      LIMIT 1`) as { rows: Array<{ archived: boolean }> }; // Raw SQL rows are untyped; the SELECT names one boolean.
  const row = result.rows[0];
  if (!row) return CROSS_OWNER_THREAD_ERROR;
  // The owner's thread exists. It is archived, or its session is not a live
  // assistant conversation (a plain session, or a retired assistant).
  return row.archived ? ARCHIVED_THREAD_ERROR : NOT_ASSISTANT_THREAD_ERROR;
}

/**
 * `validateExistingThread` for a stored or requested policy value, when its
 * mode is `existing`. Returns null for an absent policy and for every other
 * mode. Call it after the shape check, once the rule's owner is known.
 */
export async function existingThreadError(
  db: AppDb,
  orgId: string,
  owner: Principal,
  policy: unknown,
): Promise<string | null> {
  if (policy === undefined || policy === null) return null;
  const read = readThreadPolicy(policy);
  return read.mode === "existing" ? validateExistingThread(db, orgId, owner, read) : null;
}
