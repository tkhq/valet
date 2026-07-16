/**
 * Single-org id resolution (auth-v2 design assumes exactly one org, same as
 * `services/org.ts`'s `ensureOrg`). Memoized per `AppDb` instance rather
 * than a bare module-level value — the API integration suite boots many
 * independent in-memory dbs in one process (`bootTestApi` per test), and a
 * single shared memo would leak the first test's org id into every later
 * test's requests. A `WeakMap` lets each db's entry be garbage-collected
 * with it.
 *
 * Shared by `middleware/auth.ts` (per-request org resolution) and
 * `providers/node.ts` (the `ChannelHost`'s `resolveOrgId` dep) — one
 * memoized source of truth instead of duplicating the cache.
 */
import type { AppDb } from "./drizzle.js";
import { ensureOrg } from "../services/org.js";

const orgIdMemo = new WeakMap<AppDb, string>();

export async function resolveOrgId(db: AppDb): Promise<string> {
  const cached = orgIdMemo.get(db);
  if (cached) return cached;
  const { id } = await ensureOrg(db);
  orgIdMemo.set(db, id);
  return id;
}
