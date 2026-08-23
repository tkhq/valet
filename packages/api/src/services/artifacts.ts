/**
 * Artifact sharing (2026-08-22 artifacts design): snapshot a memory file
 * into the `artifacts` table and serve it by capability token.
 *
 * An artifact is a COPY at share time, never a live reference — the public
 * read path must not reach into `memory_files`. Re-share on the same path
 * overwrites the snapshot and keeps the token (the link stays stable);
 * re-share after a revoke mints a fresh token so a leaked link stays dead.
 *
 * Visibility rules live in `decideArtifactAccess`, a pure function so the
 * whole matrix is unit-testable without an HTTP server: `org` needs a
 * logged-in member of the artifact's org; `public` needs the org's
 * `allow_public_artifacts` opt-in, live-checked on every read.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { NotFoundError, ValidationError } from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { normalizePath } from "../lib/okf.js";
import { artifacts, orgs } from "../schema/index.js";
import { readFile, type MemoryScope } from "./memory.js";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVisibility = "org" | "public";

/** 128 bits of entropy, base64url — the whole capability for a `public`
 * artifact, so no shorter. */
function mintToken(): string {
  return randomBytes(16).toString("base64url");
}

export interface ShareArtifactOpts {
  path: string;
  orgId: string;
  /** Session that ran `mem_share`, when the share came from a tool call. */
  sourceSessionId?: string;
}

/**
 * Snapshot the memory file at `opts.path` into an artifact (create or
 * refresh). Reads through the memory service with the caller's scope, so a
 * caller can only share what that scope can already read. Always writes
 * `visibility: "org"` on create; a refresh keeps the stored visibility —
 * widening is a separate, human-only action (`setArtifactVisibility`).
 */
export async function shareArtifact(db: AppDb, scope: MemoryScope, opts: ShareArtifactOpts): Promise<ArtifactRow> {
  if (opts.path.startsWith("team:")) {
    throw new ValidationError(
      "Team-prefixed virtual paths cannot be shared. Share from the team scope itself, or copy the file into your own memory first.",
    );
  }
  const result = await readFile(db, scope, opts.path);
  if (result.kind !== "file") {
    throw new ValidationError("Only files can be shared. Pass a file path, not a directory.");
  }

  const now = Date.now();
  const existingRows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.ownerType, scope.owner.type),
        eq(artifacts.ownerId, scope.owner.id),
        eq(artifacts.sourceMemoryPath, result.file.path),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    const reactivating = existing.revokedAt !== null;
    const [row] = await db
      .update(artifacts)
      .set({
        // A revoked artifact's token may have leaked — that is usually why
        // it was revoked — so reactivation replaces it.
        token: reactivating ? mintToken() : existing.token,
        title: result.file.title,
        content: result.file.content,
        actorUserId: scope.actorUserId,
        sourceSessionId: opts.sourceSessionId ?? existing.sourceSessionId,
        updatedAt: now,
        revokedAt: null,
        // A live refresh keeps the stored visibility (a human widened it;
        // re-publishing content is not a scope decision). Reactivating a
        // REVOKED row resets to `org`: revoke ended the audience decision
        // along with the link, and the tool surface must never be the
        // thing that restores anonymous access.
        ...(reactivating ? { visibility: "org" as const, publicBy: null } : {}),
      })
      .where(eq(artifacts.id, existing.id))
      .returning();
    if (!row) throw new NotFoundError("artifact", existing.id);
    return row;
  }

  const [inserted] = await db
    .insert(artifacts)
    .values({
      id: randomUUID(),
      token: mintToken(),
      ownerType: scope.owner.type,
      ownerId: scope.owner.id,
      orgId: opts.orgId,
      actorUserId: scope.actorUserId,
      sourceSessionId: opts.sourceSessionId ?? "",
      sourceMemoryPath: result.file.path,
      title: result.file.title,
      content: result.file.content,
      visibility: "org",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!inserted) throw new NotFoundError("artifact", "inserted row");
  return inserted;
}

/** Revoke the active artifact for `path` in this scope. 404 when nothing
 * is shared at that path. */
