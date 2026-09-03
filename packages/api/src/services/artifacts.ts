/**
 * Artifact publishing (2026-08-22 artifacts design; 2026-09-02 artifact-pages
 * design): snapshot content into the `artifacts` table and serve it by
 * capability token.
 *
 * An artifact is a COPY at publish time, never a live reference — the public
 * read path must not reach into `memory_files` or a session. Re-publish on
 * the same key overwrites the snapshot, appends an `artifact_versions` row,
 * and keeps the token (the link stays stable); re-publish after a revoke
 * mints a fresh token so a leaked link stays dead.
 *
 * Every artifact is a page: `content` is the source, `format` names its
 * compiler, and `rendered` is the compiled body every viewer renders in the
 * sandboxed frame. Markdown compiles through GFM here, at publish, so the
 * web client never compiles.
 *
 * Visibility rules live in `decideArtifactAccess`, a pure function so the
 * whole matrix is unit-testable without an HTTP server: `org` needs a
 * logged-in member of the artifact's org; `public` needs the org's
 * `allow_public_artifacts` opt-in, live-checked on every read.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { marked } from "marked";
import {
  NotFoundError,
  ValidationError,
  artifactSizeError,
  isArtifactFormat,
  normalizeArtifactIcon,
  resolveArtifactTitle,
  type ArtifactFormat,
} from "@valet/shared";
import type { AppDb } from "../lib/drizzle.js";
import { normalizePath } from "../lib/okf.js";
import { artifactComments, artifactVersions, artifacts, orgs } from "../schema/index.js";
import { readFile, type MemoryScope } from "./memory.js";

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
export type ArtifactCommentRow = typeof artifactComments.$inferSelect;
export type ArtifactVisibility = "org" | "public";

/** 128 bits of entropy, base64url — the whole capability for a `public`
 * artifact, so no shorter. */
function mintToken(): string {
  return randomBytes(16).toString("base64url");
}

// ─── Compile ─────────────────────────────────────────────────────────────

/**
 * Compile an artifact source to the page body the frame renders. Markdown
 * goes through GFM and gets the shell's document wrapper class; HTML passes
 * verbatim. The output is NOT sanitized on purpose: it renders in a sandboxed
 * frame under the artifact CSP, where containment does not depend on the
 * compiler's output (artifact-pages design, "Why one render path").
 */
export function renderArtifactBody(content: string, format: ArtifactFormat): string {
  if (format === "html") return content;
  const body = marked.parse(content, { async: false, gfm: true });
  return `<div class="valet-artifact-doc">\n${body}\n</div>`;
}

// ─── Publish ─────────────────────────────────────────────────────────────

export interface ShareArtifactOpts {
  path: string;
  orgId: string;
  /** Session that ran the tool, when the publish came from a tool call. */
  sourceSessionId?: string;
}

export interface PublishArtifactOpts {
  key: string;
  content: string;
  format: ArtifactFormat;
  title?: string;
  description?: string;
  icon?: string;
  orgId: string;
  sourceSessionId?: string;
}

/** What every publish path hands the upsert, after its own validation. */
interface PublishInput {
  key: string;
  title: string;
  content: string;
  format: ArtifactFormat;
  description: string;
  icon: string;
  orgId: string;
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
  return upsertArtifact(db, scope, {
    key: result.file.path,
    title: result.file.title,
    content: result.file.content,
    format: "markdown",
    description: "",
    icon: "",
    orgId: opts.orgId,
    sourceSessionId: opts.sourceSessionId,
  });
}

/**
 * Publish inline content as an artifact (create or refresh), the
 * `artifact_publish` tool's path. The key is normalized by the memory-path
 * rules so tool calls cannot mint colliding or hostile keys; it shares the
 * publish-key namespace with memory shares, which is the point — one key, one
 * artifact, one URL.
 */
