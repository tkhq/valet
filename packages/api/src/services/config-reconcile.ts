/**
 * Boot-time instance config reconciler.
 *
 * `reconcileInstanceConfig` applies the declarative `InstanceConfig` to the
 * live database. It runs sequentially through passes (org, then teams,
 * providers, skillSources, toolPolicies — later passes are appended here). Any
 * pass failure throws (boot fails); the function is idempotent.
 *
 * Id helpers produce stable, deterministic row ids for config-owned rows so
 * that repeated reconciliations produce the same primary keys and ON CONFLICT
 * logic can upsert safely.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, like, notLike, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import {
  actionPolicies,
  invites,
  llmProviders,
  orgMembers,
  orgs,
  skillSources,
  skills,
  teams,
  teamMembers,
  users,
  type TeamRow,
} from "../schema/index.js";
import type { InstanceConfig, ToolPolicyRule } from "../config/instance-config.js";
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
import type { SourceService } from "../bakes/source-service.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReconcileDeps {
  db: AppDb;
  /**
   * Path of the file `cfg` was read from. Named in the messages a team
   * collision or a promotion prints, so the reader knows which file to edit.
   */
  configPath?: string;
  sourceService?: SourceService;
}

/**
 * Names the instance config file in a message. The reader must be able to
 * open the file the message tells them to edit, so the fallback names the
 * variable that points at it.
 */
function configFileLabel(configPath: string | undefined): string {
  return configPath ?? "the instance config file (VALET_CONFIG)";
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

/**
 * Stable id for a config-managed team: `team_cfg_` + sha256(name).hex.slice(0,12)
 *
 * Cosmetic, unlike the invite and skill-source ids above. Those prefixes ARE
 * the ownership filter their prune loops select on. This one is only a
 * legible id for a row the reconciler happens to create: `teams.origin` is
 * the provenance marker, and a team adopted from the UI keeps the id it was
 * born with. Never match on this prefix.
 */
export function configTeamId(name: string): string {
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `team_cfg_${suffix}`;
}

/** Stable id for a config-managed LLM provider: `prov_cfg_` + sha256(name).hex.slice(0,12) */
export function configProviderId(name: string): string {
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `prov_cfg_${suffix}`;
}

/** Target dimension of a config-managed action policy. */
export type PolicyDimension = "service" | "action" | "risk";

/**
 * Stable id for a config-managed `action_policies` row, keyed by TARGET:
 * `pol:config:` + sha256(`${dimension}:${value}`).hex.slice(0,12). One managed
 * row per declared target, so re-declaring the same target upserts in place.
 */
export function configPolicyId(dimension: PolicyDimension, value: string): string {
  const suffix = createHash("sha256").update(`${dimension}:${value}`).digest("hex").slice(0, 12);
  return `pol:config:${suffix}`;
}

// ---------------------------------------------------------------------------
// Org pass
// ---------------------------------------------------------------------------

async function reconcileOrgPass(db: AppDb, cfg: InstanceConfig, sourceService?: SourceService): Promise<void> {
  const org = await ensureOrg(db, sourceService);

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

/** Identity is the name within the org, so every lookup here keys on it. */
async function findTeamByName(
  db: AppDb,
  orgId: string,
  name: string,
): Promise<{ id: string; name: string; origin: TeamRow["origin"]; externalId: string | null } | undefined> {
  const rows = await db
    .select({ id: teams.id, name: teams.name, origin: teams.origin, externalId: teams.externalId })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.name, name)))
    .limit(1);
  return rows[0];
}

/**
 * The refusal both collision checks below raise, so one wording covers both.
 *
 * The row's own spelling is named only when it differs from the declared
 * name. `teams_org_name` compares byte for byte, so `Platform` and
 * `platform` are two rows, and a reader told to rename "the team" has to
 * know which of the two holds the name.
 */
function idpCollisionError(
  declaredName: string,
  existing: { name: string; externalId: string | null },
  configPath: string | undefined,
): InstanceConfigError {
  const heldBy = existing.name === declaredName ? "" : ` Team "${existing.name}" holds that name.`;
  return new InstanceConfigError(
    `teams[].name "${declaredName}" is already the mirror of identity provider group ` +
      `"${existing.externalId ?? declaredName}".${heldBy} Rename the team in ` +
      `${configFileLabel(configPath)}, or rename the group in the identity provider and restart.`,
  );
}

/**
 * Fails boot when a mirrored team already holds the declared name in ANY
 * letter case.
 *
 * The exact-match path below refuses the same collision, but Postgres lets
 * the near miss through: `teams_org_name` compares byte for byte, so a file
 * that declares `Platform` beside a mirror of `/platform` would insert a
 * second row instead. The org would then hold two teams that read as one,
 * each asserted by a different writer, and no log line makes that visible.
 *
 * Case folding here only, not in the adoption lookup: promoting a `local`
 * team whose case differs would change which row the file owns, which is a
 * decision for the file's own semantics rather than a collision to refuse.
 */
