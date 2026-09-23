import { createHash, createHmac } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import {
  agentSessions,
  childWatches,
  githubInstallations,
  gitPushCommitMap,
  gitPushOperations,
  orgs,
  sessionGitBranches,
  sessionGitAttributionHeads,
  sessionGitAttributionSnapshots,
  teams,
  users,
} from "../schema/index.js";
import type {
  GitAttributionFieldSource,
  GitAttributionValues,
  GitCommitMode,
  GitSettingsOverrides,
  GitSignerCapabilities,
} from "../wire/types.js";

export const DEFAULT_GIT_ATTRIBUTION: GitAttributionValues = {
  mode: "user_unsigned",
  coAuthoredBy: false,
  correlationTrailers: false,
};
export const DEFAULT_VALET_IDENTITY = { name: "Valet Agent", email: "agent@valet.local" } as const;
const MODES = new Set<GitCommitMode>([
  "user_unsigned", "user_turnkey_signed", "valet_unsigned", "valet_app_signed",
]);

export function isGitCommitMode(value: unknown): value is GitCommitMode {
  return typeof value === "string" && MODES.has(value as GitCommitMode);
}

/** Identity and signing are one enum, so an invalid pair cannot be persisted. */
export function modeFromControls(identity: "user" | "valet", signed: boolean): GitCommitMode {
  if (identity === "user") return signed ? "user_turnkey_signed" : "user_unsigned";
  return signed ? "valet_app_signed" : "valet_unsigned";
}
export function controlsFromMode(mode: GitCommitMode): { identity: "user" | "valet"; signed: boolean } {
  return { identity: mode.startsWith("user_") ? "user" : "valet", signed: mode.endsWith("signed") && !mode.endsWith("unsigned") };
}

function parseStored(value: unknown): GitSettingsOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return {
    ...(isGitCommitMode(row.mode) ? { mode: row.mode } : {}),
    ...(typeof row.coAuthoredBy === "boolean" ? { coAuthoredBy: row.coAuthoredBy } : {}),
    ...(typeof row.correlationTrailers === "boolean" ? { correlationTrailers: row.correlationTrailers } : {}),
  };
}

export function resolveGitSettings(
  scope: GitSettingsOverrides,
  org: GitSettingsOverrides,
  labels: { scope: string; org?: string } = { scope: "Scope override" },
): { values: GitAttributionValues; sources: Record<keyof GitAttributionValues, GitAttributionFieldSource> } {
  const source = (field: keyof GitAttributionValues): GitAttributionFieldSource =>
    field in scope ? { scope: "scope", label: labels.scope } : field in org ? { scope: "organization", label: labels.org ?? "Organization default" } : { scope: "product", label: "Product default" };
  return {
    values: {
      mode: scope.mode ?? org.mode ?? DEFAULT_GIT_ATTRIBUTION.mode,
      coAuthoredBy: scope.coAuthoredBy ?? org.coAuthoredBy ?? DEFAULT_GIT_ATTRIBUTION.coAuthoredBy,
      correlationTrailers: scope.correlationTrailers ?? org.correlationTrailers ?? DEFAULT_GIT_ATTRIBUTION.correlationTrailers,
    },
    sources: { mode: source("mode"), coAuthoredBy: source("coAuthoredBy"), correlationTrailers: source("correlationTrailers") },
  };
}

export async function signerCapabilities(db: AppDb, orgId: string): Promise<GitSignerCapabilities> {
  const installed = await db.select({ id: githubInstallations.id }).from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.suspended, false))).limit(1);
  return {
    userTurnkeySigned: { available: false, reason: "Turnkey user signing is not available yet." },
    valetAppSigned: installed.length > 0
      ? { available: true }
      : { available: false, reason: "Install the GitHub App for this organization." },
  };
}

