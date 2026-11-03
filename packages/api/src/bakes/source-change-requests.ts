/**
 * Second-admin approval for image-source changes.
 *
 * An image source decides what code runs in every sandbox built from it
 * (setup commands, the image it starts FROM, the base a repository image
 * inherits). A single org admin account must not be able to change that
 * alone: on 2026-11-02 one admin account created image sources and edited
 * the built-in base's setup commands to plant code in every later bake.
 *
 * A create, or a patch that touches a content field, becomes a pending
 * change request. A different org admin approves it, and only then does the
 * change reach `image_sources`. Because a source's content cannot change
 * without approval, a manual bake always builds approved content.
 *
 * `VALET_IMAGE_SOURCE_APPROVAL=off` turns the gate off. That is the explicit
 * override for an instance with one admin; the api logs a warning at boot.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { imageSourceChangeRequests, imageSources, orgMembers, users, type ImageSourceRow } from "../schema/index.js";
import { markAttentionNotificationsRead, routeAttention } from "../orchestrator/attention.js";

export type ImageSourceApprovalMode = "required" | "off";
export type SourceChangeRequestRow = typeof imageSourceChangeRequests.$inferSelect;

const APPROVAL_ENV = "VALET_IMAGE_SOURCE_APPROVAL";
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LIST_LIMIT = 100;

/** Fields that change what an image runs or builds FROM. A patch of only
 * `enabled`, `schedule`, or `sandboxResources` applies at once. */
export const SOURCE_CONTENT_FIELDS = ["name", "setupCommands", "externalRef", "parentId", "pullSecretName"] as const;

export const SINGLE_ADMIN_REFUSAL =
  "Image-source changes need approval from a second org admin, and this organization has one admin. " +
  `Add a second org admin in Settings, or ask the instance operator to set ${APPROVAL_ENV}=off.`;

export class SourceChangeRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "SourceChangeRefusal";
  }
}

/** Reads the gate mode. Anything other than `off` keeps the gate on, so a
 * typo cannot turn approval off. */
export function imageSourceApprovalMode(env: NodeJS.ProcessEnv = process.env): ImageSourceApprovalMode {
  return env[APPROVAL_ENV]?.trim().toLowerCase() === "off" ? "off" : "required";
}

export function patchTouchesContent(patch: Record<string, unknown>): boolean {
  return SOURCE_CONTENT_FIELDS.some((field) => patch[field] !== undefined);
}

async function orgAdminIds(db: AppDb, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: orgMembers.userId })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "admin")));
  return rows.map((row) => row.userId);
}

async function displayName(db: AppDb, userId: string): Promise<string> {
  const [row] = await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? row?.name ?? userId;
}

export interface RequestSourceChangeInput {
  orgId: string;
  requestedBy: string;
  action: "create" | "update";
  /** The source to patch; absent for a create. */
  source?: Pick<ImageSourceRow, "id" | "name" | "updatedAt">;
  /** The name of the source to create, or of the source to patch. */
  sourceName: string;
  /** The validated row to insert, or the validated field patch. */
  payload: Record<string, unknown>;
}

/** Stores a pending change and notifies every other org admin. Refuses when
 * no second admin exists, and when the target already has a pending change. */
export async function requestSourceChange(db: AppDb, input: RequestSourceChangeInput): Promise<SourceChangeRequestRow> {
  const admins = await orgAdminIds(db, input.orgId);
  const approvers = admins.filter((id) => id !== input.requestedBy);
  if (approvers.length === 0) throw new SourceChangeRefusal(SINGLE_ADMIN_REFUSAL, 409);

  const now = Date.now();
  const row: SourceChangeRequestRow = {
    id: `isc_${randomUUID()}`,
    orgId: input.orgId,
    targetKey: input.source ? input.source.id : `new:${input.sourceName}`,
    sourceId: input.source?.id ?? null,
    sourceName: input.sourceName,
    action: input.action,
    payload: input.payload,
    baseUpdatedAt: input.source?.updatedAt ?? null,
    requestedBy: input.requestedBy,
    requestedAt: now,
    expiresAt: now + REQUEST_TTL_MS,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
  };
  try {
    await db.insert(imageSourceChangeRequests).values(row);
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new SourceChangeRefusal(
        `A change to image source ${input.sourceName} already waits for approval. Approve, reject, or withdraw it first.`,
        409,
      );
    }
    throw err;
  }
  const requester = await displayName(db, input.requestedBy);
  const verb = input.action === "create" ? "create" : "change";
  console.warn(`[security] image source change requested: ${row.id} ${verb} ${input.sourceName} by ${input.requestedBy}`);
  for (const approver of approvers) {
    await routeAttention(
      { db },
      {
        kind: "approval",
        urgency: "high",
        owner: { type: "user", id: approver },
        actorUserId: input.requestedBy,
        dedupeKey: row.id,
        title: `Approve image source change: ${input.sourceName}`,
        body: `${requester} wants to ${verb} image source ${input.sourceName}. It changes what sandboxes run. Review it before you approve.`,
        href: "/settings/organization/sandbox-images",
      },
    ).catch((err) => console.error(`image source change ${row.id}: approval notification failed:`, err));
  }
  return row;
}