export async function publishArtifact(db: AppDb, scope: MemoryScope, opts: PublishArtifactOpts): Promise<ArtifactRow> {
  if (!isArtifactFormat(opts.format)) {
    throw new ValidationError("format must be 'markdown' or 'html'.");
  }
  const key = normalizePath(opts.key);
  if (key.endsWith("/")) {
    throw new ValidationError("The publish key must name a file-like path, not a directory.");
  }
  const sizeError = artifactSizeError(opts.content);
  if (sizeError) throw new ValidationError(sizeError);
  const title = resolveArtifactTitle({
    explicit: opts.title,
    content: opts.content,
    format: opts.format,
    key,
  });
  return upsertArtifact(db, scope, {
    key,
    title,
    content: opts.content,
    format: opts.format,
    description: opts.description?.trim().slice(0, 1000) ?? "",
    icon: normalizeArtifactIcon(opts.icon),
    orgId: opts.orgId,
    sourceSessionId: opts.sourceSessionId,
  });
}

/**
 * The shared upsert: compile, bump the version counter, append the version
 * row, and refresh the denormalized current fields. Token and visibility
 * semantics are unchanged from the 2026-08-22 design: a live refresh keeps
 * both; reactivating a REVOKED row replaces the token and resets visibility
 * to `org` (revoke ended the audience decision along with the link, and the
 * tool surface must never be the thing that restores anonymous access).
 * Reactivation also clears `shared_version`: the pin was part of the revoked
 * audience decision.
 */
async function upsertArtifact(db: AppDb, scope: MemoryScope, input: PublishInput): Promise<ArtifactRow> {
  const rendered = renderArtifactBody(input.content, input.format);
  const now = Date.now();
  const existingRows = await db
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.ownerType, scope.owner.type),
        eq(artifacts.ownerId, scope.owner.id),
        eq(artifacts.sourceMemoryPath, input.key),
      ),
    )
    .limit(1);
  const existing = existingRows[0];

  if (existing) {
    const reactivating = existing.revokedAt !== null;
    const nextVersion = existing.version + 1;
    const [row] = await db
      .update(artifacts)
      .set({
        // A revoked artifact's token may have leaked — that is usually why
        // it was revoked — so reactivation replaces it.
        token: reactivating ? mintToken() : existing.token,
        title: input.title,
        content: input.content,
        format: input.format,
        rendered,
        description: input.description,
        icon: input.icon,
        version: nextVersion,
        actorUserId: scope.actorUserId,
        sourceSessionId: input.sourceSessionId ?? existing.sourceSessionId,
        updatedAt: now,
        revokedAt: null,
        ...(reactivating
          ? { visibility: "org" as const, publicBy: null, sharedVersion: null }
          : {}),
      })
      .where(eq(artifacts.id, existing.id))
      .returning();
    if (!row) throw new NotFoundError("artifact", existing.id);
    await appendVersion(db, row, scope.actorUserId, now);
    return row;
  }

  const [inserted] = await db
    .insert(artifacts)
    .values({
      id: randomUUID(),
      token: mintToken(),
      ownerType: scope.owner.type,
      ownerId: scope.owner.id,
      orgId: input.orgId,
      actorUserId: scope.actorUserId,
      sourceSessionId: input.sourceSessionId ?? "",
      sourceMemoryPath: input.key,
      title: input.title,
      content: input.content,
      format: input.format,
      rendered,
      description: input.description,
      icon: input.icon,
      version: 1,
      visibility: "org",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!inserted) throw new NotFoundError("artifact", "inserted row");
  await appendVersion(db, inserted, scope.actorUserId, now);
  return inserted;
}

async function appendVersion(db: AppDb, row: ArtifactRow, actorUserId: string, now: number): Promise<void> {
  await db.insert(artifactVersions).values({
    id: randomUUID(),
    artifactId: row.id,
    version: row.version,
    title: row.title,
    format: row.format,
    content: row.content,
    rendered: row.rendered,
    actorUserId,
    createdAt: now,
  });
}

/** Revoke the active artifact for `path` in this scope. 404 when nothing
 * is shared at that path. */
