/**
 * Invites — org-admin issued signup codes. A code is a 32-hex-char random
 * token (`randomBytes(16).toString("hex")`); only its sha256 hex digest is
 * ever persisted (`invites.code_hash`). The plaintext code is returned to
 * the caller exactly once, at creation — no read path below ever surfaces
 * it again.
 */
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { invites } from "../schema/index.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteRole = "admin" | "member";

export interface InviteRecord {
  id: string;
  email: string | null;
  role: InviteRole;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function toRecord(row: {
  id: string;
  email: string | null;
  role: InviteRole;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
}): InviteRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdBy: row.createdBy,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
  };
}

/** Issues a new invite. Returns the record plus the plaintext code — the
 * only place the code is ever available; only its hash is stored. */
export function createInvite(
  db: AppDb,
  opts: { email?: string; role: InviteRole; createdBy: string; ttlMs?: number },
): { invite: InviteRecord; code: string } {
  const code = randomBytes(16).toString("hex");
  const now = Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const row = {
    id: `invite_${randomUUID()}`,
    codeHash: hashCode(code),
    email: opts.email ?? null,
    role: opts.role,
    createdBy: opts.createdBy,
    createdAt: new Date(now),
    expiresAt: new Date(now + ttlMs),
  };
  db.insert(invites).values(row).run();
  return { invite: toRecord(row), code };
}

/** Looks up an unexpired, unaccepted invite by its plaintext code (hashed
 * before the lookup — the plaintext is never stored or compared directly). */
export function findValidInviteByCode(db: AppDb, code: string): InviteRecord | null {
  const now = new Date();
  const row = db
    .select()
    .from(invites)
    .where(and(eq(invites.codeHash, hashCode(code)), isNull(invites.acceptedBy)))
    .get();
  if (!row || row.expiresAt <= now) return null;
  return toRecord(row);
}

/** Looks up an unexpired, unaccepted invite by email, case-insensitively. */
export function findValidInviteByEmail(db: AppDb, email: string): InviteRecord | null {
  const now = new Date();
  const target = email.toLowerCase();
  const rows = db
    .select()
    .from(invites)
    .where(isNull(invites.acceptedBy))
    .all();
  const row = rows.find((r) => r.email !== null && r.email.toLowerCase() === target && r.expiresAt > now);
  return row ? toRecord(row) : null;
}

/** Marks an invite accepted — single-use: once set, `findValidInviteBy*`
 * will no longer return it. */
export function acceptInvite(db: AppDb, inviteId: string, userId: string): void {
  db.update(invites)
    .set({ acceptedBy: userId, acceptedAt: new Date() })
    .where(eq(invites.id, inviteId))
    .run();
}

/** Deletes an invite. Returns false if no row matched. */
export function revokeInvite(db: AppDb, inviteId: string): boolean {
  const result = db.delete(invites).where(eq(invites.id, inviteId)).run();
  return result.changes > 0;
}

/** Lists every invite that hasn't been accepted yet, regardless of expiry. */
export function listPendingInvites(db: AppDb): InviteRecord[] {
  return db
    .select()
    .from(invites)
    .where(isNull(invites.acceptedBy))
    .all()
    .map(toRecord);
}
