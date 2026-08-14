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
import { and, eq, isNull, like, notLike } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { invites, llmProviders, orgMembers, orgs, skillSources, skills, teams, teamMembers, users } from "../schema/index.js";
import type { InstanceConfig } from "../config/instance-config.js";
import { InstanceConfigError } from "../config/instance-config.js";
import {
  ensureOrg,
  renameOrg,
  setOrgModelPreferences,
  setOrgMemberRole,
  LAST_ADMIN_ERROR,
} from "./org.js";
import {
  createLlmProvider,
  updateLlmProvider,
  listLlmProviders,
  isKnownProviderKind,
  type LlmProviderKind,
} from "./llm-providers.js";
import { parseRepoInput } from "./skill-sources.js";

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
              throw new InstanceConfigError(
                `org.members would leave the organization with no admin: ${LAST_ADMIN_ERROR}. Keep at least one org.members entry with role: admin in the config file.`,
              );
            }
          }
        } else {
          // No membership row — insert. A prior partial reconcile or a
          // concurrent boot may have inserted it since the select above, so
          // ignore a conflict: the existing row's role is already reconciled
          // by the select/update path.
          await db.insert(orgMembers).values({
            orgId: org.id,
            userId: existingUser.id,
            role: decl.role,
            createdAt: Date.now(),
          }).onConflictDoNothing();
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
          // On conflict (a prior partial reconcile or concurrent boot already
          // inserted this id) update role + expiresAt, mirroring the update
          // path above.
          await db.insert(invites).values({
            id: inviteId,
            codeHash,
            email,
            role: decl.role,
            createdBy: "config",
            createdAt: now,
            expiresAt,
          }).onConflictDoUpdate({
            target: invites.id,
            set: { role: decl.role, expiresAt },
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
// Teams pass
// ---------------------------------------------------------------------------

async function reconcileTeamsPass(db: AppDb, cfg: InstanceConfig): Promise<void> {
  if (!cfg.teams) return;

  const org = await ensureOrg(db);

  for (const teamDecl of cfg.teams) {
    const teamId = configTeamId(teamDecl.name);

    // Insert the team if it does not already exist (keyed by name within the org).
    const existingTeam = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, org.id), eq(teams.name, teamDecl.name)))
      .limit(1);

    if (!existingTeam[0]) {
      // Insert with the deterministic id only if no team with this name exists.
      await db
        .insert(teams)
        .values({ id: teamId, orgId: org.id, name: teamDecl.name, createdAt: Date.now() })
        .onConflictDoNothing();
    }

    // Resolve the actual team id (may differ from configTeamId if a UI team was adopted).
    const teamRows = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, org.id), eq(teams.name, teamDecl.name)))
      .limit(1);
    const resolvedTeamId = teamRows[0]?.id;
    if (!resolvedTeamId) continue;

    // Members
    for (const memberDecl of teamDecl.members ?? []) {
      const email = memberDecl.email.toLowerCase();

      // Resolve email → user.
      const userRows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const foundUser = userRows[0];
      if (!foundUser) {
        console.warn(`[config-reconcile] team "${teamDecl.name}": user "${email}" not found — skipping`);
        continue;
      }

      // Check org membership.
      const orgMemberRows = await db
        .select({ role: orgMembers.role })
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, foundUser.id)))
        .limit(1);
      if (!orgMemberRows[0]) {
        console.warn(
          `[config-reconcile] team "${teamDecl.name}": user "${email}" is not an org member — skipping`,
        );
        continue;
      }

      // Upsert team_members row.
      const existingMember = await db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, resolvedTeamId), eq(teamMembers.userId, foundUser.id)))
        .limit(1);

      if (existingMember[0]) {
        if (existingMember[0].role !== memberDecl.role) {
          await db
            .update(teamMembers)
            .set({ role: memberDecl.role })
            .where(and(eq(teamMembers.teamId, resolvedTeamId), eq(teamMembers.userId, foundUser.id)));
        }
      } else {
        // A prior partial reconcile or concurrent boot may have inserted this
        // row since the select above; the existing row's role is already
        // reconciled by the select/update path, so ignore a conflict.
        await db.insert(teamMembers).values({
          teamId: resolvedTeamId,
          userId: foundUser.id,
          role: memberDecl.role,
        }).onConflictDoNothing();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LLM providers pass
// ---------------------------------------------------------------------------

async function reconcileLlmProvidersPass(db: AppDb, cfg: InstanceConfig): Promise<void> {
  if (!cfg.llmProviders) return;

  const org = await ensureOrg(db);
  const orgId = org.id;

  for (const provDecl of cfg.llmProviders) {
    const kind = provDecl.kind as LlmProviderKind;
    const declaredName = provDecl.name ?? kind;
    const declaredEnabled = provDecl.enabled ?? true;
    const declaredModels = provDecl.models?.map((m) => ({ id: m.id, name: m.name ?? m.id }));

    if (isKnownProviderKind(kind)) {
      // Singleton by kind — find or create.
      const existingRows = await listLlmProviders(db, orgId);
      const existing = existingRows.find((r) => r.kind === kind);

      if (existing) {
        await updateLlmProvider(db, orgId, existing.id, {
          name: provDecl.name ?? existing.name,
          enabled: declaredEnabled,
          ...(declaredModels !== undefined ? { models: declaredModels } : {}),
          ...(provDecl.baseUrl !== undefined ? { baseUrl: provDecl.baseUrl } : {}),
        });
      } else {
        await createLlmProvider(db, {
          orgId,
          kind,
          name: declaredName,
          baseUrl: provDecl.baseUrl,
          models: declaredModels,
          enabled: declaredEnabled,
        });
      }
    } else {
      // openai_compatible — keyed by name. Direct insert with deterministic id.
      // name is required (validator ensures it), so provDecl.name is always set here.
      const name = provDecl.name!;
      const provId = configProviderId(name);

      const existingRows = await listLlmProviders(db, orgId);
      const existing = existingRows.find((r) => r.kind === "openai_compatible" && r.name === name);

      if (existing) {
        await updateLlmProvider(db, orgId, existing.id, {
          enabled: declaredEnabled,
          ...(declaredModels !== undefined ? { models: declaredModels } : {}),
          ...(provDecl.baseUrl !== undefined ? { baseUrl: provDecl.baseUrl } : {}),
        });
      } else {
        // Direct insert to keep the deterministic id.
        const now = Date.now();
        await db.insert(llmProviders).values({
          id: provId,
          orgId,
          kind: "openai_compatible",
          name,
          baseUrl: provDecl.baseUrl ?? null,
          enabled: declaredEnabled,
          models: declaredModels ?? [],
          createdAt: now,
        }).onConflictDoNothing();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Skill sources pass
// ---------------------------------------------------------------------------

async function reconcileSkillSourcesPass(db: AppDb, cfg: InstanceConfig): Promise<void> {
  if (!cfg.skillSources) return;

  const org = await ensureOrg(db);
  const orgId = org.id;
  const now = Date.now();

  // Build the desired set of managed source ids.
  const desiredIds = new Set<string>();

  // Normalized dedupe: two entries can differ in raw repo string (e.g.
  // `obra/superpowers` vs `https://github.com/obra/superpowers.git`) or in ref
  // only yet still resolve to the same (repoFullName, subpath) pair, which
  // collides on the DB unique index. The validator's raw-string check misses
  // these variants, so normalize with `parseRepoInput` and reject the collision
  // here with a clean error BEFORE any insert (no partial write).
  const seenPairs = new Map<string, string>();
  for (const entry of cfg.skillSources) {
    const parsed = parseRepoInput(entry.repo, { ref: entry.ref, subpath: entry.subpath });
    const pairKey = `${parsed.repoFullName}|${parsed.subpath}`;
    const priorRepo = seenPairs.get(pairKey);
    if (priorRepo !== undefined) {
      throw new InstanceConfigError(
        `skillSources: "${priorRepo}" and "${entry.repo}" resolve to the same repository "${parsed.repoFullName}" and subpath "${parsed.subpath}". Remove one; a source can track only one ref.`,
      );
    }
    seenPairs.set(pairKey, entry.repo);
  }

  for (const entry of cfg.skillSources) {
    const parsed = parseRepoInput(entry.repo, { ref: entry.ref, subpath: entry.subpath });
    const { repoFullName, ref, subpath } = parsed;
    const desiredId = configSkillSourceId(repoFullName, ref, subpath);
    desiredIds.add(desiredId);

    // Check if the row already exists with the desired id.
    const existingById = await db
      .select({ id: skillSources.id })
      .from(skillSources)
      .where(eq(skillSources.id, desiredId))
      .limit(1);

    if (existingById[0]) {
      // Already managed — done.
      continue;
    }

    // Check for an UNMANAGED row tracking the same (orgId, ownerType, ownerId, repoFullName, subpath).
    // The unique index is on (orgId, ownerType, ownerId, repoFullName, subpath).
    const unmanagedRows = await db
      .select({ id: skillSources.id })
      .from(skillSources)
      .where(
        and(
          eq(skillSources.orgId, orgId),
          eq(skillSources.ownerType, "org"),
          eq(skillSources.ownerId, orgId),
          eq(skillSources.repoFullName, repoFullName),
          eq(skillSources.subpath, subpath),
          notLike(skillSources.id, "skillsrc_cfg_%"),
        ),
      )
      .limit(1);

    if (unmanagedRows[0]) {
      console.warn(
        `[config-reconcile] skillSources: unmanaged row already tracks ${repoFullName}/${subpath} — skipping`,
      );
      continue;
    }

    // Insert org-owned skill source with deterministic id.
    await db.insert(skillSources).values({
      id: desiredId,
      orgId,
      ownerType: "org",
      ownerId: orgId,
      repoFullName,
      ref,
      subpath,
      enabled: true,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      lastSha: null,
      lastManifestHash: null,
      lastSyncedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
  }

  // Delete managed rows no longer in the desired set (two-delete: skills then source).
  const managedRows = await db
    .select({ id: skillSources.id })
    .from(skillSources)
    .where(
      and(
        eq(skillSources.orgId, orgId),
        like(skillSources.id, "skillsrc_cfg_%"),
      ),
    );

  for (const row of managedRows) {
    if (!desiredIds.has(row.id)) {
      await db.transaction(async (tx) => {
        await tx.delete(skills).where(and(eq(skills.sourceId, row.id), eq(skills.origin, "repo")));
        await tx.delete(skillSources).where(eq(skillSources.id, row.id));
      });
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

  // Pass 2: teams
  await reconcileTeamsPass(db, cfg);

  // Pass 3: llmProviders
  await reconcileLlmProvidersPass(db, cfg);

  // Pass 4: skillSources
  await reconcileSkillSourcesPass(db, cfg);
}
