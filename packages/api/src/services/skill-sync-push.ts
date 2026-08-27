/**
 * Match a GitHub App `push` delivery to org-owned skill sources.
 *
 * Personal and team sources do not use this path. They often have no App
 * installation, so they stay on the poll. An org source already reads with
 * the installation token; a `push` on the tracked ref is the same signal
 * the sweep's head-commit compare looks for.
 */
import { and, eq } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { skillSources, type SkillSourceRow } from "../schema/index.js";

export interface SkillPushRef {
  repoFullName: string;
  gitRef: string;
  defaultBranch: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The repository and ref a `push` names, or null when the payload is not a push. */
export function parseSkillPushPayload(payload: unknown): SkillPushRef | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.ref !== "string" || payload.ref.length === 0) return null;
  const repository = payload.repository;
  if (!isRecord(repository) || typeof repository.full_name !== "string") return null;
  const defaultBranch =
    typeof repository.default_branch === "string" && repository.default_branch.length > 0
      ? repository.default_branch
      : "main";
  return { repoFullName: repository.full_name, gitRef: payload.ref, defaultBranch };
}

/** True when this source tracks the branch or tag the push moved. An empty
 * source ref means the repository default branch. */
export function skillSourceRefMatchesPush(sourceRef: string, push: SkillPushRef): boolean {
  const branch = push.gitRef.startsWith("refs/heads/") ? push.gitRef.slice("refs/heads/".length) : null;
  const tag = push.gitRef.startsWith("refs/tags/") ? push.gitRef.slice("refs/tags/".length) : null;
  const short = branch ?? tag;
  if (sourceRef === "") {
    return branch !== null && branch === push.defaultBranch;
  }
  return sourceRef === push.gitRef || (short !== null && sourceRef === short);
}

export async function findOrgSkillSourcesForPush(
  db: AppDb,
  orgId: string,
  push: SkillPushRef,
): Promise<SkillSourceRow[]> {
  const rows = await db
    .select()
    .from(skillSources)
    .where(
      and(
        eq(skillSources.orgId, orgId),
        eq(skillSources.ownerType, "org"),
        eq(skillSources.repoFullName, push.repoFullName),
        eq(skillSources.enabled, true),
      ),
    );
  return rows.filter((row) => skillSourceRefMatchesPush(row.ref, push));
}