/** Pending requests for the org, newest first, plus decided ones when asked. */
export async function listSourceChanges(db: AppDb, orgId: string, status: SourceChangeRequestRow["status"] = "pending"): Promise<SourceChangeRequestRow[]> {
  return db
    .select()
    .from(imageSourceChangeRequests)
    .where(and(eq(imageSourceChangeRequests.orgId, orgId), eq(imageSourceChangeRequests.status, status)))
    .orderBy(desc(imageSourceChangeRequests.requestedAt))
    .limit(LIST_LIMIT);
}

async function lockPending(tx: AppDb, orgId: string, id: string): Promise<SourceChangeRequestRow> {
  const [row] = await tx
    .select()
    .from(imageSourceChangeRequests)
    .where(and(eq(imageSourceChangeRequests.id, id), eq(imageSourceChangeRequests.orgId, orgId)))
    .limit(1)
    .for("update");
  if (!row) throw new SourceChangeRefusal("change request not found", 404);
  if (row.status !== "pending") {
    throw new SourceChangeRefusal(`This change request is already ${row.status}. Refresh the list.`, 409);
  }
  return row;
}

async function decide(
  tx: AppDb,
  row: SourceChangeRequestRow,
  status: "approved" | "rejected" | "withdrawn",
  userId: string,
  note: string | null,
): Promise<SourceChangeRequestRow> {
  const decided = { status, decidedBy: userId, decidedAt: Date.now(), decisionNote: note };
  await tx.update(imageSourceChangeRequests).set(decided).where(eq(imageSourceChangeRequests.id, row.id));
  await markAttentionNotificationsRead(tx, "approval", row.id);
  return { ...row, ...decided };
}

/**
 * Applies a pending change as a different org admin. Refuses the requester,
 * an expired request, and a request whose source changed or was deleted
 * after the request was made. Returns the applied source row.
 */
export async function approveSourceChange(
  db: AppDb,
  input: { orgId: string; approverId: string; id: string },
): Promise<{ request: SourceChangeRequestRow; source: ImageSourceRow }> {
  return db.transaction(async (tx) => {
    const row = await lockPending(tx, input.orgId, input.id);
    if (row.requestedBy === input.approverId) {
      throw new SourceChangeRefusal("You requested this change. A different org admin must approve it.", 403);
    }
    if (row.expiresAt < Date.now()) {
      await decide(tx, row, "rejected", input.approverId, "expired");
      throw new SourceChangeRefusal("This change request expired. Ask the requester to submit the change again.", 409);
    }
    const now = Date.now();
    let source: ImageSourceRow | undefined;
    if (row.action === "create") {
      // The route stored a full, validated `image_sources` row as the
      // payload; jsonb returns it as a plain record.
      const values = { ...(row.payload as ImageSourceRow), orgId: row.orgId, createdAt: now, updatedAt: now };
      try {
        await tx.insert(imageSources).values(values);
      } catch (err) {
        if (isPgUniqueViolation(err)) {
          throw new SourceChangeRefusal("A source like this one now exists. Reject this request and edit the existing source.", 409);
        }
        throw err;
      }
      [source] = await tx.select().from(imageSources).where(eq(imageSources.id, values.id)).limit(1);
    } else {
      const sourceId = row.sourceId ?? "";
      const [current] = await tx
        .select()
        .from(imageSources)
        .where(and(eq(imageSources.id, sourceId), eq(imageSources.orgId, row.orgId)))
        .limit(1)
        .for("update");
      if (!current) throw new SourceChangeRefusal("The image source was deleted. Reject this request.", 409);
      if (current.updatedAt !== row.baseUpdatedAt) {
        throw new SourceChangeRefusal(
          "The image source changed after this request was made. Reject this request and submit the change again.",
          409,
        );
      }
      await tx
        .update(imageSources)
        // The route stored a validated field patch as the payload.
        .set({ ...(row.payload as Partial<ImageSourceRow>), updatedAt: now })
        .where(eq(imageSources.id, sourceId));
      [source] = await tx.select().from(imageSources).where(eq(imageSources.id, sourceId)).limit(1);
    }
    if (!source) throw new Error(`image source change ${row.id}: applied source row is missing`);
    const request = await decide(tx, row, "approved", input.approverId, null);
    console.warn(`[security] image source change approved: ${row.id} ${row.action} ${row.sourceName} requested by ${row.requestedBy}, approved by ${input.approverId}`);
    return { request, source };
  });
}

export async function rejectSourceChange(
  db: AppDb,
  input: { orgId: string; userId: string; id: string; note?: string },
): Promise<SourceChangeRequestRow> {
  return db.transaction(async (tx) => {
    const row = await lockPending(tx, input.orgId, input.id);
    if (row.requestedBy === input.userId) {
      throw new SourceChangeRefusal("You requested this change. Withdraw it instead of rejecting it.", 403);
    }
    return decide(tx, row, "rejected", input.userId, input.note?.trim() || null);
  });
}

export async function withdrawSourceChange(
  db: AppDb,
  input: { orgId: string; userId: string; id: string },
): Promise<SourceChangeRequestRow> {
  return db.transaction(async (tx) => {
    const row = await lockPending(tx, input.orgId, input.id);
    if (row.requestedBy !== input.userId) {
      throw new SourceChangeRefusal("Only the admin who requested this change can withdraw it. Reject it instead.", 403);
    }
    return decide(tx, row, "withdrawn", input.userId, null);
  });
}
