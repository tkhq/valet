import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import type { RunSignal, ToolCredentialMode } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { canonicalJson } from "../lib/canonical-json.js";
import { credentials, githubInstallations, workflowSignals, workflowToolApprovals } from "../schema/index.js";
import { isUsableGithubUserRow } from "../services/github-tokens.js";

const APPROVAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface WorkflowApprovalIdentity {
  orgId: string;
  owner: Principal;
  workflowId: string;
  definitionVersionId: string;
  nodeId: string;
  service: string;
  actionId: string;
  pluginVersion: string;
  credential?: ToolCredentialMode;
  /** One-way encrypted credential snapshot hash or installation selector. */
  credentialIdentity: string;
  params: Record<string, unknown>;
  policyRevision: string;
}

export interface WorkflowCredentialIdentityInput {
  db: AppDb;
  orgId: string;
  owner: Principal;
  service: string;
  credential?: ToolCredentialMode;
  params: Record<string, unknown>;
  orgProvided: boolean;
  credentialRequired: boolean;
  now: number;
}

function isExternalCredentialReference(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return "onepassword" in metadata || "delegatedFrom" in metadata || "reference" in metadata;
}

async function credentialRowIdentity(
  db: AppDb,
  ownerType: string,
  ownerId: string,
  service: string,
): Promise<string | null | undefined> {
  const rows = await db
    .select({
      accessTokenEnc: credentials.accessTokenEnc,
      refreshTokenEnc: credentials.refreshTokenEnc,
      apiKeyEnc: credentials.apiKeyEnc,
      scopes: credentials.scopes,
      ownerType: credentials.ownerType,
      ownerId: credentials.ownerId,
      service: credentials.service,
      type: credentials.type,
      metadata: credentials.metadata,
      createdAt: credentials.createdAt,
    })
    .from(credentials)
    .where(and(eq(credentials.ownerType, ownerType), eq(credentials.ownerId, ownerId), eq(credentials.service, service)))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  // External references can change without changing this row. Null means
  // a selected row exists but cannot support a remembered approval.
  if (isExternalCredentialReference(row.metadata)) return null;
  if (!row.accessTokenEnc && !row.apiKeyEnc) return null;
  // Hash ciphertext, never plaintext. Any replacement or refresh requires
  // fresh approval, including same-timestamp writes and account switches.
  return `row:${createHash("sha256").update(canonicalJson(row)).digest("hex")}`;
}

async function githubInstallationIdentity(
  db: AppDb,
  orgId: string,
  owner: string | undefined,
  allowSoleFallback: boolean,
): Promise<string | undefined> {
  const rows = await db
    .select({ installationId: githubInstallations.installationId, accountLogin: githubInstallations.accountLogin })
    .from(githubInstallations)
    .where(and(eq(githubInstallations.orgId, orgId), eq(githubInstallations.suspended, false)));
  const selected = owner
    ? rows.find((row) => row.accountLogin.toLowerCase() === owner.toLowerCase())
    : rows.length === 1 ? rows[0] : undefined;
  if (selected) return `github-installation:${selected.installationId}`;
  const sole = rows.length === 1 ? rows[0] : undefined;
  if (allowSoleFallback && sole) return `github-installation:${sole.installationId}`;
  return undefined;
}

async function usableGithubRowIdentity(
  db: AppDb,
  ownerType: string,
  ownerId: string,
  now: number,
): Promise<string | null | undefined> {
  const rows = await db
    .select({
      accessTokenEnc: credentials.accessTokenEnc,
      apiKeyEnc: credentials.apiKeyEnc,
      refreshTokenEnc: credentials.refreshTokenEnc,
      expiresAt: credentials.expiresAt,
      metadata: credentials.metadata,
    })
    .from(credentials)
    .where(and(eq(credentials.ownerType, ownerType), eq(credentials.ownerId, ownerId), eq(credentials.service, "github")))
    .limit(1);
  const row = rows[0];
  if (row && isExternalCredentialReference(row.metadata)) return null;
  if (!row || !isUsableGithubUserRow({
    accessToken: row.accessTokenEnc !== null || (ownerType === "team" && row.apiKeyEnc !== null) ? "stored" : undefined,
    refreshToken: row.refreshTokenEnc === null ? undefined : "stored",
    expiresAt: row.expiresAt ?? undefined,
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : undefined,
  }, now)) return undefined;
  return credentialRowIdentity(db, ownerType, ownerId, "github");
}