export async function revokeArtifactByPath(db: AppDb, scope: MemoryScope, path: string): Promise<void> {
  // Rows store the CANONICAL publish key (share reads through `readFile`,
  // which normalizes; publish normalizes here). Normalize too, or a caller
  // who shared with '/x.md' and revokes with the same string misses the row —
  // a 404 while the link stays live. Throws ReservedPathError for garbage,
  // same as the share path.
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

// ─── Served version ──────────────────────────────────────────────────────

/** The one version the public read serves: what a link holder sees. */
export interface ServedArtifactVersion {
  title: string;
  content: string;
  rendered: string;
  format: ArtifactFormat;
  version: number;
}

/**
 * Resolve the version a viewer gets. Unpinned artifacts serve the
 * denormalized current fields (no join); pinned ones load the version row. A
 * pin naming a missing row falls back to current rather than 404ing a link
 * that worked yesterday. A pre-pages row (`rendered = ""`) compiles on read.
 */
export async function resolveServedVersion(db: AppDb, artifact: ArtifactRow): Promise<ServedArtifactVersion> {
  let served: Pick<ArtifactRow, "title" | "content" | "rendered" | "format" | "version"> = artifact;
  if (artifact.sharedVersion !== null && artifact.sharedVersion !== artifact.version) {
    const rows = await db
      .select()
      .from(artifactVersions)
      .where(
        and(
          eq(artifactVersions.artifactId, artifact.id),
          eq(artifactVersions.version, artifact.sharedVersion),
        ),
      )
      .limit(1);
    if (rows[0]) served = rows[0];
  }
  const format: ArtifactFormat = served.format === "html" ? "html" : "markdown";
  return {
    title: served.title,
    content: served.content,
    rendered: served.rendered !== "" ? served.rendered : renderArtifactBody(served.content, format),
    format,
    version: served.version,
  };
}

/** Version metadata for the management surface — no content bodies. */
export interface ArtifactVersionSummary {
  version: number;
  title: string;
  format: ArtifactFormat;
  actorUserId: string;
  createdAt: number;
}

export async function listArtifactVersions(db: AppDb, artifactId: string): Promise<ArtifactVersionSummary[]> {
  const rows = await db
    .select({
      version: artifactVersions.version,
      title: artifactVersions.title,
      format: artifactVersions.format,
      actorUserId: artifactVersions.actorUserId,
      createdAt: artifactVersions.createdAt,
    })
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.version));
  return rows.map((r) => ({ ...r, format: r.format === "html" ? "html" : "markdown" }));
}

/**
 * Pin viewers to one version (or null for latest). A pin must name a real
 * version row — pre-pages publishes wrote none, and pinning to a phantom
 * would serve the fallback while claiming the pin took.
 */
export async function setArtifactSharedVersion(
  db: AppDb,
  id: string,
  sharedVersion: number | null,
): Promise<ArtifactRow> {
  if (sharedVersion !== null) {
    const rows = await db
      .select({ version: artifactVersions.version })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, sharedVersion)))
      .limit(1);
    if (!rows[0]) {
      throw new ValidationError(`Version ${sharedVersion} does not exist for this artifact.`);
    }
  }
  const [row] = await db
    .update(artifacts)
    .set({ sharedVersion, updatedAt: Date.now() })
    .where(eq(artifacts.id, id))
    .returning();
  if (!row) throw new NotFoundError("artifact", id);
  return row;
}

// ─── List / manage ───────────────────────────────────────────────────────

/** Everything the list/manage surfaces need — deliberately WITHOUT
 * `content`: a list of shares must not drag every snapshot body out of
 * the database. */
export interface ArtifactSummaryRow {
  id: string;
  token: string;
  sourceMemoryPath: string;
  title: string;
  format: string;
  icon: string;
  version: number;
  sharedVersion: number | null;
  visibility: "org" | "public";
  actorUserId: string;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const summaryColumns = {
  id: artifacts.id,
  token: artifacts.token,
  sourceMemoryPath: artifacts.sourceMemoryPath,
  title: artifacts.title,
  format: artifacts.format,
  icon: artifacts.icon,
  version: artifacts.version,
  sharedVersion: artifacts.sharedVersion,
  visibility: artifacts.visibility,
  actorUserId: artifacts.actorUserId,
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

/** One owner's artifacts, newest first (team dashboard design). The ROUTE
 * gates access — team owners on membership — before calling this. */
export async function listArtifactsForOwner(
  db: AppDb,
  orgId: string,
  owner: { type: string; id: string },
): Promise<ArtifactSummaryRow[]> {
  return db
    .select(summaryColumns)
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, orgId),
        eq(artifacts.ownerType, owner.type),
        eq(artifacts.ownerId, owner.id),
      ),
    )
    .orderBy(desc(artifacts.updatedAt));
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

