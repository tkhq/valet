import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ActionPlugin, ValetPlugin } from "@valet/engine";
import type { AppDb, AppQueryable, AppTx } from "../lib/drizzle.js";
import { canonicalJson } from "../lib/canonical-json.js";
import { actionInvocations, actionPolicies, actionPolicyOverrides, orgs, policyActiveBundles, policySourceBundles, teams } from "../schema/index.js";
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
  return { ...base, ...source, sourceRevision: revision(source) } as CurrentPolicySourceSnapshotV1;
}

export class CanonicalPolicyBundleManager {
  readonly runtime = new WasmPolicyRuntime();
  readonly host: SourceBundleHost;
  constructor(readonly db: AppDb, readonly plugins: ActionPluginByService, private readonly now: () => number = Date.now) {
    this.host = new SourceBundleHost(new PostgresSourceBundleStorage(db, now), this.runtime);
  }
  async buildCurrent(organizationId: string) {
    const snapshot = await currentPolicySnapshot(this.db, organizationId, this.plugins);
    const built = buildCurrentPolicySource(snapshot);
    const identity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: built.bundle });
    return { snapshot, built, identity };
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
    const loaded = await this.host.load(pointer.sourceBundleDigest);
    if (loaded.identity.sourceBundleDigest !== expected.identity.sourceBundleDigest && !(await isRecordedCandidate(this.db, organizationId, pointer.sourceBundleDigest))) {
      throw new Error(`Canonical policy pointer for ${organizationId} is stale. Publish the exact current policy before startup.`);
    }
  }
  async activateCandidate(organizationId: string, expected: ValidatedBundleIdentity, bundle: CanonicalSourceBundle, audit: { actorId: string; operation: string; idempotencyKey: string }): Promise<void> {
    const validated = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle });
    if (canonicalJson(validated) !== canonicalJson(expected)) throw new Error("Canonical policy candidate identity changed.");
    await this.runtime.loadBundle(validated.sourceBundleDigest, bundle);
    await this.db.transaction(async (tx) => {
      const pointer = (await tx.select().from(policyActiveBundles).where(eq(policyActiveBundles.orgId, organizationId)).for("update").limit(1))[0];
      if (!pointer) throw new Error(`Canonical policy pointer for ${organizationId} is missing.`);
      await putBundle(tx, validated.sourceBundleDigest, bundle, this.now());
      const changed = await tx.update(policyActiveBundles).set({ digest: validated.sourceBundleDigest, generation: pointer.generation + 1, activatedAt: this.now() }).where(and(eq(policyActiveBundles.orgId, organizationId), eq(policyActiveBundles.digest, pointer.digest), eq(policyActiveBundles.generation, pointer.generation))).returning({ orgId: policyActiveBundles.orgId });
      if (!changed[0]) throw new Error("Canonical policy candidate activation lost its compare-and-swap.");
      const invocationId = activationAuditId(organizationId, pointer.digest, audit);
      await tx.insert(actionInvocations).values({ invocationId, service: "canonical-policy", actionId: audit.operation, status: "completed", userId: audit.actorId, orgId: organizationId, params: { priorDigest: pointer.digest, sourceBundleDigest: validated.sourceBundleDigest, generation: pointer.generation + 1, canonicalCandidate: true }, createdAt: this.now() });
    });
  }

  async mutateAndActivate<T>(organizationId: string, audit: { actorId: string; operation: string; idempotencyKey: string }, mutate: (tx: AppTx) => Promise<T>): Promise<T> {
    let completed = false;
    const result = await this.db.transaction(async (tx) => {
      const pointer = (await tx.select().from(policyActiveBundles).where(eq(policyActiveBundles.orgId, organizationId)).for("update").limit(1))[0];
      if (!pointer) throw new Error(`Canonical policy pointer for ${organizationId} is missing.`);
      const before = await currentPolicySnapshot(tx, organizationId, this.plugins);
      const beforeBuilt = buildCurrentPolicySource(before);
      const beforeIdentity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: beforeBuilt.bundle });
      if (beforeIdentity.sourceBundleDigest !== pointer.digest) throw new Error(`Canonical policy pointer for ${organizationId} is stale.`);
      const value = await mutate(tx);
      const after = await currentPolicySnapshot(tx, organizationId, this.plugins);
      const built = buildCurrentPolicySource(after);
      const identity = await this.runtime.run<ValidatedBundleIdentity>({ operation: "validate_bundle", bundle: built.bundle });
      if (identity.sourceBundleDigest === pointer.digest) { completed = true; return value; }
      await this.runtime.loadBundle(identity.sourceBundleDigest, built.bundle);
      await putBundle(tx, identity.sourceBundleDigest, built.bundle, this.now());
      const changed = await tx.update(policyActiveBundles).set({ digest: identity.sourceBundleDigest, generation: pointer.generation + 1, activatedAt: this.now() }).where(and(eq(policyActiveBundles.orgId, organizationId), eq(policyActiveBundles.digest, pointer.digest), eq(policyActiveBundles.generation, pointer.generation))).returning({ orgId: policyActiveBundles.orgId });
      if (!changed[0]) throw new Error("Canonical policy activation lost its compare-and-swap.");
      await tx.insert(actionInvocations).values({ invocationId: activationAuditId(organizationId, pointer.digest, audit), service: "canonical-policy", actionId: audit.operation, status: "completed", userId: audit.actorId, orgId: organizationId, params: { priorDigest: pointer.digest, sourceBundleDigest: identity.sourceBundleDigest, generation: pointer.generation + 1 }, createdAt: this.now() });
      completed = true;
      return value;
    });
    if (!completed) throw new Error("Canonical policy activation did not complete.");
    return result;
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
    const loaded = await manager.host.load(pointer.sourceBundleDigest);
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
      if (!inserted[0]) throw new Error(`Canonical policy pointer for ${item.organizationId} changed during startup readiness.`);
    }
  });
}

async function putBundle(db: AppQueryable, digest: string, bundle: CanonicalSourceBundle, now: number): Promise<void> {
  const inserted = await db.insert(policySourceBundles).values({ digest, bundle, createdAt: now }).onConflictDoNothing().returning({ digest: policySourceBundles.digest });
  if (!inserted[0]) {
    const row = (await db.select({ bundle: policySourceBundles.bundle }).from(policySourceBundles).where(eq(policySourceBundles.digest, digest)).limit(1))[0];
    if (!row || canonicalJson(row.bundle) !== canonicalJson(bundle)) throw new Error("Canonical source bundle digest collision.");
  }
}
function activationAuditId(organizationId: string, priorDigest: string, audit: { operation: string; idempotencyKey: string }): string {
  const digest = createHash("sha256").update(`${organizationId}\0${priorDigest}\0${audit.operation}\0${audit.idempotencyKey}`).digest("hex");
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
