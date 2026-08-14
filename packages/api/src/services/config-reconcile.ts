/**
 * Boot-time instance config reconciler.
 *
 * `reconcileInstanceConfig` applies the declarative `InstanceConfig` to the
 * live database. It runs sequentially through passes (org, then teams,
 * providers, skillSources — later passes are appended here). Any pass failure
 * throws (boot fails); the function is idempotent.
 *
 * Id helpers produce stable, deterministic row ids for config-owned rows so
 * that repeated reconciliations produce the same primary keys and ON CONFLICT
 * logic can upsert safely.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, like } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { invites, orgMembers, orgs, users } from "../schema/index.js";
import type { InstanceConfig } from "../config/instance-config.js";
import {
  ensureOrg,
  renameOrg,
  setOrgModelPreferences,
  setOrgMemberRole,
  LAST_ADMIN_ERROR,
} from "./org.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  db: AppDb;
}

// ---------------------------------------------------------------------------
// Id helpers
// ---------------------------------------------------------------------------

/** Stable id for a config-managed invite row: `invite_cfg_` + sha256(email).hex.slice(0,12) */
export function configInviteId(email: string): string {
  const suffix = createHash("sha256").update(email).digest("hex").slice(0, 12);
  return `invite_cfg_${suffix}`;
}

/** Stable id for a config-managed skill source: `skillsrc_cfg_` + sha256(`${repo}|${ref}|${subpath}`).hex.slice(0,12) */
export function configSkillSourceId(repo: string, ref: string, subpath: string): string {
  const suffix = createHash("sha256")
    .update(`${repo}|${ref}|${subpath}`)
    .digest("hex")
    .slice(0, 12);
  return `skillsrc_cfg_${suffix}`;
}

/** Stable id for a config-managed team: `team_cfg_` + sha256(name).hex.slice(0,12) */
export function configTeamId(name: string): string {
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `team_cfg_${suffix}`;
}

/** Stable id for a config-managed LLM provider: `prov_cfg_` + sha256(name).hex.slice(0,12) */
export function configProviderId(name: string): string {
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `prov_cfg_${suffix}`;
}

// ---------------------------------------------------------------------------
// Org pass
// ---------------------------------------------------------------------------

async function reconcileOrgPass(db: AppDb, cfg: InstanceConfig): Promise<void> {
  const org = await ensureOrg(db);

  const orgCfg = cfg.org;
  if (!orgCfg) return;

  // name
  if (orgCfg.name !== undefined) {
    await renameOrg(db, org.id, orgCfg.name);
  }

  // features — merge declared keys into existing record, preserving undeclared keys
  if (orgCfg.features !== undefined) {
    const rows = await db.select({ features: orgs.features }).from(orgs).where(eq(orgs.id, org.id)).limit(1);
    const existing = (rows[0]?.features ?? {}) as Record<string, boolean>;
    const merged: Record<string, boolean> = { ...existing, ...orgCfg.features };
    await db.update(orgs).set({ features: merged }).where(eq(orgs.id, org.id));
  }

  // modelPreferences
  if (orgCfg.modelPreferences !== undefined) {
    await setOrgModelPreferences(db, org.id, orgCfg.modelPreferences);
  }

  // bareSkillCommands — direct column write
  if (orgCfg.bareSkillCommands !== undefined) {
    await db.update(orgs).set({ bareSkillCommands: orgCfg.bareSkillCommands }).where(eq(orgs.id, org.id));
  }

  // members
  if (orgCfg.members !== undefined) {
    const declaredEmails = new Set(orgCfg.members.map((m) => m.email.toLowerCase()));

    for (const decl of orgCfg.members) {
      const email = decl.email.toLowerCase();

      // Look up user by lowercased email.
      const userRows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const existingUser = userRows[0];

      if (existingUser) {
        // User exists — check for existing org_members row.
        const memberRows = await db
          .select({ role: orgMembers.role })
          .from(orgMembers)
          .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, existingUser.id)))
          .limit(1);

        if (memberRows[0]) {
          // Row exists — update role if changed.
          if (memberRows[0].role !== decl.role) {
            const result = await setOrgMemberRole(db, org.id, existingUser.id, decl.role);
            if (!result.ok && result.reason === "last_admin") {
              throw new Error(LAST_ADMIN_ERROR);
            }
          }
        } else {
          // No membership row — insert.
          await db.insert(orgMembers).values({
            orgId: org.id,
            userId: existingUser.id,
            role: decl.role,
            createdAt: Date.now(),
          });
        }
      } else {
        // User does not exist — upsert config invite row.
        const inviteId = configInviteId(email);
        const now = new Date();
        const expiresAt = new Date(Date.now() + 10 * 365 * 24 * 3600_000);

        // Try insert; on conflict (same id) update role + expiresAt only when unaccepted.
        const existing = await db
          .select({ id: invites.id, acceptedBy: invites.acceptedBy })
          .from(invites)
          .where(eq(invites.id, inviteId))
          .limit(1);

        if (existing[0]) {
          // Update role and expiresAt only if the invite is still unaccepted.
          if (existing[0].acceptedBy === null) {
            await db
              .update(invites)
              .set({ role: decl.role, expiresAt })
              .where(eq(invites.id, inviteId));
          }
        } else {
          // codeHash: sha256 of a random UUID — never redeemable by code;
          // admission matches by email via findValidInviteByEmail.
          const codeHash = createHash("sha256").update(randomUUID()).digest("hex");
          await db.insert(invites).values({
            id: inviteId,
            codeHash,
            email,
            role: decl.role,
            createdBy: "config",
            createdAt: now,
            expiresAt,
          });
        }
      }
    }

    // Delete unaccepted invite_cfg_* rows whose email is no longer declared.
    const configInviteRows = await db
      .select({ id: invites.id, email: invites.email })
      .from(invites)
      .where(and(like(invites.id, "invite_cfg_%"), isNull(invites.acceptedBy)));

    for (const row of configInviteRows) {
      if (row.email !== null && !declaredEmails.has(row.email.toLowerCase())) {
        await db.delete(invites).where(eq(invites.id, row.id));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public reconcile entry point
// ---------------------------------------------------------------------------

/**
 * Applies org/teams/llmProviders/skillSources from `cfg` to the database.
 * Throws on any failure (boot fails). Idempotent.
 *
 * Structured as sequential passes so later tasks can append teams, providers,
 * and skillSources passes here.
 */
export async function reconcileInstanceConfig(deps: ReconcileDeps, cfg: InstanceConfig): Promise<void> {
  const { db } = deps;

  // Pass 1: org + members + invites
  await reconcileOrgPass(db, cfg);

  // Pass 2: teams — appended by task 5
  // Pass 3: llmProviders — appended by task 5
  // Pass 4: skillSources — appended by task 5
}