export async function readSettingsForScope(db: AppDb, args: { scope: "user" | "team" | "organization"; id: string; orgId: string }) {
  const orgRows = await db.select({ settings: orgs.gitAttributionSettings }).from(orgs).where(eq(orgs.id, args.orgId)).limit(1);
  const orgSettings = parseStored(orgRows[0]?.settings);
  let override: GitSettingsOverrides = {};
  let label = "Organization override";
  if (args.scope === "user") {
    const rows = await db.select({ settings: users.gitAttributionSettings }).from(users).where(eq(users.id, args.id)).limit(1);
    override = parseStored(rows[0]?.settings); label = "Personal override";
  } else if (args.scope === "team") {
    const rows = await db.select({ settings: teams.gitAttributionSettings }).from(teams).where(and(eq(teams.id, args.id), eq(teams.orgId, args.orgId))).limit(1);
    override = parseStored(rows[0]?.settings); label = "Team override";
  } else {
    override = orgSettings;
    return { overrides: override, ...resolveGitSettings(override, {}, { scope: label }), capabilities: await signerCapabilities(db, args.orgId) };
  }
  return { overrides: override, ...resolveGitSettings(override, orgSettings, { scope: label }), capabilities: await signerCapabilities(db, args.orgId) };
}

export function patchOverrides(current: GitSettingsOverrides, patch: Record<string, unknown>): GitSettingsOverrides {
  const allowed = new Set(["mode", "coAuthoredBy", "correlationTrailers"]);
  const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`Unknown Git setting: ${unknown.join(", ")}.`);
  const next = { ...current };
  for (const field of allowed) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null) { delete next[field as keyof GitSettingsOverrides]; continue; }
    if (field === "mode") {
      if (!isGitCommitMode(value)) throw new Error("Select a valid commit identity and signer combination.");
      next.mode = value;
    } else {
      if (typeof value !== "boolean") throw new Error(`${field} must be true, false, or null.`);
      next[field as "coAuthoredBy" | "correlationTrailers"] = value;
    }
  }
  return next;
}

export async function writeSettingsForScope(db: AppDb, args: { scope: "user" | "team" | "organization"; id: string; orgId: string; patch: Record<string, unknown> }) {
  const current = await readSettingsForScope(db, args);
  const next = patchOverrides(current.overrides, args.patch);
  if (next.mode === "user_turnkey_signed") throw new Error("Turnkey user signing is not available yet.");
  if (next.mode === "valet_app_signed" && !(await signerCapabilities(db, args.orgId)).valetAppSigned.available) {
    throw new Error("Install the GitHub App for this organization before enabling App signing.");
  }
  const stored = Object.keys(next).length ? next : null;
  if (args.scope === "user") await db.update(users).set({ gitAttributionSettings: stored }).where(eq(users.id, args.id));
  else if (args.scope === "team") await db.update(teams).set({ gitAttributionSettings: stored }).where(and(eq(teams.id, args.id), eq(teams.orgId, args.orgId)));
  else await db.update(orgs).set({ gitAttributionSettings: stored }).where(eq(orgs.id, args.orgId));
  return readSettingsForScope(db, args);
}

function fingerprint(value: object): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function readActiveGitSnapshot(db: AppDb, sessionId: string) {
  const head = (await db.select().from(sessionGitAttributionHeads).where(eq(sessionGitAttributionHeads.sessionId, sessionId)).limit(1))[0];
  if (!head) return undefined;
  return (await db.select().from(sessionGitAttributionSnapshots).where(and(
    eq(sessionGitAttributionSnapshots.sessionId, sessionId),
    eq(sessionGitAttributionSnapshots.generation, head.activeGeneration),
  )).limit(1))[0];
}