/** Returns no identity when credential selection cannot be proved stable. */
export async function resolveWorkflowCredentialIdentity(
  input: WorkflowCredentialIdentityInput,
): Promise<string | undefined> {
  if (input.service === "github") {
    const selection = input.credential ?? "auto";
    const repoOwner = typeof input.params.owner === "string" && input.params.owner.length > 0
      ? input.params.owner
      : undefined;
    if (selection === "app") {
      return githubInstallationIdentity(input.db, input.orgId, repoOwner, false);
    }
    if (input.owner.type === "user") {
      const row = await usableGithubRowIdentity(input.db, "user", input.owner.id, input.now);
      if (row !== undefined || selection === "user") return row ?? undefined;
      // Workflow invocations have no repository binding. The API auto path
      // therefore uses the org's sole installation after the user row.
      return githubInstallationIdentity(input.db, input.orgId, undefined, false);
    }
    if (input.owner.type === "team") {
      const row = await usableGithubRowIdentity(input.db, "team", input.owner.id, input.now);
      if (row !== undefined || selection === "user") return row ?? undefined;
      return githubInstallationIdentity(input.db, input.orgId, repoOwner, true);
    }
    if (selection === "user") return undefined;
    return githubInstallationIdentity(input.db, input.orgId, undefined, false);
  }

  const directOwner = input.owner.type === "user"
    ? { type: "user", id: input.owner.id }
    : input.owner.type === "team"
      ? { type: "team", id: input.owner.id }
      : { type: "org", id: input.orgId };
  const direct = await credentialRowIdentity(input.db, directOwner.type, directOwner.id, input.service);
  if (direct !== undefined) return direct ?? undefined;
  if (!input.credentialRequired) return "not-required";
  if (input.orgProvided && input.owner.type !== "org") {
    return (await credentialRowIdentity(input.db, "org", input.orgId, input.service)) ?? undefined;
  }
  return undefined;
}

/** Binds approval to one exact workflow action and security context. */
export function workflowApprovalFingerprint(input: WorkflowApprovalIdentity): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export async function findWorkflowToolApproval(
  db: AppDb,
  fingerprint: string,
  now: number,
): Promise<typeof workflowToolApprovals.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(workflowToolApprovals)
    .where(and(
      eq(workflowToolApprovals.fingerprint, fingerprint),
      isNull(workflowToolApprovals.revokedAt),
      gt(workflowToolApprovals.expiresAt, now),
    ))
    .limit(1);
  return rows[0];
}

export async function writeWorkflowToolApproval(
  db: AppDb,
  input: Omit<WorkflowApprovalIdentity, "credentialIdentity" | "pluginVersion"> & {
    fingerprint: string;
    approvedBy: string;
    sourceRunId: string;
    now: number;
  },
  signal?: RunSignal,
): Promise<boolean> {
  const lockKey = canonicalJson([
    input.orgId,
    input.owner.type,
    input.owner.id,
    input.workflowId,
    input.nodeId,
  ]);
  return db.transaction(async (tx) => {
    if (signal) {
      const inserted = await tx.insert(workflowSignals).values({
        runId: signal.runId, signalId: signal.signalId, signalType: signal.signalType,
        payload: signal.payload, createdAt: signal.createdAt,
      }).onConflictDoNothing().returning({ id: workflowSignals.id });
      if (inserted.length === 0) return false;
    }
    // Serialize supersession for this principal/workflow/node. The advisory
    // transaction lock works before any approval row exists.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    await tx.update(workflowToolApprovals).set({ revokedAt: input.now, updatedAt: input.now }).where(and(
      eq(workflowToolApprovals.orgId, input.orgId),
      eq(workflowToolApprovals.principalType, input.owner.type),
      eq(workflowToolApprovals.principalId, input.owner.id),
      eq(workflowToolApprovals.workflowId, input.workflowId),
      eq(workflowToolApprovals.nodeId, input.nodeId),
      ne(workflowToolApprovals.fingerprint, input.fingerprint),
      isNull(workflowToolApprovals.revokedAt),
    ));
    // Invocation audit rows retain the approval ID. Approval rows are only
    // deleted after their active or revoked retention period ends.
    await tx.delete(workflowToolApprovals).where(and(
      eq(workflowToolApprovals.orgId, input.orgId),
      lt(workflowToolApprovals.expiresAt, input.now),
    ));

    await tx
      .insert(workflowToolApprovals)
      .values({
        id: randomUUID(),
        fingerprint: input.fingerprint,
        orgId: input.orgId,
        principalType: input.owner.type,
        principalId: input.owner.id,
        workflowId: input.workflowId,
        definitionVersionId: input.definitionVersionId,
        nodeId: input.nodeId,
        service: input.service,
        actionId: input.actionId,
        credential: input.credential ?? null,
        paramsHash: createHash("sha256").update(canonicalJson(input.params)).digest("hex"),
        policyRevision: input.policyRevision,
        approvedBy: input.approvedBy,
        sourceRunId: input.sourceRunId,
        expiresAt: input.now + APPROVAL_TTL_MS,
        createdAt: input.now,
        updatedAt: input.now,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: workflowToolApprovals.fingerprint,
        set: {
          approvedBy: input.approvedBy,
          sourceRunId: input.sourceRunId,
          expiresAt: input.now + APPROVAL_TTL_MS,
          updatedAt: input.now,
          revokedAt: null,
        },
      });
    return true;
  });
}
