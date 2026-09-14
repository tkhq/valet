import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import type { AppDb, AppQueryable, AppTx } from "../lib/drizzle.js";
import { canonicalJson } from "../lib/canonical-json.js";
import { actionInvocations, actionPolicies, actionPolicyOverrides, orgs, policyActiveBundles, policySourceBundles, runtimeGrants, teams } from "../schema/index.js";
import { buildCurrentPolicySource, standardNewOrganizationPolicySnapshot } from "./bundles/current-policy-source.js";
import type { CurrentPolicySourceSnapshotV1 } from "./bundles/current-policy-types.js";
import { SourceBundleHost } from "./bundles/host.js";
import { PostgresSourceBundleStorage } from "./bundles/postgres-storage.js";
import type { CanonicalSourceBundle, ValidatedBundleIdentity } from "./bundles/types.js";
import { WasmPolicyRuntime } from "./evaluators/wasm-runtime.js";

export type ActionPluginByService = ReadonlyMap<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>;

export async function currentPolicySnapshot(db: AppQueryable, organizationId: string, plugins: ActionPluginByService): Promise<CurrentPolicySourceSnapshotV1> {
  const [policyRows, overrideRows, teamRows] = await Promise.all([
    db.select().from(actionPolicies).where(eq(actionPolicies.orgId, organizationId)),
    db.select().from(actionPolicyOverrides).where(eq(actionPolicyOverrides.orgId, organizationId)),
    db.select({ id: teams.id }).from(teams).where(eq(teams.orgId, organizationId)),
  ]);
  const existingTeamIds = new Set(teamRows.map((row) => row.id));
  const teamIds = [...new Set(policyRows.filter((row) => row.principalType === "team").map((row) => row.principalId))].sort();
  if (teamIds.some((id) => !existingTeamIds.has(id))) throw new Error("Canonical policy source references a missing team.");
  const common = (row: typeof policyRows[number]) => ({
    id: row.id, organizationId, principalType: row.principalType as "org" | "team", principalId: row.principalId,
    ...(row.service ? { service: row.service } : row.actionId ? { actionId: row.actionId } : { riskLevel: row.riskLevel! }),
    mode: row.mode, paramMatchers: row.paramMatchers, appliesIn: row.appliesIn, expiresAtMs: row.expiresAt,
    revokedAtMs: row.revokedAt, createdAtMs: row.createdAt, updatedAtMs: row.updatedAt,
    sourceTable: "action_policies" as const, sourcePath: `action_policies/${row.id}`,
  });
  const pluginDefaults = canonicalPluginDefaults(plugins);
  const base = standardNewOrganizationPolicySnapshot(organizationId);
  const source = {
    teamIds,
    organizationPolicies: policyRows.filter((row) => row.principalType === "org").map(common),
    teamPolicies: policyRows.filter((row) => row.principalType === "team").map(common),
    personalOverrides: overrideRows.map((row) => ({
      id: row.id, organizationId, userId: row.userId,
      ...(row.service ? { service: row.service } : row.actionId ? { actionId: row.actionId } : { riskLevel: row.riskLevel! }),
      mode: row.mode, paramMatchers: row.paramMatchers, createdAtMs: row.createdAt, updatedAtMs: row.updatedAt,
      sourceTable: "action_policy_overrides" as const, sourcePath: `action_policy_overrides/${row.id}`,
    })),
    pluginDefaults,
  };
  const activeTeamPolicies = source.teamPolicies.filter((row) => row.revokedAtMs === null);
  const activeSource = {
    ...source,
    teamIds: [...new Set(activeTeamPolicies.map((row) => row.principalId))].sort(),
    organizationPolicies: source.organizationPolicies.filter((row) => row.revokedAtMs === null),
    teamPolicies: activeTeamPolicies,
  };
  return { ...base, ...source, sourceRevision: revision(activeSource) } as CurrentPolicySourceSnapshotV1;
}

export interface CanonicalOverrideBoundPolicyReference {
  readonly principalType: "org" | "team";
  readonly principalId: string;
  readonly service: string | null;
  readonly actionId: string | null;
}

export interface CanonicalPolicyMutationContext {
  overrideBoundsIdentity(options?: { includeTeamPolicies?: boolean }): Promise<ValidatedBundleIdentity>;
  overrideBoundPolicyReferences(options?: { includeTeamPolicies?: boolean }): readonly CanonicalOverrideBoundPolicyReference[];
}

