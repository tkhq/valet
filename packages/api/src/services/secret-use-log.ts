/**
 * The record of each use of a use-only secret (sandbox secret broker design,
 * "Using a secret without exporting it"). The `/use` route writes one row per
 * successful call; the secrets list shows each secret's use count and last
 * use from these rows. A row holds the receipt, never the value.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, max } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { secretUses } from "../schema/index.js";
import type { SecretUseReceipt } from "./secret-use.js";

export interface SecretUseRecord {
  orgId: string;
  owner: string;
  secretName: string;
  sessionId: string;
  method: string;
  host: string;
  path: string;
  status: number;
  signer: string;
  receipt: SecretUseReceipt;
}

export async function recordSecretUse(db: AppDb, use: SecretUseRecord, now = Date.now()): Promise<void> {
  await db.insert(secretUses).values({ id: randomUUID(), ...use, createdAt: now });
}

/** Use count and last use per secret name, for the names given. */
export async function secretUseStats(
  db: AppDb,
  orgId: string,
  owner: string,
  names: string[],
): Promise<Map<string, { count: number; lastUsedAt: number }>> {
  const stats = new Map<string, { count: number; lastUsedAt: number }>();
  if (names.length === 0) return stats;
  const rows = await db
    .select({ name: secretUses.secretName, count: count(), lastUsedAt: max(secretUses.createdAt) })
    .from(secretUses)
    .where(and(eq(secretUses.orgId, orgId), eq(secretUses.owner, owner), inArray(secretUses.secretName, names)))
    .groupBy(secretUses.secretName);
  for (const r of rows) stats.set(r.name, { count: Number(r.count), lastUsedAt: Number(r.lastUsedAt ?? 0) });
  return stats;
}

/** Removes the uses of a deleted secret, so a new secret with the same name
 * starts at zero. */
export async function forgetSecretUses(db: AppDb, orgId: string, owner: string, secretName: string): Promise<void> {
  await db.delete(secretUses).where(and(eq(secretUses.orgId, orgId), eq(secretUses.owner, owner), eq(secretUses.secretName, secretName)));
}