async function assertNoIdpNearName(
  db: AppDb,
  orgId: string,
  name: string,
  configPath: string | undefined,
): Promise<void> {
  const rows = await db
    .select({ name: teams.name, externalId: teams.externalId })
    .from(teams)
    .where(
      and(eq(teams.orgId, orgId), eq(teams.origin, "idp"), sql`lower(${teams.name}) = lower(${name})`),
    )
    .limit(1);
  const clash = rows[0];
  if (clash) throw idpCollisionError(name, clash, configPath);
}

/**
 * Decides what the file may do with a team row that already holds the
 * declared name. Adoption is not free: after it, the file asserts that team's
 * members at every boot, so `origin` must name the reconciler as the writer
 * or it stops answering "who reasserts this row".
 *
 * An `idp` row is the one case that must fail boot. Adopting it would hand a
 * group's membership to the file while the login sync still removes everybody
 * the claim omits — the two writers would fight over the same rows, once per
 * boot and once per login. An operator cannot see that from a log line, so
 * the api refuses to start and names both fixes.
 */
async function adoptTeamForConfig(
  db: AppDb,
  existing: { id: string; name: string; origin: TeamRow["origin"]; externalId: string | null },
  name: string,
  configPath: string | undefined,
): Promise<string> {
  switch (existing.origin) {
    case "idp":
      throw idpCollisionError(name, existing, configPath);
    case "local":
      // Promote. The file now owns which members this team asserts, and a UI
      // demotion of a declared member is overwritten at the next boot, so a
      // row left at `local` would make `origin` a lie for every reader — the
      // badge in the teams panel, the delete guard, a future rename route.
      await db.update(teams).set({ origin: "config" }).where(eq(teams.id, existing.id));
      console.warn(
        `[config-reconcile] team "${name}" existed in Valet and is now declared in ` +
          `${configFileLabel(configPath)}. The file asserts its members from now on. To hand it back, ` +
          `remove it from the teams: list in that file and restart.`,
      );
      return existing.id;
    case "config":
      return existing.id;
  }
}

/**
 * Finds or creates the config-owned team for one declared name.
 *
 * The mirrored-name check runs FIRST, before the exact-match lookup. A file
 * that declares `Platform` beside a mirror of `/platform` must fail the same
 * way it fails on the exact name, and an exact-match `local` row would
 * otherwise be promoted while the near-name mirror stayed in place.
 *
 * The insert is followed by a second read through the same origin guard, not
 * by trusting the id it just wrote. `onConflictDoNothing` hides a lost race:
 * a login that mirrored a group of this name between the two statements would
 * otherwise slip an `idp` row into the resolved id and take its members.
 */
async function resolveConfigTeam(
  db: AppDb,
  orgId: string,
  name: string,
  configPath: string | undefined,
): Promise<string | undefined> {
  await assertNoIdpNearName(db, orgId, name, configPath);

  const existing = await findTeamByName(db, orgId, name);
  if (existing) return adoptTeamForConfig(db, existing, name, configPath);

  await db
    .insert(teams)
    .values({ id: configTeamId(name), orgId, name, origin: "config", createdAt: Date.now() })
    .onConflictDoNothing();

  const after = await findTeamByName(db, orgId, name);
  if (!after) return undefined;
  return adoptTeamForConfig(db, after, name, configPath);
}

/**
 * Hands back every team the file used to declare and no longer does.
 *
 * Demotion, never deletion. The file releases ownership; the people in the
 * team keep it. This is what makes `origin` recomputed state the reconciler
 * owns, so it stays true across edits to the file instead of recording only
 * how a row was born.
 *
 * An absent `teams:` key means this instance does not manage teams, so
 * nothing here runs — the same rule every other pass follows for its own
 * section. An EMPTY `teams: []` is a declaration of none, and it demotes all.
 */
async function demoteUndeclaredConfigTeams(
  db: AppDb,
  orgId: string,
  declaredNames: Set<string>,
  configPath: string | undefined,
): Promise<void> {
  const configTeams = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.orgId, orgId), eq(teams.origin, "config")));

  for (const row of configTeams) {
    if (declaredNames.has(row.name)) continue;
    await db.update(teams).set({ origin: "local" }).where(eq(teams.id, row.id));
    console.warn(
      `[config-reconcile] team "${row.name}" is no longer declared in ${configFileLabel(configPath)}. ` +
        `Valet owns it again and keeps its members. To delete it, use the teams page.`,
    );
  }
}