/** A reviewed authored bundle is the active source of truth, so row-backed
 * writers must not mutate shadow state that the evaluator would ignore. */
export class CanonicalPolicySourceReadOnlyError extends Error {
  readonly code = "canonical_policy_source_read_only";
  readonly statusCode = 409;
  constructor(readonly organizationId: string) {
    super(`Canonical policy for ${organizationId} is owned by a published candidate. Publish a reviewed replacement candidate to change it.`);
    this.name = "CanonicalPolicySourceReadOnlyError";
  }
}

export class CanonicalPolicyConfigManagedError extends Error {
  readonly code = "canonical_policy_config_managed";
  readonly statusCode = 409;
  constructor(readonly organizationId: string, readonly configFile: string) {
    super(`Canonical policy for ${organizationId} is managed by toolPolicies in ${configFile}. Remove toolPolicies and restart before you publish a candidate.`);
    this.name = "CanonicalPolicyConfigManagedError";
  }
}

export interface CanonicalReleaseMigrationInput {
  readonly organizationId: string;
  readonly source: "structured" | "authored";
  readonly active: { readonly sourceBundleDigest: string; readonly generation: number };
  readonly bundle: CanonicalSourceBundle;
}

interface ReleasePointerSnapshot { readonly orgId: string; readonly digest: string; readonly generation: number }
interface ReleaseAuditSnapshot { readonly orgId: string | null; readonly params: unknown }

export function sameConcurrentReleaseTarget(
  current: readonly ReleasePointerSnapshot[],
  audits: readonly ReleaseAuditSnapshot[],
  targetRelease: string,
): boolean {
  return current.every((pointer) => audits.some((row) => row.orgId === pointer.orgId && row.params && typeof row.params === "object" && !Array.isArray(row.params)
    && (row.params as Record<string, unknown>).targetRelease === targetRelease
    && (row.params as Record<string, unknown>).sourceBundleDigest === pointer.digest
    && (row.params as Record<string, unknown>).generation === pointer.generation));
}

/** Read-only policy builder bound to one database scope. Release migration
 * uses a transaction instance so every snapshot observes the locked state. */
export class CanonicalPolicyBuildManager {
  constructor(readonly db: AppQueryable, readonly plugins: ActionPluginByService, readonly runtime: WasmPolicyRuntime) {}
  async buildCurrent(organizationId: string) {
    const snapshot = await currentPolicySnapshot(this.db, organizationId, this.plugins);
    const built = buildCurrentPolicySource(snapshot);
    const identity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: built.bundle });
    return { snapshot, built, identity };
  }
}