/** Build the stable generation-one response for a session without inserting state. */
export async function previewGitSnapshot(db: AppDb, session: typeof agentSessions.$inferSelect) {
  const active = await readActiveGitSnapshot(db, session.id);
  if (active) return active;
  const parent = (await db.select({ sessionId: childWatches.parentSessionId }).from(childWatches)
    .where(eq(childWatches.childSessionId, session.id)).limit(1))[0];
  const workflowRun = session.id.startsWith("wf:") ? session.id.split(":").slice(0, 2).join(":") : undefined;
  const workflowHead = workflowRun
    ? (await db.select().from(sessionGitAttributionHeads).where(sql`${sessionGitAttributionHeads.sessionId} like ${`${workflowRun}:%`} and ${sessionGitAttributionHeads.sessionId} <> ${session.id}`).limit(1))[0]
    : undefined;
  const inherited = parent ? await readActiveGitSnapshot(db, parent.sessionId) : workflowHead ? await readActiveGitSnapshot(db, workflowHead.sessionId) : undefined;
  const scope = session.ownerType === "team" ? "team" : session.ownerType === "org" ? "organization" : "user";
  const values = inherited
    ? { mode: inherited.mode, coAuthoredBy: inherited.coAuthoredBy, correlationTrailers: inherited.correlationTrailers }
    : session.gitAttributionSnapshotPending
      ? (await readSettingsForScope(db, { scope, id: session.ownerId || session.userId, orgId: session.orgId })).values
      : DEFAULT_GIT_ATTRIBUTION;
  const person = (await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, session.userId)).limit(1))[0];
  return {
    sessionId: session.id,
    generation: 1,
    ...values,
    ownerType: session.ownerType,
    ownerId: session.ownerId || session.userId,
    counterpartUserId: person?.id ?? null,
    counterpartName: person?.name ?? null,
    counterpartEmail: person?.email ?? null,
    valetName: process.env.VALET_GIT_NAME?.trim() || DEFAULT_VALET_IDENTITY.name,
    valetEmail: process.env.VALET_GIT_EMAIL?.trim() || DEFAULT_VALET_IDENTITY.email,
    settingsFingerprint: fingerprint(values),
    createdBy: session.userId,
    createdAt: session.createdAt,
  };
}