async function reconcileTeamsPass(
  db: AppDb,
  cfg: InstanceConfig,
  configPath: string | undefined,
): Promise<void> {
  if (!cfg.teams) return;

  const org = await ensureOrg(db);
  const declaredNames = new Set<string>();

  for (const teamDecl of cfg.teams) {
    declaredNames.add(teamDecl.name);

    const resolvedTeamId = await resolveConfigTeam(db, org.id, teamDecl.name, configPath);
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

  await demoteUndeclaredConfigTeams(db, org.id, declaredNames, configPath);
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
// Tool policies pass
// ---------------------------------------------------------------------------

/**
 * Reconciles `cfg.toolPolicies` into `action_policies` org rows (PR #140's
 * policy engine). Each rule declares exactly one target (service/action/
 * riskLevel); the validator guarantees that shape. One managed row per target
 * (`pol:config:*` id). Upsert clears `revokedAt`, so re-declaring a removed
 * rule resurrects it. A managed row whose target is no longer declared is
 * soft-revoked (stamp `revokedAt`), never deleted — the action log keeps the
 * provenance. Rows without the `pol:config:` prefix (UI-created) are untouched.
 *
 * Runs only when `cfg.toolPolicies` is defined; absent = unmanaged.
 */
async function reconcileToolPoliciesPass(db: AppDb, cfg: InstanceConfig): Promise<void> {
  if (!cfg.toolPolicies) return;

  const org = await ensureOrg(db);
  const orgId = org.id;
  const now = Date.now();

  const desiredIds = new Set<string>();

  for (const rule of cfg.toolPolicies) {
    // Exactly one target dimension (validator-guaranteed). `action` maps to the
    // `actionId` column; the value is the fully-qualified `service.action` id.
    let id: string;
    let service: string | null = null;
    let actionId: string | null = null;
    let riskLevel: ToolPolicyRule["riskLevel"] | null = null;
    if (rule.service !== undefined) {
      id = configPolicyId("service", rule.service);
      service = rule.service;
    } else if (rule.action !== undefined) {
      id = configPolicyId("action", rule.action);
      actionId = rule.action;
    } else if (rule.riskLevel !== undefined) {
      id = configPolicyId("risk", rule.riskLevel);
      riskLevel = rule.riskLevel;
    } else {
      // Unreachable: the validator rejects a rule with no target dimension.
      throw new InstanceConfigError(
        "toolPolicies: a rule reached the reconciler with no target dimension. Set exactly one of service, action, riskLevel.",
      );
    }
    desiredIds.add(id);

    await db
      .insert(actionPolicies)
      .values({
        id,
        orgId,
        principalType: "org",
        principalId: orgId,
        service,
        actionId,
        riskLevel,
        mode: rule.mode,
        paramMatchers: [],
        appliesIn: rule.appliesIn ?? "any",
        origin: "admin",
        managedBy: "config",
        expiresAt: null,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: actionPolicies.id,
        set: {
          mode: rule.mode,
          appliesIn: rule.appliesIn ?? "any",
          // Re-declaring a previously removed rule resurrects it.
          revokedAt: null,
          updatedAt: now,
        },
      });
  }

  // Sweep: soft-revoke managed rows whose target is no longer declared. Never
  // touch rows without the `pol:config:` prefix (UI-created policies).
  const managedRows = await db
    .select({ id: actionPolicies.id, revokedAt: actionPolicies.revokedAt })
    .from(actionPolicies)
    .where(and(eq(actionPolicies.orgId, orgId), like(actionPolicies.id, "pol:config:%")));

  for (const row of managedRows) {
    if (!desiredIds.has(row.id) && row.revokedAt === null) {
      await db
        .update(actionPolicies)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(actionPolicies.id, row.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Public reconcile entry point
// ---------------------------------------------------------------------------

/**
 * Applies org/teams/llmProviders/skillSources/toolPolicies from `cfg` to the
 * database. Throws on any failure (boot fails). Idempotent.
 *
 * Structured as sequential passes so later tasks can append more passes here.
 */
export async function reconcileInstanceConfig(deps: ReconcileDeps, cfg: InstanceConfig): Promise<void> {
  const { db, configPath, sourceService } = deps;

  // Pass 1: org + members + invites
  await reconcileOrgPass(db, cfg, sourceService);

  // Pass 2: teams
  await reconcileTeamsPass(db, cfg, configPath);

  // Pass 3: llmProviders
  await reconcileLlmProvidersPass(db, cfg);

  // Pass 4: skillSources
  await reconcileSkillSourcesPass(db, cfg);

  // Pass 5: toolPolicies → action_policies
  await reconcileToolPoliciesPass(db, cfg);
}
