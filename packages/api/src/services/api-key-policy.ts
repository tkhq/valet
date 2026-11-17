/**
 * Organization policy for `vlt_` API keys
 * (`docs/specs/2026-07-14-auth-v2-design.md`, update of 2026-11-17). Two org columns hold
 * it: `allow_personal_api_keys` and `max_api_key_lifetime_days`. Every path
 * that mints a key reads it here:
 *
 * - personal keys from the browser: the better-auth before hook
 *   (`auth/api-key-hooks.ts`);
 * - team keys: `routes/team-api-keys.ts`;
 * - proxy keys from `valet proxy setup`: `routes/cli-device.ts`.
 */
import { eq } from "drizzle-orm";
import { SECONDS_PER_DAY } from "@valet/shared";
import type { AppQueryable } from "../lib/drizzle.js";
import { orgs } from "../schema/index.js";
import { findOrg } from "./org.js";

export interface ApiKeyPolicy {
  allowPersonalKeys: boolean;
  /** Longest lifetime of a new key, in days. Null: no limit. */
  maxLifetimeDays: number | null;
}

const OPEN_POLICY: ApiKeyPolicy = { allowPersonalKeys: true, maxLifetimeDays: null };

export const PERSONAL_API_KEYS_OFF_MESSAGE =
  "Your organization does not allow personal API keys. " +
  "Ask an organization admin to turn them on in Settings → Organization → Policies.";

export async function getApiKeyPolicy(db: AppQueryable, orgId: string): Promise<ApiKeyPolicy> {
  const rows = await db
    .select({ allowPersonalKeys: orgs.allowPersonalApiKeys, maxLifetimeDays: orgs.maxApiKeyLifetimeDays })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  return rows[0] ?? OPEN_POLICY;
}

/**
 * The policy of the instance's one organization. The auth hook has no
 * request user with an org id, and the instance has one org
 * (`lib/org.ts` `resolveOrgId`). No org row yet: nothing is restricted.
 */
export async function getInstanceApiKeyPolicy(db: AppQueryable): Promise<ApiKeyPolicy> {
  const org = await findOrg(db);
  return org ? getApiKeyPolicy(db, org.id) : OPEN_POLICY;
}

function maxLifetimeMessage(maxDays: number): string {
  return `Your organization allows API keys that expire within ${maxDays} days. ` +
    `Choose an expiry of ${maxDays} days or less.`;
}

export type KeyExpiryDecision =
  | { ok: true; expiresIn: number | null }
  | { ok: false; message: string };

/**
 * Check a requested key lifetime against the org maximum.
 *
 * - `undefined` (the caller sent no expiry): the org maximum, or no expiry
 *   when the org sets none. Older clients send no expiry, so they keep
 *   working under a maximum.
 * - `null` ("No expiry"): refused when the org sets a maximum.
 * - seconds: refused when longer than the maximum.
 *
 * The caller validates the type of `requested` before this check.
 */
export function resolveKeyExpiry(policy: ApiKeyPolicy, requested: number | null | undefined): KeyExpiryDecision {
  const max = policy.maxLifetimeDays;
  if (requested === undefined) return { ok: true, expiresIn: max === null ? null : max * SECONDS_PER_DAY };
  if (max === null) return { ok: true, expiresIn: requested };
  if (requested === null || requested > max * SECONDS_PER_DAY) return { ok: false, message: maxLifetimeMessage(max) };
  return { ok: true, expiresIn: requested };
}
