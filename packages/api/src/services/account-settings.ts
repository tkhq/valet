/** Shared account validation and persistence for the HTTP and conversational settings paths. */
import { and, eq, isNull } from "drizzle-orm";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { isValidTimezone } from "../lib/timezone.js";
import { orgMembers, users } from "../schema/index.js";
import { validateDefaultModelId } from "./model-catalog.js";
import { isOrgAdmin } from "./org.js";
import { assertModelSelectable } from "./approved-models.js";
import { assertReasoningSelectable } from "./reasoning.js";
import type { MeResponse, NewThreadBehavior } from "../wire/types.js";

export interface SettingsActor { id: string; email: string; role: "admin" | "member"; orgId: string }
export type SettingsFailure = { error: string };
const PATCH_FIELDS = new Set([
  "name",
  "avatarUrl",
  "defaultModel",
  "defaultReasoning",
  "newThreadBehavior",
  "timezone",
  "reportedTimezone",
]);

export async function loadAccountSettings(
  db: AppDb,
  user: { id: string; email: string; role: "admin" | "member"; orgId: string },
): Promise<MeResponse | undefined> {
  const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  const row = rows[0];
  if (!row) return undefined;

  const membershipRows = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, user.orgId), eq(orgMembers.userId, user.id)))
    .limit(1);
  const membership = membershipRows[0];

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.image,
    role: user.role,
    orgId: user.orgId,
    orgRole: membership?.role ?? "member",
    defaultModel: row.defaultModel,
    defaultReasoning: row.defaultReasoning ?? null,
    newThreadBehavior: row.newThreadBehavior,
    timezone: row.timezone ?? null,
    timezoneReportDone: row.timezoneReportDone,
  };
}

export async function validateModelDefaults(db: AppDb, engineCredentials: CredentialStore, user: Pick<SettingsActor, "id" | "orgId">, raw: Record<string, unknown>): Promise<{ defaultModel?: string | null; defaultReasoning?: string | null } | SettingsFailure> {
  const update: { defaultModel?: string | null; defaultReasoning?: string | null } = {};
  if ("defaultModel" in raw) {
    const defaultModel = raw.defaultModel;
    if (defaultModel !== null && typeof defaultModel !== "string") {
      return { error: "defaultModel must be a model id from the model list (GET /api/models), or null to clear the override." };
    }
    const invalid = await validateDefaultModelId(db, engineCredentials, user.orgId, defaultModel);
    if (invalid) return { error: invalid };
    if (defaultModel !== null) {
      const isAdmin = await isOrgAdmin(db, user.orgId, user.id);
      const err = await assertModelSelectable(db, user.orgId, isAdmin, defaultModel);
      if (err) return { error: err };
    }
    update.defaultModel = defaultModel;
  }

  if ("defaultReasoning" in raw) {
    const defaultReasoning = raw.defaultReasoning;
    if (defaultReasoning !== null && typeof defaultReasoning !== "string") {
      return { error: "defaultReasoning must be a reasoning level string, or null to clear the override." };
    }
    if (defaultReasoning === null) {
      update.defaultReasoning = null;
    } else {
      const normalizedReasoning = defaultReasoning.trim().toLowerCase();
      const err = await assertReasoningSelectable(db, user.orgId, normalizedReasoning);
      if (err) return { error: err };
      update.defaultReasoning = normalizedReasoning;
    }
  }

  return update;
}

export async function patchAccountSettings(db: AppDb, engineCredentials: CredentialStore, user: SettingsActor, parsed: unknown): Promise<MeResponse | SettingsFailure> {
  // `JSON.parse` accepts `null`/numbers/strings, which `Object.keys` and the
  // `in` operator below would throw on — reject anything but a plain object.
  if (!isRecord(parsed)) {
    return { error: "invalid JSON body. Send a JSON object, e.g. {\"name\": \"...\"}." };
  }
  const raw = parsed;

  const unknownFields = Object.keys(raw).filter((k) => !PATCH_FIELDS.has(k));
  if (unknownFields.length > 0) {
    return { error: `unknown field(s): ${unknownFields.join(", ")}. Send only supported profile settings.` };
  }

  // Keyed by db column name (`image`, not wire-level `avatarUrl`) since this
  // feeds `db.update(users).set(...)` directly.
  const update: {
    name?: string;
    image?: string;
    defaultModel?: string | null;
    defaultReasoning?: string | null;
    newThreadBehavior?: NewThreadBehavior;
    timezone?: string | null;
    timezoneReportDone?: boolean;
  } = {};

  if ("name" in raw) {
    if (typeof raw.name !== "string") {
      return { error: "name must be a string" };
    }
    update.name = raw.name;
  }

  if ("avatarUrl" in raw) {
    if (typeof raw.avatarUrl !== "string") {
      return { error: "avatarUrl must be a string" };
    }
    update.image = raw.avatarUrl;
  }

  const defaults = await validateModelDefaults(db, engineCredentials, user, raw);
  if ("error" in defaults) return defaults;
  Object.assign(update, defaults);

  if ("newThreadBehavior" in raw) {
    if (raw.newThreadBehavior !== "keep_current" && raw.newThreadBehavior !== "use_defaults") {
      return { error: "newThreadBehavior is not supported. Select keep_current or use_defaults." };
    }
    update.newThreadBehavior = raw.newThreadBehavior;
  }

  if ("timezone" in raw) {
    if (raw.timezone !== null && !isValidTimezone(raw.timezone)) {
      return { error: "timezone is not a valid IANA name. Send a name such as America/Los_Angeles, or null to clear it." };
    }
    update.timezone = raw.timezone;
    // An explicit set or clear is the user's choice. Never auto-report over it.
    update.timezoneReportDone = true;
  }

  let reportedTimezone: string | undefined;
  if ("reportedTimezone" in raw) {
    if (!isValidTimezone(raw.reportedTimezone)) {
      return { error: "reportedTimezone is not a valid IANA name. Send a name such as America/Los_Angeles." };
    }
    reportedTimezone = raw.reportedTimezone;
  }

  if (Object.keys(update).length > 0) {
    await db.update(users).set(update).where(eq(users.id, user.id));
  }

  // Apply the browser report once, and only if nothing was ever set or cleared.
  if (reportedTimezone !== undefined) {
    await db
      .update(users)
      .set({ timezone: reportedTimezone, timezoneReportDone: true })
      .where(and(eq(users.id, user.id), isNull(users.timezone), eq(users.timezoneReportDone, false)));
  }

  return await loadAccountSettings(db, user) ?? { error: "user not found" };
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
