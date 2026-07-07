import { NotFoundError } from '@valet/shared';
import { and, eq } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import { credentials, users } from '../lib/schema/index.js';
import { getCredentialRow, upsertCredential } from '../lib/db/credentials.js';

/**
 * Zapier-style sourced connections (teams design §5): a team credential is a
 * REFERENCE to the sourcing member's live credential (`sourced_from_user_id`),
 * not a copy of the tokens. `getCredential('team', …)` delegates to the
 * member's own row, so refresh/rotation happens once (on that row) and the
 * token lineage never splits. The team row carries only provenance + status;
 * its `encrypted_data` is an unused placeholder. If the member revokes their
 * connection or leaves the team, the reference flips to 'broken' (surfaced,
 * never silently swapped); any member can re-source, resetting status.
 */

// The team reference row holds no real secret — resolution delegates to the
// sourcing member's credential. Kept non-null to satisfy the schema.
const REFERENCE_PLACEHOLDER = '';

export interface TeamCredentialSummary {
  provider: string;
  credentialType: string;
  status: 'active' | 'broken';
  sourcedFromUserId?: string;
  sourcedFromName?: string;
  sourcedFromEmail?: string;
  updatedAt: string;
}

export async function shareCredentialToTeam(
  db: AppDb,
  teamId: string,
  sourcingUserId: string,
  provider: string
): Promise<TeamCredentialSummary> {
  const personal = await getCredentialRow(db, 'user', sourcingUserId, provider);
  if (!personal) {
    throw new NotFoundError('Connection', provider);
  }

  // Store a reference, not the tokens. credentialType/scopes are copied for
  // display and index parity; encrypted_data is a placeholder (never read for
  // team rows — see getCredential's team branch).
  await upsertCredential(db, {
    id: crypto.randomUUID(),
    ownerType: 'team',
    ownerId: teamId,
    provider: personal.provider,
    credentialType: personal.credentialType,
    encryptedData: REFERENCE_PLACEHOLDER,
    metadata: personal.metadata,
    scopes: personal.scopes,
    expiresAt: null,
    sourcedFromUserId: sourcingUserId,
  });

  return {
    provider: personal.provider,
    credentialType: personal.credentialType,
    status: 'active',
    sourcedFromUserId: sourcingUserId,
    updatedAt: new Date().toISOString(),
  };
}

export async function listTeamCredentials(db: AppDb, teamId: string): Promise<TeamCredentialSummary[]> {
  const rows = await db
    .select({
      provider: credentials.provider,
      credentialType: credentials.credentialType,
      status: credentials.status,
      sourcedFromUserId: credentials.sourcedFromUserId,
      updatedAt: credentials.updatedAt,
      sourcedFromName: users.name,
      sourcedFromEmail: users.email,
    })
    .from(credentials)
    .leftJoin(users, eq(credentials.sourcedFromUserId, users.id))
    .where(and(eq(credentials.ownerType, 'team'), eq(credentials.ownerId, teamId)))
    .orderBy(credentials.provider);

  return rows.map((r) => ({
    provider: r.provider,
    credentialType: r.credentialType,
    status: r.status === 'broken' ? 'broken' : 'active',
    sourcedFromUserId: r.sourcedFromUserId ?? undefined,
    sourcedFromName: r.sourcedFromName ?? undefined,
    sourcedFromEmail: r.sourcedFromEmail ?? undefined,
    updatedAt: r.updatedAt,
  }));
}

export async function getTeamCredentialSourcer(
  db: AppDb,
  teamId: string,
  provider: string
): Promise<string | null> {
  const row = await db
    .select({ sourcedFromUserId: credentials.sourcedFromUserId })
    .from(credentials)
    .where(and(eq(credentials.ownerType, 'team'), eq(credentials.ownerId, teamId), eq(credentials.provider, provider)))
    .get();
  return row?.sourcedFromUserId ?? null;
}

export async function unshareTeamCredential(db: AppDb, teamId: string, provider: string): Promise<number> {
  // Select-then-delete: D1 and better-sqlite3 report delete counts in
  // different result shapes, so count portably instead.
  const rows = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.ownerType, 'team'), eq(credentials.ownerId, teamId), eq(credentials.provider, provider)));
  if (rows.length === 0) return 0;
  await db
    .delete(credentials)
    .where(and(eq(credentials.ownerType, 'team'), eq(credentials.ownerId, teamId), eq(credentials.provider, provider)));
  return rows.length;
}

/** Flip team credentials sourced from a user to 'broken' (never silent removal). */
export async function breakTeamCredentialsSourcedFrom(
  db: AppDb,
  sourcingUserId: string,
  opts: { teamId?: string; provider?: string } = {}
): Promise<void> {
  const conditions = [
    eq(credentials.ownerType, 'team'),
    eq(credentials.sourcedFromUserId, sourcingUserId),
  ];
  if (opts.teamId) conditions.push(eq(credentials.ownerId, opts.teamId));
  if (opts.provider) conditions.push(eq(credentials.provider, opts.provider));

  await db.update(credentials).set({ status: 'broken' }).where(and(...conditions));
}