/** Insert-only, generationed snapshot creation. The advisory lock serializes first touch and Apply. */
export async function ensureGitSnapshot(
  db: AppDb, sessionId: string, createdBy: string, forceNew = false,
  fallback?: { userId: string; orgId: string; ownerType?: string; ownerId?: string },
) {
  return db.transaction(async (tx) => {
    const workflowRun = sessionId.startsWith("wf:") ? sessionId.split(":").slice(0, 2).join(":") : undefined;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git-attribution:${workflowRun ?? sessionId}`}))`);
    const sessions = await tx.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
    const session = sessions[0] ?? (fallback ? { ...fallback, id: sessionId, ownerType: fallback.ownerType ?? "user", ownerId: fallback.ownerId ?? fallback.userId, gitAttributionSnapshotPending: true } : undefined);
    if (!session) throw new Error("Session not found.");
    const heads = await tx.select().from(sessionGitAttributionHeads).where(eq(sessionGitAttributionHeads.sessionId, sessionId)).limit(1);
    if (heads[0] && !forceNew) {
      const rows = await tx.select().from(sessionGitAttributionSnapshots).where(and(eq(sessionGitAttributionSnapshots.sessionId, sessionId), eq(sessionGitAttributionSnapshots.generation, heads[0].activeGeneration))).limit(1);
      if (rows[0]) return rows[0];
    }
    const generation = (heads[0]?.activeGeneration ?? 0) + 1;
    const parentRows = await tx.select({ parentSessionId: childWatches.parentSessionId }).from(childWatches).where(eq(childWatches.childSessionId, sessionId)).limit(1);
    const parentHead = parentRows[0] ? (await tx.select().from(sessionGitAttributionHeads).where(eq(sessionGitAttributionHeads.sessionId, parentRows[0].parentSessionId)).limit(1))[0] : undefined;
    const workflowHead = workflowRun && generation === 1
      ? (await tx.select().from(sessionGitAttributionHeads).where(sql`${sessionGitAttributionHeads.sessionId} like ${`${workflowRun}:%`} and ${sessionGitAttributionHeads.sessionId} <> ${sessionId}`).limit(1))[0]
      : undefined;
    const inheritedHead = parentHead ?? workflowHead;
    const inheritedSessionId = parentHead ? parentRows[0]!.parentSessionId : workflowHead?.sessionId;
    const parentSnapshot = inheritedHead && inheritedSessionId && generation === 1 ? (await tx.select().from(sessionGitAttributionSnapshots).where(and(eq(sessionGitAttributionSnapshots.sessionId, inheritedSessionId), eq(sessionGitAttributionSnapshots.generation, inheritedHead.activeGeneration))).limit(1))[0] : undefined;
    const scope = session.ownerType === "team" ? "team" : session.ownerType === "org" ? "organization" : "user";
    const settings = parentSnapshot
      ? { values: { mode: parentSnapshot.mode, coAuthoredBy: parentSnapshot.coAuthoredBy, correlationTrailers: parentSnapshot.correlationTrailers } }
      : session.gitAttributionSnapshotPending
        ? await readSettingsForScope(tx, { scope, id: session.ownerId || session.userId, orgId: session.orgId })
        : { values: DEFAULT_GIT_ATTRIBUTION };
    const people = await tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, createdBy)).limit(1);
    const person = people[0];
    const valetName = process.env.VALET_GIT_NAME?.trim() || DEFAULT_VALET_IDENTITY.name;
    const valetEmail = process.env.VALET_GIT_EMAIL?.trim() || DEFAULT_VALET_IDENTITY.email;
    const row = { sessionId, generation, ...settings.values, ownerType: session.ownerType, ownerId: session.ownerId || session.userId,
      counterpartUserId: person?.id ?? null, counterpartName: person?.name ?? null, counterpartEmail: person?.email ?? null,
      valetName, valetEmail, settingsFingerprint: fingerprint(settings.values), createdBy, createdAt: Date.now() };
    await tx.insert(sessionGitAttributionSnapshots).values(row);
    await tx.insert(sessionGitAttributionHeads).values({ sessionId, activeGeneration: generation, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: sessionGitAttributionHeads.sessionId, set: { activeGeneration: generation, updatedAt: Date.now() } });
    return row;
  });
}

export function opaqueCorrelationIds(key: string, sessionId: string, queueItemId: string) {
  // v1 is stable while operators retain VALET_CORRELATION_KEY_V1 during key rotation.
  const digest = (kind: "session" | "queue", input: string) => createHmac("sha256", key).update(`${kind}\0${input}`).digest("base64url").slice(0, 32);
  return { session: `v1s_${digest("session", sessionId)}`, queueItem: `v1q_${digest("queue", `${sessionId}\0${queueItemId}`)}` };
}

export type GitHubReplayCommit = { localSha: string; message: string; treeSha: string; parents: string[] };
export type GitHubCreatedCommit = { sha: string; message: string; tree: { sha: string }; parents: Array<{ sha: string }>; author: { name: string }; committer: { name: string }; verification: { verified: boolean; reason?: string } };
export interface GitHubReplayClient { uploadLfs?(objects: import("../wire/types.js").GitPushReplayLfsObject[]): Promise<void>; createBlob?(contentBase64: string): Promise<string>; createTree?(entries: import("../wire/types.js").GitPushReplayTreeEntry[]): Promise<string>; createCommit(input: { message: string; tree: string; parents: string[] }): Promise<GitHubCreatedCommit>; getCommit(sha: string): Promise<GitHubCreatedCommit>; getRef(ref: string): Promise<string | null>; createRef(ref: string, sha: string): Promise<void>; updateRef(ref: string, sha: string, force: false): Promise<void>; refresh(): Promise<void>; }

