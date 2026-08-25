/**
 * User service — per-user profile fields whose reads/writes want to sit
 * next to a helper that knows the jsonb shape (mirrors `services/org.ts`'s
 * `getOrgModelPreferences`/`setOrgModelPreferences` pair for the org
 * column).
 *
 * `users.model_preferences` (jsonb, default `[]`, NOT NULL) is the
 * per-user ordered model-id list that `EngineHost.resolveModelForBuild`
 * walks between `users.default_model` and `orgs.model_preferences` — a
 * restoration of the v1 feature that regressed to a single `defaultModel`
 * in dev-v2. Read/written as JSON here, same pattern as the org column.
 */
import { eq } from "drizzle-orm";
import { ValidationError } from "@valet/shared";
import type { AppQueryable } from "../lib/drizzle.js";
import { users } from "../schema/index.js";
import { isModelPreferenceList } from "./model-catalog.js";

/** Reads `users.model_preferences` (jsonb); absent/missing reads as `[]`. */
export async function getUserModelPreferences(
  db: AppQueryable,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ modelPreferences: users.modelPreferences })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const value = rows[0]?.modelPreferences;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Overwrites `users.model_preferences` with `prefs` (an ordered model-id
 * list). Accepts `unknown` and rejects anything that is not an array of
 * strings — the jsonb column has no schema-level array constraint, so this
 * is the runtime guard for it. Same shape as `setOrgModelPreferences`.
 */
export async function setUserModelPreferences(
  db: AppQueryable,
  userId: string,
  prefs: unknown,
): Promise<void> {
  if (!isModelPreferenceList(prefs)) {
    throw new ValidationError(
      "modelPreferences must be an array of strings. Send a JSON array of model ids.",
    );
  }
  await db.update(users).set({ modelPreferences: prefs }).where(eq(users.id, userId));
}
