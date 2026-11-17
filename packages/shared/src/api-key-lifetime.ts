/**
 * API key lifetimes (`docs/specs/2026-07-14-auth-v2-design.md`, update of 2026-11-17).
 * The create forms offer these choices, and an organization admin can set
 * one of them as the longest lifetime a new key may have. The api reads the
 * same values, so the form and the server agree on what "too long" means.
 */

/** Lifetimes, in days, that a new key and the org maximum can use. */
export const API_KEY_LIFETIME_DAYS = [30, 90, 365] as const;

export type ApiKeyLifetimeDays = (typeof API_KEY_LIFETIME_DAYS)[number];

/** The lifetime a create form selects first. */
export const DEFAULT_API_KEY_LIFETIME_DAYS: ApiKeyLifetimeDays = 90;

export const SECONDS_PER_DAY = 86_400;

export function isApiKeyLifetimeDays(value: unknown): value is ApiKeyLifetimeDays {
  return typeof value === "number" && API_KEY_LIFETIME_DAYS.some((days) => days === value);
}

/**
 * The lifetimes a create form may offer under an org maximum, in days.
 * `null` in the result is "No expiry". It is offered only when the org sets
 * no maximum.
 */
export function apiKeyLifetimeChoices(maxDays: number | null): Array<ApiKeyLifetimeDays | null> {
  if (maxDays === null) return [...API_KEY_LIFETIME_DAYS, null];
  return API_KEY_LIFETIME_DAYS.filter((days) => days <= maxDays);
}

/** The choice a create form selects first under an org maximum. */
export function defaultApiKeyLifetime(maxDays: number | null): ApiKeyLifetimeDays | null {
  if (maxDays === null || DEFAULT_API_KEY_LIFETIME_DAYS <= maxDays) return DEFAULT_API_KEY_LIFETIME_DAYS;
  const choices = apiKeyLifetimeChoices(maxDays);
  return choices[choices.length - 1] ?? null;
}
