import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { PolicyDecision, Principal } from "@valet/engine";
import { adaptCredentialDelegate, buildDelegatedExecutionObligationPlan, decisionDigestOf, type PolicyDecisionEnvelope } from "@valet/engine/authorization";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, childWatches, credentialDelegations, credentials, delegationEnvelopes, githubInstallations, orgMembers, sessionRepos, teamMembers } from "../schema/index.js";
import type { RepoBinding } from "../wire/types.js";
import type { CanonicalAuthorizationService } from "./canonical-authorization-service.js";
import { canonicalDecisionId } from "./canonical-authorization-service.js";
import { completeCanonicalExecution, reserveCanonicalExecution } from "./canonical-execution-lifecycle.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const OPERATIONS = ["repository.clone", "repository.fetch", "repository.push"] as const;

type Provenance = { kind: "github_installation" | "github_owner_credential" | "none"; id: string; version: number };
type GrantResult = { id: string };

export class CredentialDelegationDeniedError extends Error {
  readonly code: "credential_delegation_denied" | "credential_delegation_approval_required";
  constructor(code: CredentialDelegationDeniedError["code"]) {
    super(code === "credential_delegation_denied" ? "Repository credential delegation was denied." : "Repository credential delegation requires approval.");
    this.name = "CredentialDelegationDeniedError";
    this.code = code;
  }
}

export class CredentialDelegationInvalidError extends Error {
  readonly code = "credential_delegation_invalid";
  constructor() {
    super("Repository credential delegation is missing or no longer valid.");
    this.name = "CredentialDelegationInvalidError";
  }
}

function opaqueId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function splitRepo(binding: Pick<RepoBinding, "host" | "fullName">): { host: string; owner: string; repo: string } {
  const [owner, repo] = binding.fullName.split("/");
  if (!owner || !repo || binding.fullName.split("/").length !== 2) throw new CredentialDelegationInvalidError();
  return { host: (binding.host ?? "github").toLowerCase(), owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

async function provenanceFor(db: AppDb, orgId: string, owner: Principal, repoOwner: string, auth: RepoBinding["auth"]): Promise<Provenance | null> {
  if (auth !== "user") {
    const installation = (await db.select({ id: githubInstallations.id, installationId: githubInstallations.installationId, version: githubInstallations.updatedAt })
      .from(githubInstallations)
      .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.suspended, false), sql`lower(${githubInstallations.accountLogin}) = ${repoOwner}`))
      .limit(1))[0];
    if (installation) return { kind: "github_installation", id: opaqueId(`installation:${installation.id}:${installation.installationId}`), version: installation.version };
    if (auth === "app") return null;
  }
  if (auth === "user" && owner.type !== "user") return null;
  const credentialOwner = auth === "user" || owner.type === "user" ? owner : { type: "org" as const, id: orgId };
  const credential = (await db.select({ version: credentials.updatedAt }).from(credentials)
    .where(and(eq(credentials.ownerType, credentialOwner.type), eq(credentials.ownerId, credentialOwner.id), eq(credentials.service, "github")))
    .limit(1))[0];
  if (credential) return { kind: "github_owner_credential", id: opaqueId(`credential:${credentialOwner.type}:${credentialOwner.id}:github`), version: credential.version };
  return auth === "auto" ? { kind: "none", id: opaqueId(`none:${orgId}:${repoOwner}`), version: 0 } : null;
}

function executionDecision(envelope: PolicyDecisionEnvelope, decisionId: string, executionInputDigest: string): PolicyDecision {
  return { mode: envelope.decision.effect, provenance: { baseMode: envelope.decision.effect, source: "canonical_service" }, canonical: {
    reasonCode: envelope.decision.reasonCode, obligations: envelope.decision.obligations, redactions: envelope.decision.redactions,
    ...(envelope.decision.approvalRequirement ? { approvalRequirement: envelope.decision.approvalRequirement } : {}),
    requestId: envelope.requestId, requestSubjectDigest: envelope.requestSubjectDigest, inputDigest: envelope.inputDigest,
    policyDigest: envelope.policyDigest, sourceBundleDigest: envelope.sourceBundleDigest, evaluatorKind: envelope.evaluator.kind,
    engineDigest: envelope.evaluator.engineDigest, decisionDigest: decisionDigestOf(envelope.decision), executionInputDigest, decisionId,
  } };
}

function parseGrant(value: unknown): GrantResult {
  if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") throw new Error("Stored credential delegation result is invalid.");
  return { id: (value as { id: string }).id };
}

