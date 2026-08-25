/**
 * Tracked repositories — CRUD over the `skill_sources` table, plus the
 * parsing that turns a pasted repository address into one row.
 *
 * A source is a subscription to a GitHub repository. `kinds` says what the
 * sync collects from it; a skills source expects the Agent Skills layout
 * (`<root>/<skill-name>/SKILL.md`). The repository is authoritative:
 * `services/content-sync/service.ts` is the only writer of the
 * `origin='repo'` rows a source carries, and deleting a source deletes them,
 * because a mirror has no existence apart from what it mirrors.
 *
 * Access follows `services/skills.ts` exactly, through the same
 * `isAuthorizedFor`: your own rows plus the rows of every team you belong to,
 * with a row another owner holds reported as not found rather than as
 * forbidden.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Principal } from "@valet/engine";
import { NotFoundError } from "@valet/shared";
import { isPgUniqueViolation } from "@valet/store-postgres";
import type { AppDb } from "../lib/drizzle.js";
import { decodePageCursor, encodePageCursor } from "../lib/page-cursor.js";
import { skills, contentSources, type ContentSourceRow } from "../schema/index.js";
import { isTeamMember, listTeamsForUser, lockTeamForOwnership } from "./teams.js";
import { isAuthorizedFor, type SkillOwner } from "./skills.js";

/** `owner/repo` segments GitHub accepts. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** Thrown when the pasted repository address is not one this can track.
 *
 * `code` still reads `skill_source_*` on both errors below. It is the wire
 * contract `routes/skills.ts` answers with and the web client reads, so it
 * does not move with the table. */
export class ContentSourceInputError extends Error {
  readonly code = "skill_source_invalid";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ContentSourceInputError";
  }
}

/** Thrown when the same repository and subdirectory are already tracked. */
export class ContentSourceConflictError extends Error {
  readonly code = "skill_source_conflict";
  readonly statusCode = 409;
  constructor(repo: string) {
    super(`${repo} is already tracked here. Remove the existing entry first.`);
    this.name = "ContentSourceConflictError";
  }
}

/** The `skillsrc_` prefix predates the content-sync generalization and
 * stays. Ids are persisted, `services/config-reconcile.ts` matches on the
 * prefix, and a new prefix would split one table's ids into two shapes for
 * no gain. */
export function newContentSourceId(): string {
  return `skillsrc_${randomUUID()}`;
}

export interface ParsedRepoInput {
  repoFullName: string;
  /** Empty means the default branch. */
  ref: string;
  /** Empty means the repository root. */
  subpath: string;
}

export interface ParseRepoOptions {
  /** Overrides a ref read out of a tree URL. */
  ref?: string;
  /** Overrides a subdirectory read out of a tree URL. */
  subpath?: string;
}

/**
 * Reads `owner/repo` out of what a person pasted. Four forms are accepted:
 * `owner/repo`, `github.com/owner/repo`, the same with a scheme or a `.git`
 * suffix, and a tree URL such as
 * `https://github.com/owner/repo/tree/main/skills`.
 *
 * A tree URL's ref is taken as ONE path segment, so a branch whose name holds
 * a slash cannot be read out of the URL. Nothing in the URL says where the
 * ref stops and the directory starts. Pass `opts.ref` for that case; an
 * explicit option always wins over what the URL implies.
 */