export class CanonicalPolicyBundleManager extends CanonicalPolicyBuildManager {
  readonly host: SourceBundleHost;
  private readonly configManaged = new Map<string, string>();
  constructor(override readonly db: AppDb, plugins: ActionPluginByService, private readonly now: () => number = Date.now) {
    const runtime = new WasmPolicyRuntime();
    super(db, plugins, runtime);
    this.host = new SourceBundleHost(new PostgresSourceBundleStorage(db, now), runtime);
  }
  setConfigManagedToolPolicies(organizationId: string, configFile?: string): void {
    if (configFile) this.configManaged.set(organizationId, configFile);
    else this.configManaged.delete(organizationId);
  }
  async ensureOrganizationReady(organizationId: string): Promise<void> {
    const expected = await this.buildCurrent(organizationId);
    const pointer = await this.host.activePointer(organizationId);
    if (!pointer) {
      const published = await this.host.publish(expected.built.bundle);
      if (published.sourceBundleDigest !== expected.identity.sourceBundleDigest) throw new Error("Canonical policy publication identity changed.");
      await this.host.activate(organizationId, undefined, published.sourceBundleDigest);
      return;
    }
    const loaded = await this.host.loadActive(organizationId);
    if (loaded.identity.sourceBundleDigest !== expected.identity.sourceBundleDigest && !(await isRecordedCandidate(this.db, organizationId, pointer.sourceBundleDigest))) {
      throw new Error(`Canonical policy pointer for ${organizationId} is stale. Publish the exact current policy before startup.`);
    }
  }
  async activateCandidate(organizationId: string, expected: ValidatedBundleIdentity, bundle: CanonicalSourceBundle, audit: { actorId: string; operation: string; idempotencyKey: string }): Promise<void> {
    const configFile = this.configManaged.get(organizationId);
    if (configFile) throw new CanonicalPolicyConfigManagedError(organizationId, configFile);
    const validated = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle });
    if (canonicalJson(validated) !== canonicalJson(expected)) throw new Error("Canonical policy candidate identity changed.");
    await this.runtime.loadBundle(validated.sourceBundleDigest, bundle);
    await this.db.transaction(async (tx) => {
      const pointer = (await tx.select().from(policyActiveBundles).where(eq(policyActiveBundles.orgId, organizationId)).for("update").limit(1))[0];
      if (!pointer) throw new Error(`Canonical policy pointer for ${organizationId} is missing.`);
      if (pointer.digest === validated.sourceBundleDigest) return;
      await putBundle(tx, validated.sourceBundleDigest, bundle, this.now());
      const changed = await tx.update(policyActiveBundles).set({ digest: validated.sourceBundleDigest, generation: pointer.generation + 1, activatedAt: this.now() }).where(and(eq(policyActiveBundles.orgId, organizationId), eq(policyActiveBundles.digest, pointer.digest), eq(policyActiveBundles.generation, pointer.generation))).returning({ orgId: policyActiveBundles.orgId });
      if (!changed[0]) throw new Error("Canonical policy candidate activation lost its compare-and-swap.");
      const invocationId = activationAuditId(organizationId, pointer.digest, pointer.generation + 1, audit);
      await tx.insert(actionInvocations).values({ invocationId, service: "canonical-policy", actionId: audit.operation, status: "completed", userId: audit.actorId, orgId: organizationId, params: { priorDigest: pointer.digest, sourceBundleDigest: validated.sourceBundleDigest, generation: pointer.generation + 1, canonicalCandidate: true }, createdAt: this.now() });
    });
  }

  async mutateAndActivate<T>(organizationId: string, audit: { actorId: string; operation: string; idempotencyKey: string }, mutate: (tx: AppTx, context: CanonicalPolicyMutationContext) => Promise<T>): Promise<T> {
    let completed = false;
    const result = await this.db.transaction(async (tx) => {
      const pointer = (await tx.select().from(policyActiveBundles).where(eq(policyActiveBundles.orgId, organizationId)).for("update").limit(1))[0];
      if (!pointer) throw new Error(`Canonical policy pointer for ${organizationId} is missing.`);
      const before = await currentPolicySnapshot(tx, organizationId, this.plugins);
      const beforeBuilt = buildCurrentPolicySource(before);
      const beforeIdentity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: beforeBuilt.bundle });
      if (beforeIdentity.sourceBundleDigest !== pointer.digest) {
        if (await isRecordedCandidate(tx, organizationId, pointer.digest)) throw new CanonicalPolicySourceReadOnlyError(organizationId);
        throw new Error(`Canonical policy pointer for ${organizationId} is stale.`);
      }
      const boundsIdentities = new Map<boolean, Promise<ValidatedBundleIdentity>>();
      const activeOrganizationPolicies = before.organizationPolicies.filter((row) => row.revokedAtMs === null);
      const activeTeamPolicies = before.teamPolicies.filter((row) => row.revokedAtMs === null);
      const context: CanonicalPolicyMutationContext = {
        overrideBoundPolicyReferences: ({ includeTeamPolicies = true } = {}) => [...activeOrganizationPolicies, ...(includeTeamPolicies ? activeTeamPolicies : [])].map((row) => ({ principalType: row.principalType, principalId: row.principalId, service: row.service ?? null, actionId: row.actionId ?? null })),
        overrideBoundsIdentity: ({ includeTeamPolicies = true } = {}) => {
          let identity = boundsIdentities.get(includeTeamPolicies);
          if (!identity) {
            identity = (async () => {
              const boundsBuilt = buildCurrentPolicySource({ ...before, personalOverrides: [], organizationPolicies: before.organizationPolicies.map((row) => ({ ...row, paramMatchers: [] })), teamPolicies: includeTeamPolicies ? before.teamPolicies.map((row) => ({ ...row, paramMatchers: [] })) : [] });
              const validated = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: boundsBuilt.bundle });
              await this.runtime.loadBundle(validated.sourceBundleDigest, boundsBuilt.bundle);
              return validated;
            })();
            boundsIdentities.set(includeTeamPolicies, identity);
          }
          return identity;
        },
      };
      const value = await mutate(tx, context);
      const after = await currentPolicySnapshot(tx, organizationId, this.plugins);
      const built = buildCurrentPolicySource(after);
      const identity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: built.bundle });
      if (identity.sourceBundleDigest === pointer.digest) { completed = true; return value; }
      await this.runtime.loadBundle(identity.sourceBundleDigest, built.bundle);
      await putBundle(tx, identity.sourceBundleDigest, built.bundle, this.now());
      const changed = await tx.update(policyActiveBundles).set({ digest: identity.sourceBundleDigest, generation: pointer.generation + 1, activatedAt: this.now() }).where(and(eq(policyActiveBundles.orgId, organizationId), eq(policyActiveBundles.digest, pointer.digest), eq(policyActiveBundles.generation, pointer.generation))).returning({ orgId: policyActiveBundles.orgId });
      if (!changed[0]) throw new Error("Canonical policy activation lost its compare-and-swap.");
      await tx.insert(actionInvocations).values({ invocationId: activationAuditId(organizationId, pointer.digest, pointer.generation + 1, audit), service: "canonical-policy", actionId: audit.operation, status: "completed", userId: audit.actorId, orgId: organizationId, params: { priorDigest: pointer.digest, sourceBundleDigest: identity.sourceBundleDigest, generation: pointer.generation + 1 }, createdAt: this.now() });
      completed = true;
      return value;
    });
    if (!completed) throw new Error("Canonical policy activation did not complete.");
    return result;
  }

  /** Offline, all-tenant release-set replacement. The advisory lock is held
   * from planning through the pointer transaction, so no process can publish a
   * partial engine/profile/plugin/source migration. */
  async migrateReleaseSet(
    targetRelease: string,
    replacement: (input: CanonicalReleaseMigrationInput, manager: CanonicalPolicyBuildManager) => Promise<CanonicalSourceBundle>,
  ): Promise<void> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(targetRelease)) throw new Error("Canonical release identifier is invalid.");
    await this.db.transaction(async (tx) => {
      const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(1447382105) as acquired`);
      if (!releaseLockAcquired(lock)) {
        await tx.execute(sql`select pg_advisory_xact_lock(1447382105)`);
        const pointers = await tx.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId).for("update");
        const winner = await tx.select({ orgId: actionInvocations.orgId, params: actionInvocations.params })
          .from(actionInvocations)
          .where(and(eq(actionInvocations.service, "canonical-policy"), eq(actionInvocations.actionId, "release_set_migration")));
        if (!sameConcurrentReleaseTarget(pointers, winner, targetRelease)) throw new Error("Canonical release migration lost a concurrent target race. Retry only after you verify the active release set.");
        return;
      }
      const pointers = await tx.select().from(policyActiveBundles).orderBy(policyActiveBundles.orgId).for("update");
      const transactionManager = new CanonicalPolicyBuildManager(tx, this.plugins, this.runtime);

      // Legacy grants lack one or more facts required by the canonical grant
      // contract. Revoke them in the release transaction so they re-gate.
      const revoked = await tx.update(runtimeGrants).set({ revokedAt: this.now() }).where(sql`
        ${runtimeGrants.revokedAt} is null and (
          ${runtimeGrants.service} is null or ${runtimeGrants.actionId} is null or
          ${runtimeGrants.riskLevel} is null or ${runtimeGrants.sourceApprovalId} is null or
          ${runtimeGrants.service} = '' or ${runtimeGrants.actionId} = '' or ${runtimeGrants.sourceApprovalId} = '' or
          ${runtimeGrants.expiresAt} is null or ${runtimeGrants.policyKey} <> ${runtimeGrants.actionId} or
          ${runtimeGrants.actionId} not like ${runtimeGrants.service} || '.%' or
          ${runtimeGrants.expiresAt} <= ${runtimeGrants.createdAt} or
          ${runtimeGrants.expiresAt} > ${runtimeGrants.createdAt} + ${72 * 60 * 60 * 1000}
        )
      `).returning({ id: runtimeGrants.id, orgId: runtimeGrants.orgId });
      for (const grant of revoked) {
        await tx.insert(actionInvocations).values({
          invocationId: `policy:release:${createHash("sha256").update(`${targetRelease}\0legacy-grant\0${grant.id}`).digest("hex")}`,
          service: "canonical-policy", actionId: "legacy_runtime_grant_revoked", status: "completed",
          userId: "release-migration", orgId: grant.orgId, params: { targetRelease, grantId: grant.id, treatment: "re_gate" }, createdAt: this.now(),
        }).onConflictDoNothing();
      }

      const plans: { pointer: typeof pointers[number]; bundle: CanonicalSourceBundle; identity: ValidatedBundleIdentity; authored: boolean }[] = [];
      for (const pointer of pointers) {
        const stored = (await tx.select({ bundle: policySourceBundles.bundle }).from(policySourceBundles).where(eq(policySourceBundles.digest, pointer.digest)).limit(1))[0];
        if (!stored) throw new Error(`Canonical policy bundle ${pointer.digest} is missing.`);
        const authored = await isRecordedCandidate(tx, pointer.orgId, pointer.digest);
        const bundle = await replacement({ organizationId: pointer.orgId, source: authored ? "authored" : "structured", active: { sourceBundleDigest: pointer.digest, generation: pointer.generation }, bundle: stored.bundle }, transactionManager);
        if (authored && canonicalJson(bundle.files) !== canonicalJson(stored.bundle.files)) throw new Error(`Authored policy source for ${pointer.orgId} changed during release migration.`);
        const identity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle });
        await this.runtime.loadBundle(identity.sourceBundleDigest, bundle);
        plans.push({ pointer, bundle, identity, authored });
      }
      for (const plan of plans) {
        const changed = plan.identity.sourceBundleDigest !== plan.pointer.digest;
        if (changed) {
          await putBundle(tx, plan.identity.sourceBundleDigest, plan.bundle, this.now());
          const updated = await tx.update(policyActiveBundles).set({ digest: plan.identity.sourceBundleDigest, generation: plan.pointer.generation + 1, activatedAt: this.now() }).where(and(eq(policyActiveBundles.orgId, plan.pointer.orgId), eq(policyActiveBundles.digest, plan.pointer.digest), eq(policyActiveBundles.generation, plan.pointer.generation))).returning({ id: policyActiveBundles.orgId });
          if (!updated[0]) throw new Error(`Canonical release migration conflict for ${plan.pointer.orgId}.`);
        }
        const generation = plan.pointer.generation + Number(changed);
        await tx.insert(actionInvocations).values({ invocationId: `policy:release:${createHash("sha256").update(`${targetRelease}\0${plan.pointer.orgId}\0${plan.pointer.digest}\0${plan.identity.sourceBundleDigest}`).digest("hex")}`, service: "canonical-policy", actionId: "release_set_migration", status: "completed", userId: "release-migration", orgId: plan.pointer.orgId, params: { targetRelease, priorDigest: plan.pointer.digest, sourceBundleDigest: plan.identity.sourceBundleDigest, generation, source: plan.authored ? "authored" : "structured" }, createdAt: this.now() }).onConflictDoNothing();
      }
    });
  }

  async provisionOrganization(id: string, name = "My organization"): Promise<{ id: string }> {
    const pluginDefaults = canonicalPluginDefaults(this.plugins);
    const built = buildCurrentPolicySource({
      ...standardNewOrganizationPolicySnapshot(id),
      pluginDefaults,
      sourceRevision: revision({ teamIds: [], organizationPolicies: [], teamPolicies: [], personalOverrides: [], pluginDefaults }),
    });
    const identity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: built.bundle });
    await this.runtime.loadBundle(identity.sourceBundleDigest, built.bundle);
    await this.db.transaction(async (tx) => {
      await tx.insert(orgs).values({ id, name, createdAt: this.now() });
      await putBundle(tx, identity.sourceBundleDigest, built.bundle, this.now());
      await tx.insert(policyActiveBundles).values({ orgId: id, digest: identity.sourceBundleDigest, generation: 1, activatedAt: this.now() });
    });
    return { id };
  }
  close(): Promise<void> { return this.runtime.close(); }
}

export async function migrateCanonicalPolicyReleaseSet(manager: CanonicalPolicyBundleManager, targetRelease: string): Promise<void> {
  const template = buildCurrentPolicySource(standardNewOrganizationPolicySnapshot("release-template", targetRelease)).bundle;
  const compatibility = JSON.parse(template.manifestJson) as Record<string, unknown>;
  await manager.migrateReleaseSet(targetRelease, async (input, transactionManager) => {
    if (input.source === "structured") return (await transactionManager.buildCurrent(input.organizationId)).built.bundle;
    const manifest = JSON.parse(input.bundle.manifestJson) as Record<string, unknown>;
    for (const key of ["engineName", "engineVersion", "capabilityProfileVersion", "interpreter", "contractVersion", "regoVersion", "entrypoint"] as const) manifest[key] = compatibility[key];
    return { manifestJson: canonicalJson(manifest), files: input.bundle.files };
  });
}

export async function ensureCanonicalPolicyReadiness(manager: CanonicalPolicyBundleManager): Promise<void> {
  const rows = (await manager.db.select({ id: orgs.id }).from(orgs)).sort((a, b) => a.id.localeCompare(b.id));
  const missing: { organizationId: string; digest: string; bundle: CanonicalSourceBundle }[] = [];

  // Validate every tenant before changing any tenant. Startup readiness is one
  // fail-closed cutover, not a sequence that may leave a partially ready fleet.
  for (const row of rows) {
    const expected = await manager.buildCurrent(row.id);
    const pointer = await manager.host.activePointer(row.id);
    if (!pointer) {
      missing.push({ organizationId: row.id, digest: expected.identity.sourceBundleDigest, bundle: expected.built.bundle });
      continue;
    }
    const loaded = await manager.host.loadActive(row.id);
    if (loaded.identity.sourceBundleDigest !== expected.identity.sourceBundleDigest && !(await isRecordedCandidate(manager.db, row.id, pointer.sourceBundleDigest))) {
      throw new Error(`Canonical policy pointer for ${row.id} is stale. Publish the exact current policy before startup.`);
    }
  }

  if (missing.length === 0) return;
  for (const item of missing) await manager.runtime.loadBundle(item.digest, item.bundle);
  const now = Date.now();
  await manager.db.transaction(async (tx) => {
    for (const item of missing) {
      await putBundle(tx, item.digest, item.bundle, now);
      const inserted = await tx.insert(policyActiveBundles).values({ orgId: item.organizationId, digest: item.digest, generation: 1, activatedAt: now }).onConflictDoNothing().returning({ orgId: policyActiveBundles.orgId });
      if (!inserted[0]) {
        const winner = (await tx.select().from(policyActiveBundles).where(eq(policyActiveBundles.orgId, item.organizationId)).limit(1))[0];
        if (winner?.digest !== item.digest || winner.generation !== 1) throw new Error(`Canonical policy pointer for ${item.organizationId} changed during startup readiness.`);
      }
    }
  });
}

function releaseLockAcquired(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows)) throw new Error("Canonical release lock returned an invalid result.");
  const row: unknown = result.rows[0];
  if (!row || typeof row !== "object" || !("acquired" in row) || typeof row.acquired !== "boolean") throw new Error("Canonical release lock returned an invalid result.");
  return row.acquired;
}

async function putBundle(db: AppQueryable, digest: string, bundle: CanonicalSourceBundle, now: number): Promise<void> {
  const inserted = await db.insert(policySourceBundles).values({ digest, bundle, createdAt: now }).onConflictDoNothing().returning({ digest: policySourceBundles.digest });
  if (!inserted[0]) {
    const row = (await db.select({ bundle: policySourceBundles.bundle }).from(policySourceBundles).where(eq(policySourceBundles.digest, digest)).limit(1))[0];
    if (!row || canonicalJson(row.bundle) !== canonicalJson(bundle)) throw new Error("Canonical source bundle digest collision.");
  }
}
function activationAuditId(organizationId: string, priorDigest: string, generation: number, audit: { operation: string; idempotencyKey: string }): string {
  const digest = createHash("sha256").update(`${organizationId}\0${priorDigest}\0${generation}\0${audit.operation}\0${audit.idempotencyKey}`).digest("hex");
  return `policy:activation:${digest}`;
}
function canonicalPluginDefaults(plugins: ReadonlyMap<string, { plugin: ValetPlugin; actionPlugin: ActionPlugin }>) {
  return [...plugins.values()].filter(({ actionPlugin }) => actionPlugin.defaultApprovalMode !== undefined).map(({ actionPlugin }) => ({
    id: `plugin:${actionPlugin.service}`, service: actionPlugin.service, mode: actionPlugin.defaultApprovalMode!,
    sourcePath: `plugins/${actionPlugin.service}`,
  })).sort((a, b) => a.id.localeCompare(b.id));
}
function revision(value: unknown): string {
  return `current-policy:${createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort()) : item)).digest("hex")}`;
}

async function isRecordedCandidate(db: AppQueryable, organizationId: string, digest: string): Promise<boolean> {
  const rows = await db.select({ params: actionInvocations.params }).from(actionInvocations).where(and(eq(actionInvocations.orgId, organizationId), eq(actionInvocations.service, "canonical-policy"), eq(actionInvocations.actionId, "policy_authoring_publish")));
  return rows.some((row) => row.params && typeof row.params === "object" && !Array.isArray(row.params) && (row.params as Record<string, unknown>).canonicalCandidate === true && (row.params as Record<string, unknown>).sourceBundleDigest === digest);
}
