/** Per-engagement secret-broker authorization for security persona sandboxes. */
import { eq } from "drizzle-orm";
import { parseDeclaredCredentials } from "@valet/shared";
import type { AppQueryable } from "../lib/drizzle.js";
import { childWatches, securityCells, securityEngagements } from "../schema/index.js";

export type SecurityBrokerCaller =
  | { kind: "running-cell"; engagementId: string }
  | { kind: "security-session-denied" }
  | { kind: "non-security" };

/**
 * Classify a broker caller without turning a stale security child into a
 * normal session. Only a running cell in a running engagement may resolve.
 */
export async function classifySecurityBrokerCaller(
  db: AppQueryable,
  sessionId: string,
): Promise<SecurityBrokerCaller> {
  const cellRows = await db
    .select({ engagementId: securityCells.engagementId, status: securityCells.status })
    .from(securityCells)
    .where(eq(securityCells.childSessionId, sessionId))
    .limit(1);
  const cell = cellRows[0];
  if (cell) {
    const engagementRows = await db
      .select({ status: securityEngagements.status })
      .from(securityEngagements)
      .where(eq(securityEngagements.id, cell.engagementId))
      .limit(1);
    return cell.status === "running" && engagementRows[0]?.status === "running"
      ? { kind: "running-cell", engagementId: cell.engagementId }
      : { kind: "security-session-denied" };
  }

  const runnerRows = await db
    .select({ id: securityEngagements.id })
    .from(securityEngagements)
    .where(eq(securityEngagements.sessionId, sessionId))
    .limit(1);
  if (runnerRows[0]) return { kind: "security-session-denied" };

  // A replaced child is no longer named by its cell. Its parent still names
  // the security runner, so it must not fall through to ordinary broker access.
  const sessionRows = await db
    .select({ parentSessionId: childWatches.parentSessionId })
    .from(childWatches)
    .where(eq(childWatches.childSessionId, sessionId))
    .limit(1);
  const parentSessionId = sessionRows[0]?.parentSessionId;
  if (parentSessionId) {
    const parentRows = await db
      .select({ id: securityEngagements.id })
      .from(securityEngagements)
      .where(eq(securityEngagements.sessionId, parentSessionId))
      .limit(1);
    if (parentRows[0]) return { kind: "security-session-denied" };
  }
  return { kind: "non-security" };
}

/** Every primary and secondary op:// reference declared by the engagement.
 * An mTLS credential carries a second reference for its certificate, and the
 * broker must resolve that one too. */
function credentialRefsFrom(value: unknown): Set<string> {
  const refs = new Set<string>();
  for (const decl of parseDeclaredCredentials(value)) {
    refs.add(decl.reference);
    const certRef = decl.meta?.certRef;
    if (certRef !== undefined) refs.add(certRef);
  }
  return refs;
}

export async function loadEngagementCredentialRefs(
  db: AppQueryable,
  engagementId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ credentialsJson: securityEngagements.credentialsJson })
    .from(securityEngagements)
    .where(eq(securityEngagements.id, engagementId))
    .limit(1);
  return credentialRefsFrom(rows[0]?.credentialsJson ?? null);
}
