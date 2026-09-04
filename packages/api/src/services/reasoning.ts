/**
 * Reasoning level vocabulary (TKAI-xxx): the reasoning level ordering,
 * org settings, and cap validation.
 *
 * A reasoning level (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`)
 * is an org-configurable attribute. The org can set a default reasoning level
 * for new sessions and a maximum allowed level (cap) that no session can exceed.
 *
 * The org's reasoning settings live in `orgs.reasoning_settings` (jsonb, nullable).
 * A null column means no default and no cap.
 */
import { eq } from "drizzle-orm";
import type { AppQueryable } from "../lib/drizzle.js";
import { orgs } from "../schema/index.js";

/** The six reasoning levels, in order. */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export const REASONING_SET: ReadonlySet<string> = new Set(REASONING_LEVELS);

/**
 * Compare two reasoning levels by their order index.
 * Returns a negative number if a < b, zero if a === b, positive if a > b.
 */
export function compareReasoning(a: ReasoningLevel, b: ReasoningLevel): number {
  const aIndex = REASONING_LEVELS.indexOf(a);
  const bIndex = REASONING_LEVELS.indexOf(b);
  return aIndex - bIndex;
}

/**
 * Clamp a reasoning level to a maximum.
 * Returns the lower of the two levels, or the level itself if max is undefined.
 */
export function clampToMax(level: ReasoningLevel, max: ReasoningLevel | undefined): ReasoningLevel {
  if (max === undefined) return level;
  return compareReasoning(level, max) <= 0 ? level : max;
}

/**
 * Org settings for reasoning: optional default and cap.
 */
export interface OrgReasoningSettings {
  default?: ReasoningLevel;
  max?: ReasoningLevel;
}

/**
 * Read the org's reasoning settings from `orgs.reasoning_settings`, falling back
 * to an empty object when the column is null or not a valid object.
 * Invalid entries (e.g., unknown levels) are silently dropped.
 */
export async function getOrgReasoningSettings(
  db: AppQueryable,
  orgId: string,
): Promise<OrgReasoningSettings> {
  const rows = await db
    .select({ reasoningSettings: orgs.reasoningSettings })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);

  const raw = rows[0]?.reasoningSettings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  // Merge stored settings, validating against REASONING_SET.
  const stored = raw as Record<string, unknown>;
  const merged: OrgReasoningSettings = {};

  if (stored.default && REASONING_SET.has(String(stored.default))) {
    merged.default = stored.default as ReasoningLevel;
  }
  if (stored.max && REASONING_SET.has(String(stored.max))) {
    merged.max = stored.max as ReasoningLevel;
  }

  return merged;
}

/**
 * Persist the org's reasoning settings. Callers must validate settings before calling.
 */
export async function setOrgReasoningSettings(
  db: AppQueryable,
  orgId: string,
  s: OrgReasoningSettings,
): Promise<void> {
  await db.update(orgs).set({ reasoningSettings: s }).where(eq(orgs.id, orgId));
}

/**
 * Pure merge + validate for `PATCH /api/org/reasoning`: applies a patch
 * (`default`/`max`, each `string | null | undefined`) onto stored settings.
 * `null` clears a field; an absent key (checked with `in`, not `undefined`
 * equality) leaves the stored value untouched. Values are normalized
 * (trim + lowercase) before validation, so `"Medium"` is accepted like
 * `"medium"`.
 *
 * Returns the merged settings, or an error message naming the corrective
 * action when a value is unknown or the merged default would exceed the
 * merged max.
 */
export function mergeReasoningSettings(
  current: OrgReasoningSettings,
  patch: { default?: string | null; max?: string | null },
): OrgReasoningSettings | string {
  const merged: OrgReasoningSettings = { ...current };

  for (const key of ["default", "max"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) {
      delete merged[key];
      continue;
    }
    const normalized = value.trim().toLowerCase();
    if (!REASONING_SET.has(normalized)) {
      return `Unknown reasoning level "${value}". Valid levels: ${Array.from(REASONING_LEVELS).join(", ")}.`;
    }
    // Checked against REASONING_SET above, so this narrowing is safe.
    merged[key] = normalized as ReasoningLevel;
  }

  if (merged.default && merged.max && compareReasoning(merged.default, merged.max) > 0) {
    return "Default reasoning level cannot exceed the max.";
  }

  return merged;
}

/**
 * Validate that a reasoning level can be selected for the given org.
 * Returns an error message string if validation fails, or null if the level is OK.
 *
 * - Unknown level → error with valid levels list
 * - Level exceeds org max → error naming the max
 * - Otherwise → null (OK)
 */
export async function assertReasoningSelectable(
  db: AppQueryable,
  orgId: string,
  level: string,
): Promise<string | null> {
  // Check if the level is known.
  if (!REASONING_SET.has(level)) {
    return `Unknown reasoning level "${level}". Valid levels: ${Array.from(REASONING_LEVELS).join(", ")}.`;
  }

  // Check if the level exceeds the org max.
  const settings = await getOrgReasoningSettings(db, orgId);
  if (settings.max) {
    const levelObj = level as ReasoningLevel;
    if (compareReasoning(levelObj, settings.max) > 0) {
      return `Reasoning level "${level}" exceeds the org max ("${settings.max}"). Ask an org admin to raise the cap in Settings → Organization → Models.`;
    }
  }

  return null;
}
