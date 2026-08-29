/**
 * Plugin entitlements service — the org-scope resolution half of the plugin
 * feature-flag rail (docs/specs/2026-08-29-plugin-entitlements-design.md).
 *
 * The org layer stores, per plugin, a mode (`off` / `all` / `teams`) and, for
 * `teams`, the team ids that admit a user. Reads default a missing entry to
 * `{ mode: "all", teamIds: [] }`, so an org that never configured a plugin
 * leaves it on for every member — the pre-flag always-on behavior.
 *
 * This service is DB-pure: it never reads the instance (deployment) switch.
 * Effective access = the plugin is instance-loaded AND `orgAllowsPluginForUser`
 * returns true. The instance check lives on `EngineHost.isPluginLoaded`, kept
 * out of here so this service stays testable without a plugin set.
 */
import { and, eq, inArray } from "drizzle-orm";
import { ValidationError, type PluginEntitlement, type PluginEntitlementMode } from "@valet/shared";
import type { AppQueryable } from "../lib/drizzle.js";
import { teamMembers, teams } from "../schema/index.js";
import { pluginStore } from "./plugin-store.js";

/** The default entry for a plugin an org never configured: on for everyone. */
export const DEFAULT_ENTITLEMENT: PluginEntitlement = { mode: "all", teamIds: [] };

/**
 * Where the entitlement rail persists (plugin-store design). The rail is core,
 * so it uses the reserved `"valet"` plugin namespace and the `org` scope. Each
 * gated plugin's entitlement is one document keyed by the target plugin name.
 */
const ENTITLEMENTS_PLUGIN = "valet";
const ENTITLEMENTS_COLLECTION = "plugin-entitlements";

const MODES: readonly PluginEntitlementMode[] = ["off", "all", "teams"];

function isMode(v: unknown): v is PluginEntitlementMode {
  return typeof v === "string" && (MODES as readonly string[]).includes(v);
}

/** Narrows one stored document into a `PluginEntitlement`, or `undefined` when
 * the value is not a well-formed entry (which reads as "no entry" → default). */
function parseEntitlement(raw: unknown): PluginEntitlement | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (!isMode(rec.mode)) return undefined;
  const teamIds = Array.isArray(rec.teamIds)
    ? rec.teamIds.filter((id): id is string => typeof id === "string")
    : [];
  return { mode: rec.mode, teamIds };
}

/** The org's entitlement store view, bound to the reserved "valet" namespace. */
function entitlementStore(db: AppQueryable, orgId: string) {
  return pluginStore(db, ENTITLEMENTS_PLUGIN).org(orgId);
}

/** The whole entitlement map for an org, defaulted per plugin. Only plugins the
 * store actually holds a document for appear — a plugin with no entry is absent
 * here and resolves to the default through `getPluginEntitlement`. */
export async function getPluginEntitlements(
  db: AppQueryable,
  orgId: string,
): Promise<Record<string, PluginEntitlement>> {
  const out: Record<string, PluginEntitlement> = {};
  let cursor: string | null | undefined;
  do {
    const page = await entitlementStore(db, orgId).list<unknown>(ENTITLEMENTS_COLLECTION, {
      cursor: cursor ?? undefined,
    });
    for (const item of page.items) {
      const parsed = parseEntitlement(item.doc);
      if (parsed) out[item.key] = parsed;
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** One plugin's entitlement, defaulted to `all` when the org has no entry. */
export async function getPluginEntitlement(
  db: AppQueryable,
  orgId: string,
  name: string,
): Promise<PluginEntitlement> {
  const doc = await entitlementStore(db, orgId).get<unknown>(ENTITLEMENTS_COLLECTION, name);
  return parseEntitlement(doc?.doc) ?? { ...DEFAULT_ENTITLEMENT };
}

/**
 * Writes one plugin's entitlement as its own document, so other plugins'
 * entries are untouched. Validates the mode against the enum and every team id
 * against the org's teams — a team from another org, or an unknown id,
 * rejects the whole write. `teamIds` is normalized to `[]` for `off`/`all`
 * (only `teams` mode uses it), and duplicates are dropped.
 */
export async function setPluginEntitlement(
  db: AppQueryable,
  orgId: string,
  name: string,
  entitlement: PluginEntitlement,
): Promise<void> {
  if (!isMode(entitlement.mode)) {
    throw new ValidationError(`mode must be one of ${MODES.join(", ")}`);
  }

  let teamIds: string[] = [];
  if (entitlement.mode === "teams") {
    // Dedupe first, then validate every id belongs to this org's teams.
    const requested = Array.from(new Set(entitlement.teamIds));
    if (requested.length > 0) {
      const rows = await db
        .select({ id: teams.id, orgId: teams.orgId })
        .from(teams)
        .where(eq(teams.orgId, orgId));
      const orgTeamIds = new Set(rows.map((r) => r.id));
      for (const id of requested) {
        if (!orgTeamIds.has(id)) {
          throw new ValidationError(
            `team '${id}' is not a team of this organization. Pick teams from the org's team list.`,
          );
        }
      }
    }
    teamIds = requested;
  }

  await entitlementStore(db, orgId).put<PluginEntitlement>(ENTITLEMENTS_COLLECTION, name, {
    mode: entitlement.mode,
    teamIds,
  });
}

/**
 * Whether the org mode admits `userId` for `name`. The org-scope half of the
 * gate — the caller must also confirm the plugin is instance-loaded.
 *
 *  - `off`   → false, always.
 *  - `all`   → true, always (also the default for an unconfigured plugin).
 *  - `teams` → true only when the user is a member of a listed team.
 *
 * `teams` mode with an empty team list admits nobody, which is the honest
 * answer: no team is listed, so no member qualifies.
 */
export async function orgAllowsPluginForUser(
  db: AppQueryable,
  orgId: string,
  userId: string,
  name: string,
): Promise<boolean> {
  const entitlement = await getPluginEntitlement(db, orgId, name);
  if (entitlement.mode === "off") return false;
  if (entitlement.mode === "all") return true;
  if (entitlement.teamIds.length === 0) return false;
  // Reuse the live membership check (never cached), keyed by team id. A user
  // in ANY listed team qualifies.
  const memberRows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, entitlement.teamIds)));
  return memberRows.length > 0;
}