/** Host-only REST replay. Durable rows make retries reconcile every crash window. */
export async function replaySignedCommits(db: AppDb, client: GitHubReplayClient, args: { sessionId: string; generation: number; repoFullName: string; targetRef: string; expectedRemoteSha: string; createRef?: boolean; blobs?: import("../wire/types.js").GitPushReplayBlob[]; trees?: import("../wire/types.js").GitPushReplayTree[]; lfsObjects?: import("../wire/types.js").GitPushReplayLfsObject[]; commits: GitHubReplayCommit[] }) {
  if (!args.targetRef.startsWith("refs/heads/")) throw new Error("App signing only supports branch refs in V1.");
  const localHead = args.commits.at(-1)?.localSha; if (!localHead) throw new Error("No commits need replay.");
  const identity = `${args.sessionId}\0${args.generation}\0${args.repoFullName}\0${args.targetRef}\0${localHead}`;
  const id = `gpo_${createHash("sha256").update(identity).digest("base64url").slice(0, 32)}`;
  const now = Date.now();
  const inserted = await db.insert(gitPushOperations).values({ id, sessionId: args.sessionId, generation: args.generation, repoFullName: args.repoFullName, targetRef: args.targetRef, expectedRemoteSha: args.expectedRemoteSha, localHeadSha: localHead, state: "replaying", createdAt: now, updatedAt: now }).onConflictDoNothing().returning({ id: gitPushOperations.id });
  const operation = (await db.select().from(gitPushOperations).where(eq(gitPushOperations.id, id)).limit(1))[0];
  if (!operation) throw new Error("The signed push operation could not be persisted.");
  if (operation.expectedRemoteSha !== args.expectedRemoteSha && operation.signedHeadSha !== args.expectedRemoteSha) throw new Error("This signed push was already recorded against a different remote head.");
  if (operation.state === "complete" && operation.signedHeadSha) return { operationId: id, signedHeadSha: operation.signedHeadSha };
  if (!inserted.length && ["replaying", "publishing"].includes(operation.state) && now - operation.updatedAt < 5 * 60_000) throw new Error("This branch already has a signed push in progress.");
  await db.update(gitPushOperations).set({ state: "replaying", errorCode: null, updatedAt: now }).where(eq(gitPushOperations.id, id));

  try {
    await client.refresh();
    const existing = await db.select().from(gitPushCommitMap).where(eq(gitPushCommitMap.operationId, id));
    const mapped = new Map(existing.map((row) => [row.localSha, row.signedSha]));
    const initialRemote = await client.getRef(args.targetRef);
    if (operation.signedHeadSha && initialRemote === operation.signedHeadSha) {
      await db.update(gitPushOperations).set({ state: "reconciling", errorCode: null, updatedAt: Date.now() }).where(eq(gitPushOperations.id, id));
      return { operationId: id, signedHeadSha: operation.signedHeadSha };
    }
    if (args.createRef ? initialRemote !== null : initialRemote !== args.expectedRemoteSha && initialRemote !== mapped.get(localHead)) throw new Error("The remote branch changed before replay. Fetch it and retry without force.");
    if (args.lfsObjects?.length) {
      if (!client.uploadLfs) throw new Error("The replay client cannot publish Git LFS objects.");
      await client.uploadLfs(args.lfsObjects);
    }
    if (args.blobs?.length || args.trees?.length) {
      if (!client.createBlob || !client.createTree) throw new Error("The replay client cannot publish Git objects.");
      for (const blob of args.blobs ?? []) {
        if (await client.createBlob(blob.contentBase64) !== blob.sha) throw new Error("GitHub did not preserve a replayed blob object.");
      }
      const pending = new Map((args.trees ?? []).map((tree) => [tree.sha, tree]));
      while (pending.size) {
        let progressed = false;
        for (const [sha, tree] of pending) {
          if (tree.entries.some((entry) => entry.type === "tree" && pending.has(entry.sha))) continue;
          if (await client.createTree(tree.entries) !== sha) throw new Error("GitHub did not preserve a replayed tree object.");
          pending.delete(sha); progressed = true;
        }
        if (!progressed) throw new Error("The replay payload contains a cyclic or incomplete tree graph.");
      }
    }
    for (const commit of args.commits) {
      if (mapped.has(commit.localSha)) continue;
      const parents = commit.parents.map((parent) => mapped.get(parent) ?? parent);
      const created = await client.createCommit({ message: commit.message, tree: commit.treeSha, parents });
      const verified = await client.getCommit(created.sha);
      if (verified.message !== commit.message || verified.tree.sha !== commit.treeSha || verified.parents.map((p) => p.sha).join() !== parents.join()) throw new Error("GitHub returned a commit that does not preserve the local Git object.");
      if (!verified.verification.verified || !verified.author.name.endsWith("[bot]") || verified.committer.name !== "GitHub") throw new Error("GitHub did not create a verified App commit. The branch was not updated.");
      await db.insert(gitPushCommitMap).values({ operationId: id, localSha: commit.localSha, signedSha: verified.sha, treeSha: commit.treeSha, verificationJson: verified.verification, createdAt: Date.now() }).onConflictDoNothing();
      mapped.set(commit.localSha, verified.sha);
    }
    const signedHead = mapped.get(localHead); if (!signedHead) throw new Error("The signed head mapping is incomplete.");
    await db.update(gitPushOperations).set({ signedHeadSha: signedHead, state: "publishing", updatedAt: Date.now() }).where(eq(gitPushOperations.id, id));
    await client.refresh();
    const remote = await client.getRef(args.targetRef);
    if (remote !== signedHead) {
      if (args.createRef) {
        if (remote !== null) throw new Error("The remote branch was created during replay. Fetch it and retry without force.");
        await client.createRef(args.targetRef, signedHead);
      } else {
        if (remote !== args.expectedRemoteSha) throw new Error("The remote branch changed during replay. Fetch it and retry without force.");
        await client.updateRef(args.targetRef, signedHead, false);
      }
    }
    if (await client.getRef(args.targetRef) !== signedHead) throw new Error("GitHub did not publish the verified head. Reconcile the operation before retrying.");
    await db.transaction(async (tx) => {
      await tx.update(gitPushOperations).set({ signedHeadSha: signedHead, state: "reconciling", errorCode: null, updatedAt: Date.now() }).where(eq(gitPushOperations.id, id));
      await tx.insert(sessionGitBranches).values({ sessionId: args.sessionId, generation: args.generation, repoFullName: args.repoFullName, ref: args.targetRef, headSha: signedHead, pushOperationId: id, observedAt: Date.now() }).onConflictDoUpdate({ target: [sessionGitBranches.sessionId, sessionGitBranches.repoFullName, sessionGitBranches.ref], set: { generation: args.generation, headSha: signedHead, pushOperationId: id, observedAt: Date.now() } });
    });
    return { operationId: id, signedHeadSha: signedHead };
  } catch (error) {
    await db.update(gitPushOperations).set({ state: "failed", errorCode: error instanceof Error ? error.message.slice(0, 200) : "unknown", updatedAt: Date.now() }).where(eq(gitPushOperations.id, id));
    throw error;
  }
}

/** Mark a published operation complete after the sandbox reconciles its local refs. */
export async function completeSignedPushReconciliation(db: AppDb, args: { operationId: string; sessionId: string }): Promise<{ signedHeadSha: string }> {
  const operation = (await db.select().from(gitPushOperations).where(and(eq(gitPushOperations.id, args.operationId), eq(gitPushOperations.sessionId, args.sessionId))).limit(1))[0];
  if (!operation?.signedHeadSha || operation.state !== "reconciling") throw new Error("The signed push operation is not ready for reconciliation.");
  await db.update(gitPushOperations).set({ state: "complete", errorCode: null, updatedAt: Date.now() }).where(eq(gitPushOperations.id, operation.id));
  return { signedHeadSha: operation.signedHeadSha };
}