export async function revokeArtifactByPath(db: AppDb, scope: MemoryScope, path: string): Promise<void> {
  // Rows store the CANONICAL memory path (share reads through `readFile`,
  // which normalizes). Normalize here too, or a caller who shared with
  // '/x.md' and revokes with the same string misses the row — a 404 while
  // the link stays live. Throws ReservedPathError for garbage, same as
  // the share path.
  const normalized = normalizePath(path);
  const rows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.ownerType, scope.owner.type),
        eq(artifacts.ownerId, scope.owner.id),
        eq(artifacts.sourceMemoryPath, normalized),
        isNull(artifacts.revokedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError("artifact", normalized);
  await db.update(artifacts).set({ revokedAt: Date.now() }).where(eq(artifacts.id, row.id));
}

export async function getArtifactByToken(db: AppDb, token: string): Promise<ArtifactRow | undefined> {
  const rows = await db.select().from(artifacts).where(eq(artifacts.token, token)).limit(1);
  return rows[0];
}

export async function getArtifactById(db: AppDb, id: string): Promise<ArtifactRow | undefined> {
  const rows = await db.select().from(artifacts).where(eq(artifacts.id, id)).limit(1);
  return rows[0];
}

/** Everything the list/manage surfaces need — deliberately WITHOUT
 * `content`: a list of shares must not drag every snapshot body out of
 * the database. */
export interface ArtifactSummaryRow {
  id: string;
  token: string;
  sourceMemoryPath: string;
  title: string;
  visibility: "org" | "public";
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const summaryColumns = {
  id: artifacts.id,
  token: artifacts.token,
  sourceMemoryPath: artifacts.sourceMemoryPath,
  title: artifacts.title,
  visibility: artifacts.visibility,
  revokedAt: artifacts.revokedAt,
  createdAt: artifacts.createdAt,
  updatedAt: artifacts.updatedAt,
};

/** The caller's own shares — the rows where they were the sharing actor.
 * Org admins additionally see every artifact in the org. */
export async function listArtifacts(
  db: AppDb,
  caller: { id: string; orgId: string; orgAdmin: boolean },
): Promise<ArtifactSummaryRow[]> {
  const where = caller.orgAdmin ? eq(artifacts.orgId, caller.orgId) : eq(artifacts.actorUserId, caller.id);
  return db.select(summaryColumns).from(artifacts).where(where).orderBy(desc(artifacts.updatedAt));
}

export async function setArtifactVisibility(
  db: AppDb,
  id: string,
  visibility: ArtifactVisibility,
  actorUserId: string,
): Promise<ArtifactRow> {
  const [row] = await db
    .update(artifacts)
    .set({
      visibility,
      // Audit who widened; narrowing clears it — the artifact is no longer
      // public because of anyone.
      publicBy: visibility === "public" ? actorUserId : null,
      updatedAt: Date.now(),
    })
    .where(eq(artifacts.id, id))
    .returning();
  if (!row) throw new NotFoundError("artifact", id);
  return row;
}

export async function revokeArtifactById(db: AppDb, id: string): Promise<void> {
  await db.update(artifacts).set({ revokedAt: Date.now() }).where(eq(artifacts.id, id));
}

export async function getAllowPublicArtifacts(db: AppDb, orgId: string): Promise<boolean> {
  const rows = await db
    .select({ allowPublicArtifacts: orgs.allowPublicArtifacts })
    .from(orgs)
    .where(eq(orgs.id, orgId))
    .limit(1);
  return rows[0]?.allowPublicArtifacts ?? false;
}

// ─── Access decision ───────────────────────────────────────────────────

export type ArtifactAccess =
  /** Serve the document. */
  | { kind: "serve" }
  /** 401 — a login could change the answer. */
  | { kind: "login" }
  /** 404 — missing, revoked, or a caller the artifact must not confirm
   * exists for (wrong org). */
  | { kind: "not_found" };

/**
 * The whole read-authorization matrix for `GET /api/artifacts/:token`,
 * pure so every branch is unit-testable. Wrong-org callers get
 * `not_found`, not a 403 — the existence-hiding convention the memory
 * routes follow.
 */
export function decideArtifactAccess(opts: {
  artifact: Pick<ArtifactRow, "orgId" | "visibility" | "revokedAt"> | undefined;
  allowPublicArtifacts: boolean;
  user: { orgId: string } | undefined;
}): ArtifactAccess {
  const { artifact, user } = opts;
  if (!artifact || artifact.revokedAt !== null) return { kind: "not_found" };
  if (artifact.visibility === "public" && opts.allowPublicArtifacts) return { kind: "serve" };
  if (!user) return { kind: "login" };
  if (user.orgId !== artifact.orgId) return { kind: "not_found" };
  return { kind: "serve" };
}
