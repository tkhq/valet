import { eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { defaultChannelGraceSeconds } from "../orchestrator/attention.js";
import { userNotificationPreferences } from "../schema/index.js";
import type { NotificationKind, NotificationPreferenceSummary, SetNotificationPreferenceRequest } from "../wire/types.js";

/** The Notifications page and the settings actions read and write the same rows. */
export const NOTIFICATION_KINDS: NotificationKind[] = ["notification", "question", "escalation", "approval", "review"];

function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.some((kind) => kind === value);
}

/**
 * A kind with no row reports `web: true` and `teamDm: false`, which mirrors
 * `isWebEnabled`'s default in `orchestrator/attention.ts`.
 */
export async function listNotificationPreferences(db: AppDb, userId: string): Promise<NotificationPreferenceSummary[]> {
  const rows = await db.select().from(userNotificationPreferences).where(eq(userNotificationPreferences.userId, userId));
  const byKind = new Map(rows.map((r) => [r.kind, r]));
  return NOTIFICATION_KINDS.map((kind) => ({
    kind,
    web: byKind.get(kind)?.web ?? true,
    teamDm: byKind.get(kind)?.teamDm ?? false,
    channelGraceSeconds: byKind.get(kind)?.channelGraceSeconds ?? defaultChannelGraceSeconds(kind),
  }));
}

/** Returns the error for an invalid request, or the request typed. */
export function parseNotificationPreference(body: unknown): SetNotificationPreferenceRequest | { error: string } {
  if (body === null || typeof body !== "object") return { error: "body must be an object" };
  // A JSON object body: each field is narrowed below.
  const { kind, web, teamDm, channelGraceSeconds } = body as Record<string, unknown>;
  if (!isNotificationKind(kind)) {
    return { error: `kind must be one of ${NOTIFICATION_KINDS.join(", ")}` };
  }
  if (typeof web !== "boolean") return { error: "web must be a boolean" };
  if (teamDm !== undefined && typeof teamDm !== "boolean") {
    return { error: "teamDm must be a boolean. Choose whether to receive team direct messages." };
  }
  if (channelGraceSeconds !== undefined && channelGraceSeconds !== null && (typeof channelGraceSeconds !== "number"
    || !Number.isInteger(channelGraceSeconds) || channelGraceSeconds < 0 || channelGraceSeconds > 86_400)) {
    return { error: "channelGraceSeconds must be an integer from 0 to 86400. Choose a delay of at most one day." };
  }
  return {
    kind,
    web,
    ...(teamDm === undefined ? {} : { teamDm }),
    ...(channelGraceSeconds === undefined ? {} : { channelGraceSeconds }),
  };
}

/** Upserts one kind. An omitted teamDm or grace keeps the saved value. */
export async function saveNotificationPreference(db: AppDb, userId: string, pref: SetNotificationPreferenceRequest): Promise<void> {
  await db
    .insert(userNotificationPreferences)
    .values({ userId, kind: pref.kind, web: pref.web, teamDm: pref.teamDm ?? false, channelGraceSeconds: pref.channelGraceSeconds })
    .onConflictDoUpdate({
      target: [userNotificationPreferences.userId, userNotificationPreferences.kind],
      set: { web: pref.web, ...(pref.channelGraceSeconds === undefined ? {} : { channelGraceSeconds: pref.channelGraceSeconds }), ...(pref.teamDm === undefined ? {} : { teamDm: pref.teamDm }) },
    });
}
