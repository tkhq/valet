/**
 * CLI tokens for `valet login` (`docs/specs/2026-07-14-auth-v2-design.md`,
 * "CLI device sign-in").
 *
 * A signed-in CLI holds an access token (`vltc_…`, one day) and a refresh
 * token (`vltr_…`, 30 days from its last use). The CLI sends the access
 * token in `x-api-key`, so every command and the stream socket work as with
 * an API key. The auth middleware sends a `vltc_` value here instead of to
 * better-auth, and sets `authVia: "cli"`: an agent credential that cannot
 * approve requests or change policies (`isAgentCaller`).
 *
 * A refresh replaces both tokens in one conditional UPDATE, so a refresh
 * token works once. Tokens expire on their own, so a computer that stops
 * using Valet leaves nothing behind. The table stores only SHA-256 hashes.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, lt, or } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { cliTokens } from "../schema/index.js";
import type { CliTokenResponse } from "../wire/types.js";

export const CLI_ACCESS_PREFIX = "vltc_";
const CLI_REFRESH_PREFIX = "vltr_";
const ACCESS_TTL_MS = 24 * 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** `last_used_at` is written at most this often, so reads stay cheap. */
const LAST_USED_GRANULARITY_MS = 5 * 60_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newPair(now: number) {
  const accessToken = `${CLI_ACCESS_PREFIX}${randomBytes(32).toString("base64url")}`;
  const refreshToken = `${CLI_REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    accessToken,
    refreshToken,
    row: {
      accessHash: hashToken(accessToken),
      refreshHash: hashToken(refreshToken),
      accessExpiresAt: now + ACCESS_TTL_MS,
      refreshExpiresAt: now + REFRESH_TTL_MS,
    },
  };
}

function response(pair: ReturnType<typeof newPair>): CliTokenResponse {
  return {
    access_token: pair.accessToken,
    refresh_token: pair.refreshToken,
    access_expires_at: pair.row.accessExpiresAt,
    refresh_expires_at: pair.row.refreshExpiresAt,
  };
}

/** Sign in a CLI for `userId` on `device`. */
export async function mintCliToken(db: AppDb, userId: string, device: string, now = Date.now()): Promise<CliTokenResponse> {
  // Expiry is the normal end of a CLI sign-in, not a fault, so a new
  // sign-in clears this person's expired rows.
  await db.delete(cliTokens).where(and(eq(cliTokens.userId, userId), lt(cliTokens.refreshExpiresAt, now)));
  const pair = newPair(now);
  await db.insert(cliTokens).values({ id: randomUUID(), userId, device, createdAt: now, ...pair.row });
  return response(pair);
}

/** The user behind a live access token, or undefined. */
export async function verifyCliAccessToken(db: AppDb, token: string, now = Date.now()): Promise<{ userId: string; tokenId: string } | undefined> {
  if (!token.startsWith(CLI_ACCESS_PREFIX)) return undefined;
  const [row] = await db.select({ id: cliTokens.id, userId: cliTokens.userId, lastUsedAt: cliTokens.lastUsedAt }).from(cliTokens)
    .where(and(eq(cliTokens.accessHash, hashToken(token)), gt(cliTokens.accessExpiresAt, now))).limit(1);
  if (!row) return undefined;
  if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_GRANULARITY_MS) {
    await db.update(cliTokens).set({ lastUsedAt: now }).where(eq(cliTokens.id, row.id));
  }
  return { userId: row.userId, tokenId: row.id };
}

/** Replace both tokens. Undefined when the refresh token is unknown, used, or expired. */
export async function refreshCliToken(db: AppDb, refreshToken: string, now = Date.now()): Promise<CliTokenResponse | undefined> {
  const pair = newPair(now);
  const [row] = await db.update(cliTokens).set({ ...pair.row, lastUsedAt: now })
    .where(and(eq(cliTokens.refreshHash, hashToken(refreshToken)), gt(cliTokens.refreshExpiresAt, now)))
    .returning({ id: cliTokens.id });
  return row ? response(pair) : undefined;
}

/** Sign out the CLI that holds this access or refresh token. */
export async function revokeCliToken(db: AppDb, token: string): Promise<void> {
  const hash = hashToken(token);
  await db.delete(cliTokens).where(or(eq(cliTokens.accessHash, hash), eq(cliTokens.refreshHash, hash)));
}