export function parseRepoInput(raw: string, opts: ParseRepoOptions = {}): ParsedRepoInput {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) {
    throw new ContentSourceInputError(
      "Enter a repository. Write it as owner/repo, or paste its GitHub URL.",
    );
  }

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const hostSplit = withoutScheme.indexOf("/");
  const maybeHost = hostSplit === -1 ? "" : withoutScheme.slice(0, hostSplit);
  // A first segment holding a dot is a host name, not a GitHub owner: GitHub
  // owners may contain dots but never look like `github.com`, and every
  // non-GitHub host must be rejected rather than read as an owner.
  const isHostForm = maybeHost.includes(".");
  if (isHostForm && !GITHUB_HOSTS.has(maybeHost.toLowerCase())) {
    throw new ContentSourceInputError(
      `Valet reads GitHub repositories only, and ${maybeHost} is not GitHub. Enter a github.com repository.`,
    );
  }

  const path = isHostForm ? withoutScheme.slice(hostSplit + 1) : withoutScheme;
  const segments = path.split("/").filter((s) => s.length > 0);
  const [ownerSeg, repoSeg, treeSeg, ...rest] = segments;
  const repoName = repoSeg?.replace(/\.git$/, "") ?? "";

  if (!ownerSeg || !repoName || !SEGMENT.test(ownerSeg) || !SEGMENT.test(repoName)) {
    throw new ContentSourceInputError(
      `"${raw}" is not a repository address. Write it as owner/repo, or paste its GitHub URL.`,
    );
  }
  if (treeSeg !== undefined && treeSeg !== "tree") {
    throw new ContentSourceInputError(
      `"${raw}" points inside a repository. Paste the repository URL, or a /tree/ URL for a subdirectory.`,
    );
  }

  const [urlRef, ...urlSubpath] = rest;
  return {
    repoFullName: `${ownerSeg}/${repoName}`,
    ref: normalizeRef(opts.ref ?? urlRef ?? ""),
    subpath: normalizeSubpath(opts.subpath ?? urlSubpath.join("/")),
  };
}

function normalizeRef(ref: string): string {
  const value = ref.trim().replace(/^\/+|\/+$/g, "");
  if (value.includes("..") || /\s/.test(value)) {
    throw new ContentSourceInputError(
      `"${ref}" is not a branch, tag, or commit. Enter one ref, with no spaces.`,
    );
  }
  return value;
}

function normalizeSubpath(subpath: string): string {
  const value = subpath.trim().replace(/^\/+|\/+$/g, "");
  if (value.split("/").includes("..")) {
    throw new ContentSourceInputError(
      `"${subpath}" leaves the repository. Enter a directory inside the repository.`,
    );
  }
  return value;
}

export interface CreateContentSourceInput {
  /** `owner/repo`, or a GitHub URL. */
  repo: string;
  ref?: string;
  subpath?: string;
  /** Tracks the repository for a team the caller belongs to. A team the
   * caller is not on is rejected as not found. Mutually exclusive with
   * `ownerType: "org"`. */
  teamId?: string;
  /** Tracks the repository for the org instead of for the caller.
   * Only accepted when `isOrgAdmin` is `true`; ignored otherwise. Mutually
   * exclusive with `teamId`. */
  ownerType?: "user" | "team" | "org";
  /** When `ownerType` is `"org"`, the caller must be an org admin.
   * Pass `true` after checking — the service trusts this flag. */
  isOrgAdmin?: boolean;
}

/**
 * Adds a tracked repository for the caller, for a team they belong to, or for
 * the org when the caller is an org admin. The new row is due immediately, so
 * the next sweep pass imports it without waiting a full poll interval.
 */