export async function authorizeRepositoryCredentialDelegation(input: {
  db: AppDb; authorization: CanonicalAuthorizationService; orgId: string; actorUserId: string; owner: Principal;
  parentSessionId: string; parentThreadId: string; parentOperationId: string; childSessionId: string; binding: RepoBinding; now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const repo = splitRepo(input.binding);
  if (repo.host !== "github") throw new CredentialDelegationDeniedError("credential_delegation_denied");
  const existing = (await input.db.select().from(credentialDelegations).where(and(
    eq(credentialDelegations.childSessionId, input.childSessionId),
    eq(credentialDelegations.repoHost, repo.host),
    eq(credentialDelegations.repoOwner, repo.owner),
    eq(credentialDelegations.repoName, repo.repo),
    isNull(credentialDelegations.revokedAt),
  )).limit(1))[0];
  if (existing && (existing.parentSessionId !== input.parentSessionId
    || existing.parentThreadId !== input.parentThreadId
    || existing.parentOperationId !== input.parentOperationId)) {
    throw new CredentialDelegationInvalidError();
  }
  const provenance = await provenanceFor(input.db, input.orgId, input.owner, repo.owner, input.binding.auth);
  if (!provenance) throw new CredentialDelegationDeniedError("credential_delegation_denied");
  const operationId = opaqueId(`${input.parentSessionId}:${input.parentThreadId}:${input.parentOperationId}:${input.childSessionId}:${repo.host}:${repo.owner}/${repo.repo}`);
  const adapted = adaptCredentialDelegate({ schemaVersion: 1, organizationId: input.orgId, actorUserId: input.actorUserId, principal: input.owner,
    requestId: `credential-delegation:${operationId}`, operationId, parentSessionId: input.parentSessionId,
    evaluationTimeMs: now, service: "github", credentialClass: "repository_transport", owner: input.owner,
    delegatorSessionId: input.parentSessionId, delegateeSessionId: input.childSessionId, operations: OPERATIONS,
    resource: { type: "repository", id: `${repo.host}:${repo.owner}/${repo.repo}` }, expiresAtMs: now + DAY_MS, transitive: false });
  const authorization = await input.authorization.authorize(adapted.request);
  buildDelegatedExecutionObligationPlan(authorization.decision);
  if (authorization.decision.effect !== "allow") throw new CredentialDelegationDeniedError(authorization.decision.effect === "deny" ? "credential_delegation_denied" : "credential_delegation_approval_required");
  const decisionId = canonicalDecisionId(input.orgId, adapted.request.idempotencyKey);
  const digest = createHash("sha256").update(adapted.canonicalBytes).digest("hex");
  const decision = executionDecision(authorization, decisionId, digest);
  const reserved = await reserveCanonicalExecution(input.db, decision, digest, parseGrant, () => now);
  if (reserved.kind === "completed") return;
  if (reserved.kind !== "execute") throw new Error(reserved.error);
  const id = randomUUID();
  await input.db.insert(credentialDelegations).values({ id, orgId: input.orgId, parentSessionId: input.parentSessionId,
    parentThreadId: input.parentThreadId, parentOperationId: input.parentOperationId, childSessionId: input.childSessionId, childWatchId: input.childSessionId,
    ownerType: input.owner.type, ownerId: input.owner.id, repoHost: repo.host, repoOwner: repo.owner, repoName: repo.repo,
    credentialKind: provenance.kind, credentialId: provenance.id, credentialVersion: provenance.version, operations: [...OPERATIONS],
    issuedAt: now, expiresAt: now + DAY_MS, decisionId, decisionEvidence: { requestId: authorization.requestId,
      requestSubjectDigest: authorization.requestSubjectDigest, inputDigest: authorization.inputDigest,
      policyDigest: authorization.policyDigest, sourceBundleDigest: authorization.sourceBundleDigest,
      evaluatorKind: authorization.evaluator.kind, engineDigest: authorization.evaluator.engineDigest,
      decisionDigest: decisionDigestOf(authorization.decision), effect: authorization.decision.effect,
      reasonCode: authorization.decision.reasonCode }, createdAt: now });
  await completeCanonicalExecution(input.db, decision, digest, reserved.attemptId, { outcome: "completed", result: { id } }, (value) => value, parseGrant, () => now);
}

export async function assertRepositoryCredentialDelegation(input: {
  db: AppDb; orgId: string; actorUserId: string; childSessionId: string; owner: Principal; binding: RepoBinding; operation: "repository.clone" | "repository.fetch" | "repository.push"; now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const repo = splitRepo(input.binding);
  const [grant, envelope, watch, session, membership, teamMembership] = await Promise.all([
    input.db.select().from(credentialDelegations).where(and(eq(credentialDelegations.childSessionId, input.childSessionId), eq(credentialDelegations.repoHost, repo.host), eq(credentialDelegations.repoOwner, repo.owner), eq(credentialDelegations.repoName, repo.repo), isNull(credentialDelegations.revokedAt))).limit(1),
    input.db.select().from(delegationEnvelopes).where(eq(delegationEnvelopes.childSessionId, input.childSessionId)).limit(1),
    input.db.select().from(childWatches).where(and(eq(childWatches.childSessionId, input.childSessionId), eq(childWatches.settled, false))).limit(1),
    input.db.select({ ownerType: agentSessions.ownerType, ownerId: agentSessions.ownerId, status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, input.childSessionId)).limit(1),
    input.db.select().from(orgMembers).where(and(eq(orgMembers.orgId, input.orgId), eq(orgMembers.userId, input.actorUserId))).limit(1),
    input.owner.type === "team" ? input.db.select().from(teamMembers).where(and(eq(teamMembers.teamId, input.owner.id), eq(teamMembers.userId, input.actorUserId))).limit(1) : Promise.resolve([]),
  ]);
  const row = grant[0];
  const edge = envelope[0];
  const childWatch = watch[0];
  if (!row || !edge || !childWatch || !session[0] || !membership[0]
    || now >= row.expiresAt
    || row.orgId !== input.orgId
    || row.ownerType !== input.owner.type
    || row.ownerId !== input.owner.id
    || row.childWatchId !== childWatch.childSessionId
    || row.issuedAt === null
    || row.expiresAt - row.issuedAt !== DAY_MS
    || row.decisionEvidence === null
    || edge.orgId !== row.orgId
    || edge.parentSessionId !== row.parentSessionId
    || edge.envelope.parentThreadId !== row.parentThreadId
    || edge.envelope.childSessionId !== row.childSessionId
    || edge.envelope.actorUserId !== input.actorUserId
    || edge.envelope.owner.type !== row.ownerType
    || edge.envelope.owner.id !== row.ownerId
    || childWatch.parentSessionId !== row.parentSessionId
    || childWatch.parentThreadId !== row.parentThreadId
    || childWatch.actorUserId !== input.actorUserId
    || childWatch.orgId !== row.orgId
    || session[0].ownerType !== input.owner.type
    || session[0].ownerId !== input.owner.id
    || session[0].status === "deleted"
    || !row.operations.includes(input.operation)
    || (input.owner.type === "team" && !teamMembership[0])) {
    throw new CredentialDelegationInvalidError();
  }
  const [parent, bound] = await Promise.all([
    input.db.select({ status: agentSessions.status }).from(agentSessions).where(eq(agentSessions.id, row.parentSessionId)).limit(1),
    input.db.select({ sessionId: sessionRepos.sessionId }).from(sessionRepos).where(and(eq(sessionRepos.sessionId, input.childSessionId), eq(sessionRepos.host, repo.host), sql`lower(${sessionRepos.fullName}) = ${`${repo.owner}/${repo.repo}`}`)).limit(1),
  ]);
  if (!parent[0] || parent[0].status === "deleted" || !bound[0]) throw new CredentialDelegationInvalidError();
  const provenance = await provenanceFor(input.db, input.orgId, input.owner, repo.owner, input.binding.auth);
  if (!provenance || provenance.kind !== row.credentialKind || provenance.id !== row.credentialId || provenance.version !== row.credentialVersion) throw new CredentialDelegationInvalidError();
}

export async function revokeChildCredentialDelegations(db: AppDb, childSessionId: string, now = Date.now()): Promise<void> {
  await db.update(credentialDelegations).set({ revokedAt: now }).where(and(eq(credentialDelegations.childSessionId, childSessionId), isNull(credentialDelegations.revokedAt)));
}

export async function revokeSessionCredentialDelegations(db: AppDb, sessionId: string, now = Date.now()): Promise<void> {
  await db.update(credentialDelegations).set({ revokedAt: now }).where(and(or(eq(credentialDelegations.parentSessionId, sessionId), eq(credentialDelegations.childSessionId, sessionId)), isNull(credentialDelegations.revokedAt)));
}