// ─── Comments ────────────────────────────────────────────────────────────

const COMMENT_BODY_MAX = 4096;

export interface AddArtifactCommentOpts {
  artifactId: string;
  version: number;
  vdid?: string;
  parentId?: string;
  body: string;
  authorUserId: string;
}

/**
 * Store one comment. Threading is one level deep: a reply's parent must be a
 * root comment on the same artifact. Anchors are stored verbatim — the vdid
 * is only meaningful to the viewer's runtime, and an id that stops resolving
 * renders as an orphaned thread, never an error.
 */
export async function addArtifactComment(db: AppDb, opts: AddArtifactCommentOpts): Promise<ArtifactCommentRow> {
  const body = opts.body.trim();
  if (body.length === 0) throw new ValidationError("Comment body is required.");
  if (body.length > COMMENT_BODY_MAX) {
    throw new ValidationError(`Comments are capped at ${COMMENT_BODY_MAX} characters.`);
  }
  if (opts.vdid !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(opts.vdid)) {
    throw new ValidationError("vdid must be a short id.");
  }
  if (opts.parentId) {
    const parents = await db
      .select({ id: artifactComments.id, parentId: artifactComments.parentId, artifactId: artifactComments.artifactId })
      .from(artifactComments)
      .where(eq(artifactComments.id, opts.parentId))
      .limit(1);
    const parent = parents[0];
    if (!parent || parent.artifactId !== opts.artifactId) {
      throw new NotFoundError("comment", opts.parentId);
    }
    if (parent.parentId !== null) {
      throw new ValidationError("Replies nest one level: reply to the thread's first comment.");
    }
  }
  const [row] = await db
    .insert(artifactComments)
    .values({
      id: randomUUID(),
      artifactId: opts.artifactId,
      version: opts.version,
      vdid: opts.vdid ?? null,
      parentId: opts.parentId ?? null,
      body,
      authorUserId: opts.authorUserId,
      createdAt: Date.now(),
    })
    .returning();
  if (!row) throw new NotFoundError("comment", "inserted row");
  return row;
}

export async function listArtifactComments(db: AppDb, artifactId: string): Promise<ArtifactCommentRow[]> {
  return db
    .select()
    .from(artifactComments)
    .where(eq(artifactComments.artifactId, artifactId))
    .orderBy(asc(artifactComments.createdAt));
}

export async function getArtifactComment(db: AppDb, id: string): Promise<ArtifactCommentRow | undefined> {
  const rows = await db.select().from(artifactComments).where(eq(artifactComments.id, id)).limit(1);
  return rows[0];
}

/** Resolve a root comment's thread. Replies are not independently
 * resolvable — resolve the root. */
export async function resolveArtifactComment(db: AppDb, id: string, resolvedBy: string): Promise<ArtifactCommentRow> {
  const existing = await getArtifactComment(db, id);
  if (!existing) throw new NotFoundError("comment", id);
  if (existing.parentId !== null) {
    throw new ValidationError("Resolve the thread's first comment, not a reply.");
  }
  const [row] = await db
    .update(artifactComments)
    .set({ resolvedAt: Date.now(), resolvedBy })
    .where(eq(artifactComments.id, id))
    .returning();
  if (!row) throw new NotFoundError("comment", id);
  return row;
}

/** Record that a comment was delivered into the source session. */
export async function markArtifactCommentSent(db: AppDb, id: string, sessionId: string): Promise<void> {
  await db.update(artifactComments).set({ sentToSession: sessionId }).where(eq(artifactComments.id, id));
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