export async function createContentSource(
  db: AppDb,
  owner: SkillOwner,
  input: CreateContentSourceInput,
): Promise<ContentSourceRow> {
  const parsed = parseRepoInput(input.repo, { ref: input.ref, subpath: input.subpath });
  // `typeof === "string"`, not `!== undefined`: the route casts an unchecked
  // JSON body, so an explicit `teamId: null` must fall through to a personal
  // source. Same rule `createSkill` follows.
  const teamId = typeof input.teamId === "string" ? input.teamId : undefined;
  const isOrgOwned = input.ownerType === "org";
  // team and org are mutually exclusive scopes for one source.
  if (isOrgOwned && teamId !== undefined) {
    throw new ContentSourceInputError(
      "A source is either a team source or an org source, not both. Remove teamId or the org scope.",
    );
  }
  const now = Date.now();
  const row: ContentSourceRow = {
    id: newContentSourceId(),
    orgId: owner.orgId,
    ownerType: isOrgOwned ? "org" : teamId ? "team" : "user",
    ownerId: isOrgOwned ? owner.orgId : teamId ?? owner.userId,
    // Recorded for every owner type. A team row has no other user identity
    // on it, and the unattended sweep needs one to pick a GitHub credential
    // — see `services/content-source-credential.ts`.
    createdBy: owner.userId,
    repoFullName: parsed.repoFullName,
    ref: parsed.ref,
    subpath: parsed.subpath,
    // Skills only. Workflow and template collection is opened per source by
    // the source routes, and it needs authority over the owner first
    // (2026-08-24 workflows MVP design, decision 10).
    kinds: ["skills"],
    enabled: true,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now,
    lastSha: null,
    lastManifestHash: null,
    // The first sync has no commit to compare against, so it scans whatever
    // the current rules find and records the version it ran under.
    discoveryRulesVersion: null,
    lastSyncedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    if (isOrgOwned || teamId === undefined) {
      await db.insert(contentSources).values(row);
    } else {
      // Same advisory lock `createSkill` takes, for the same reason: without
      // it a source could be inserted for a team whose rows are deleted in
      // the gap between the membership check and the insert.
      await db.transaction(async (tx) => {
        await lockTeamForOwnership(tx, teamId);
        if (!(await isTeamMember(tx, teamId, owner.userId))) {
          throw new NotFoundError("team", teamId);
        }
        await tx.insert(contentSources).values(row);
      });
    }
  } catch (err) {
    // The only unique index on this table is `skill_sources_repo` (ids are
    // freshly minted UUIDs), so a unique violation is always a repeat.
    if (isPgUniqueViolation(err)) throw new ContentSourceConflictError(parsed.repoFullName);
    throw err;
  }
  return row;
}

/**
 * One source, or null when it is missing OR the caller may not reach it. The
 * two cases are deliberately indistinguishable, as everywhere else.
 */
export async function ownedContentSourceRow(
  db: AppDb,
  owner: SkillOwner,
  id: string,
  opts: { isOrgAdmin?: boolean } = {},
): Promise<ContentSourceRow | null> {
  const rows = await db.select().from(contentSources).where(eq(contentSources.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return (await isAuthorizedFor(db, owner, row, opts)) ? row : null;
}

export const CONTENT_SOURCE_DEFAULT_LIMIT = 20;
export const CONTENT_SOURCE_MAX_LIMIT = 100;

/**
 * The sort key of the last row of a page: repository name, then subdirectory,
 * then row id. The first two are the order a reader sees; `id` breaks the tie
 * two owners tracking the same repository and subdirectory would otherwise
 * leave, and the unique index permits exactly that pair across owners.
 */
export interface ContentSourceCursor {
  repo: string;
  sub: string;
  id: string;
}

export function encodeContentSourceCursor(cursor: ContentSourceCursor): string {
  return encodePageCursor({ ...cursor });
}

/** `undefined` for a cursor this listing did not issue. The route answers
 * that with 400 rather than silently restarting at page one. */
export function decodeContentSourceCursor(raw: string): ContentSourceCursor | undefined {
  const fields = decodePageCursor(raw);
  if (!fields) return undefined;
  const { repo, sub, id } = fields;
  if (typeof repo !== "string" || typeof sub !== "string" || typeof id !== "string") {
    return undefined;
  }
  return { repo, sub, id };
}

export interface ContentSourcePage {
  rows: ContentSourceRow[];
  nextCursor: string | undefined;
}

/**
 * Every source the caller can reach: their own rows, the rows of every team
 * they belong to, and the org-library rows, sorted by repository name.
 *
 * Org rows show for EVERY member (read-only to a non-admin), the same rule
 * `listSkills` follows: `isAuthorizedFor` still returns false for a non-admin
 * org write, so `ownedContentSourceRow` never treats an org row as the caller's
 * to change.
 *
 * `scope` narrows the answer to ONE owner, and replaces the union rather
 * than adding to it — the same rule, and the same reason, as `listSkills`.
 * Reaching `scope` is the caller's question to answer first: `routes/skills.ts`
 * runs the query string through `readOwnerScope` before it gets here.
 *
 * Keyset-paginated on `(repo_full_name, subpath, id)`, the same shape the
 * action log uses (`policies/admin.ts`). Keyset, not `OFFSET`, so a source
 * added while somebody reads page two never shifts a row onto a page that
 * was already read or off one that was not. `limit + 1` rows are fetched to
 * learn whether a further page exists without a second COUNT.
 */
export async function listContentSources(
  db: AppDb,
  owner: SkillOwner,
  scope: Principal | undefined,
  limit: number,
  cursor: ContentSourceCursor | undefined,
): Promise<ContentSourcePage> {
  const teamIds = scope ? [] : (await listTeamsForUser(db, owner.userId)).map((t) => t.id);
  const ownerMatch = and(eq(contentSources.ownerType, "user"), eq(contentSources.ownerId, owner.userId));
  const teamMatch =
    teamIds.length > 0
      ? and(eq(contentSources.ownerType, "team"), inArray(contentSources.ownerId, teamIds))
      : undefined;
  // Every org row in the caller's own org — the `orgId` predicate below bounds
  // it — because the org library is readable by every member.
  const orgMatch = eq(contentSources.ownerType, "org");
  const reach = scope
    ? and(eq(contentSources.ownerType, scope.type), eq(contentSources.ownerId, scope.id))
    : teamMatch
      ? or(ownerMatch, teamMatch, orgMatch)
      : or(ownerMatch, orgMatch);

  const after = cursor
    ? sql`(${contentSources.repoFullName}, ${contentSources.subpath}, ${contentSources.id}) > (${cursor.repo}, ${cursor.sub}, ${cursor.id})`
    : undefined;

  const rows = await db
    .select()
    .from(contentSources)
    .where(and(eq(contentSources.orgId, owner.orgId), reach, after))
    .orderBy(asc(contentSources.repoFullName), asc(contentSources.subpath), asc(contentSources.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor:
      hasMore && last
        ? encodeContentSourceCursor({ repo: last.repoFullName, sub: last.subpath, id: last.id })
        : undefined,
  };
}

/**
 * Removes a source and the skills it mirrors. Returns false when the id is
 * missing or unreachable.
 *
 * The skill delete is scoped by `source_id` AND `origin='repo'`, the same
 * pair every sync write uses. That scoping is what keeps the delete off a
 * skill somebody wrote here and off another source's rows.
 */
export async function deleteContentSource(
  db: AppDb,
  owner: SkillOwner,
  id: string,
  opts: { isOrgAdmin?: boolean } = {},
): Promise<boolean> {
  const row = await ownedContentSourceRow(db, owner, id, opts);
  if (!row) return false;
  await db.transaction(async (tx) => {
    await tx.delete(skills).where(and(eq(skills.sourceId, id), eq(skills.origin, "repo")));
    await tx.delete(contentSources).where(eq(contentSources.id, id));
  });
  return true;
}

/**
 * Makes a source due now. "Sync now" calls this and then the SAME
 * `syncOnce` the sweep calls, so a manual sync is the scheduled sync brought
 * forward, not a second implementation of syncing.
 */
export async function markContentSourceDue(db: AppDb, id: string): Promise<void> {
  const now = Date.now();
  await db
    .update(contentSources)
    .set({ nextAttemptAt: now, updatedAt: now })
    .where(eq(contentSources.id, id));
}

/** How many skills each of `sourceIds` currently mirrors. */
export async function countSkillsPerSource(
  db: AppDb,
  sourceIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (sourceIds.length === 0) return counts;
  const rows = await db
    .select({ sourceId: skills.sourceId })
    .from(skills)
    .where(and(inArray(skills.sourceId, sourceIds), eq(skills.origin, "repo")));
  for (const row of rows) {
    if (row.sourceId === null) continue;
    counts.set(row.sourceId, (counts.get(row.sourceId) ?? 0) + 1);
  }
  return counts;
}
