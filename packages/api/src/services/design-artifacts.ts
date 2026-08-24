/**
 * Design artifact service (docs/specs/2026-08-23-valet-design-design.md,
 * §Data Model). One artifact per kind='design' session; every mutation
 * appends a full-content revision row and moves `current_revision`.
 * Revert never deletes history — it appends a new revision whose content
 * is the old revision's.
 *
 * Event emission goes through `emitDesignEvent` below: a `host_event`
 * append on the session's EventStream, which the WS bridge maps to the
 * `design.*` wire events. REST stays the authoritative read path — events
 * carry ids and metadata, never artifact bytes (plan risk 6).
 */
import { and, desc, eq } from "drizzle-orm";
import type { EventStream } from "@valet/engine";
import {
  applyVdids,
  parseHeader,
  readTemplateStarter,
  validateDcHtml,
  DC_HTML_VERSION,
  MAX_ARTIFACT_BYTES,
} from "@valet/plugin-design/lib";
import {
  designArtifactRevisions,
  designArtifacts,
  designComments,
  type DesignArtifactRevisionRow,
  type DesignArtifactRow,
  type DesignCommentRow,
} from "../schema/index.js";
import type { AppDb } from "../lib/drizzle.js";
import { NotFoundError, ValidationError } from "@valet/shared";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** `r-001`, `r-002`, ... Monotonic per artifact; zero-padded to 3 digits
 * (wider once past 999 — parse the number, never the padding). */
export function nextRevisionId(current: string | null): string {
  const n = current ? Number(/^r-(\d+)$/.exec(current)?.[1] ?? 0) : 0;
  return `r-${String(n + 1).padStart(3, "0")}`;
}

export interface DesignArtifactDetail {
  artifact: DesignArtifactRow;
  content: string;
}

/**
 * Seed a design session's artifact from a template starter (revision
 * r-001). Called from session create in the same transaction as the
 * session row. Idempotent per session via the unique session index.
 */
export async function seedArtifact(
  db: AppDb,
  opts: { sessionId: string; template: string },
): Promise<DesignArtifactRow> {
  const { starter } = readTemplateStarter(opts.template);
  const { html } = applyVdids(starter);
  const now = Date.now();
  const artifactId = newId("da");
  const revision = nextRevisionId(null);

  const [artifact] = await db
    .insert(designArtifacts)
    .values({
      id: artifactId,
      sessionId: opts.sessionId,
      currentRevision: revision,
      sizeBytes: Buffer.byteLength(html),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await db.insert(designArtifactRevisions).values({
    id: newId("dr"),
    artifactId,
    revision,
    turnId: null,
    summary: `Seeded from the ${opts.template} template`,
    content: html,
    createdAt: now,
  });
  return artifact;
}

/** The artifact row alone — no revision content. The right lookup for
 * every path that needs only ids/metadata: the current revision's content
 * can be MAX_ARTIFACT_BYTES, and hauling it to read `artifact.id` is the
 * dominant per-request cost on the comment and revision-list routes. */
export async function getArtifactRowBySession(
  db: AppDb,
  sessionId: string,
): Promise<DesignArtifactRow | null> {
  const rows = await db
    .select()
    .from(designArtifacts)
    .where(eq(designArtifacts.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getArtifactBySession(
  db: AppDb,
  sessionId: string,
): Promise<DesignArtifactDetail | null> {
  const artifact = await getArtifactRowBySession(db, sessionId);
  if (!artifact) return null;
  const revision = await getRevision(db, artifact.id, artifact.currentRevision);
  if (!revision) return null;
  return { artifact, content: revision.content };
}

export async function getRevision(
  db: AppDb,
  artifactId: string,
  revision: string,
): Promise<DesignArtifactRevisionRow | null> {
  const rows = await db
    .select()
    .from(designArtifactRevisions)
    .where(
      and(
        eq(designArtifactRevisions.artifactId, artifactId),
        eq(designArtifactRevisions.revision, revision),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Revision metadata, newest first. Content excluded — a listing that
 * ships every revision's full bytes scales with edit count. */
export async function listRevisions(
  db: AppDb,
  artifactId: string,
): Promise<Array<Omit<DesignArtifactRevisionRow, "content">>> {
  const rows = await db
    .select({
      id: designArtifactRevisions.id,
      artifactId: designArtifactRevisions.artifactId,
      revision: designArtifactRevisions.revision,
      turnId: designArtifactRevisions.turnId,
      summary: designArtifactRevisions.summary,
      createdAt: designArtifactRevisions.createdAt,
    })
    .from(designArtifactRevisions)
    .where(eq(designArtifactRevisions.artifactId, artifactId))
    .orderBy(desc(designArtifactRevisions.createdAt));
  // createdAt ties (same-ms writes) resolve by revision number.
  return rows.sort((a, b) =>
    a.createdAt === b.createdAt ? revNum(b.revision) - revNum(a.revision) : b.createdAt - a.createdAt,
  );
}

function revNum(revision: string): number {
  return Number(/^r-(\d+)$/.exec(revision)?.[1] ?? 0);
}

export interface UpdateArtifactOpts {
  sessionId: string;
  /** The full next document. Callers apply patches before calling in. */
  content: string;
  summary: string;
  /** The agent turn (queue item id) that made the edit. Null for
   * UI-driven mutations (revert) and the r-001 seed — that null is what
   * lets the next agent edit detect a change it did not see. */
  turnId?: string | null;
  /** Optimistic-concurrency fence: reject when the artifact has moved past
   * this revision (durable-submission parentRevision fence). */
  parentRevision?: string;
  /** Session template, used to normalize a missing valet-design header. */
  template?: string | null;
}

export interface UpdateArtifactResult {
  artifact: DesignArtifactRow;
  revision: DesignArtifactRevisionRow;
  /** Write-boundary normalizations, surfaced to the caller (never silent). */
  notes: string[];
  /** Set when the revision REPLACED was authored outside an agent turn
   * (a UI revert) — the agent's memory of the artifact was stale. */
  interleaved?: { revision: string; summary: string };
}

/**
 * Normalize a document that is merely MISSING the valet-design header —
 * the one mistake every fresh agent makes once. Injection is explicit
 * (returned as a note, and visible in the stored artifact), never silent;
 * a PRESENT header with an unknown version still rejects.
 */
export function ensureHeader(content: string, template: string | null | undefined): { content: string; injected: boolean } {
  if (parseHeader(content) !== null) return { content, injected: false };
  const tag = `<meta name="valet-design" content="v=${DC_HTML_VERSION}; template=${template ?? "document"}">`;
  const headMatch = /<head[^>]*>/i.exec(content);
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length;
    return { content: `${content.slice(0, at)}\n  ${tag}${content.slice(at)}`, injected: true };
  }
  const htmlMatch = /<html[^>]*>/i.exec(content);
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length;
    return { content: `${content.slice(0, at)}\n<head>${tag}</head>${content.slice(at)}`, injected: true };
  }
  return { content: `<head>${tag}</head>\n${content}`, injected: true };
}

export async function updateArtifact(db: AppDb, opts: UpdateArtifactOpts): Promise<UpdateArtifactResult> {
  if (Buffer.byteLength(opts.content) > MAX_ARTIFACT_BYTES) {
    throw new ValidationError(
      `Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte cap. Remove embedded images or split the document.`,
    );
  }
  const notes: string[] = [];
  const ensured = ensureHeader(opts.content, opts.template);
  if (ensured.injected) {
    notes.push(
      `added the missing <meta name="valet-design"> header (v=${DC_HTML_VERSION}; template=${opts.template ?? "document"}) — include it next time`,
    );
  }
  const validation = validateDcHtml(ensured.content);
  if (!validation.ok) {
    throw new ValidationError(`Not a valid .dc.html document: ${validation.errors.join(" ")}`);
  }

  const { html } = applyVdids(ensured.content);

  return db.transaction(async (tx) => {
    // Row lock: two concurrent writers (a UI revert racing a design_edit,
    // neither carrying parentRevision) would otherwise both read the same
    // currentRevision, compute the same next id, and the loser would hit
    // the (artifact_id, revision) unique index as a raw 500. FOR UPDATE
    // serializes them; the second writer re-reads the moved pointer.
    const rows = await tx
      .select()
      .from(designArtifacts)
      .where(eq(designArtifacts.sessionId, opts.sessionId))
      .limit(1)
      .for("update");
    const artifact = rows[0];
    if (!artifact) throw new NotFoundError("design artifact");
    if (opts.parentRevision && opts.parentRevision !== artifact.currentRevision) {
      throw new ValidationError(
        `Stale edit: the artifact is at ${artifact.currentRevision}, not ${opts.parentRevision}. Re-read the artifact and re-apply the change.`,
      );
    }

    // Staleness detection: when an AGENT edit (turnId set) replaces a
    // revision that no agent turn wrote (a UI revert), the agent could not
    // have seen it — surface that so the tool can tell the model instead
    // of letting it act on a stale memory of the document.
    let interleaved: { revision: string; summary: string } | undefined;
    if (opts.turnId && artifact.currentRevision !== "r-001") {
      const prev = await getRevision(tx, artifact.id, artifact.currentRevision);
      if (prev && prev.turnId === null) {
        interleaved = { revision: prev.revision, summary: prev.summary };
      }
    }

    const revisionId = nextRevisionId(artifact.currentRevision);
    const now = Date.now();
    const [revision] = await tx
      .insert(designArtifactRevisions)
      .values({
        id: newId("dr"),
        artifactId: artifact.id,
        revision: revisionId,
        turnId: opts.turnId ?? null,
        summary: opts.summary,
        content: html,
        createdAt: now,
      })
      .returning();
    const [updated] = await tx
      .update(designArtifacts)
      .set({ currentRevision: revisionId, sizeBytes: Buffer.byteLength(html), updatedAt: now })
      .where(eq(designArtifacts.id, artifact.id))
      .returning();
    return { artifact: updated, revision, notes, ...(interleaved ? { interleaved } : {}) };
  });
}

/** Revert = append a new revision with the target revision's content. */
export async function revertToRevision(
  db: AppDb,
  opts: { sessionId: string; revision: string },
): Promise<UpdateArtifactResult> {
  const artifact = await getArtifactRowBySession(db, opts.sessionId);
  if (!artifact) throw new NotFoundError("design artifact");
  const target = await getRevision(db, artifact.id, opts.revision);
  if (!target) throw new NotFoundError(`revision ${opts.revision}`);
  return updateArtifact(db, {
    sessionId: opts.sessionId,
    content: target.content,
    summary: `Reverted to ${opts.revision}`,
  });
}

// ── Comments ────────────────────────────────────────────────────────

export async function addComment(
  db: AppDb,
  opts: { sessionId: string; vdid: string; body: string; authorUserId: string },
): Promise<DesignCommentRow> {
  const artifact = await getArtifactRowBySession(db, opts.sessionId);
  if (!artifact) throw new NotFoundError("design artifact");
  if (!opts.body.trim()) throw new ValidationError("Comment body is empty. Write the comment text.");
  const [row] = await db
    .insert(designComments)
    .values({
      id: newId("dc"),
      artifactId: artifact.id,
      revision: artifact.currentRevision,
      vdid: opts.vdid,
      body: opts.body,
      authorUserId: opts.authorUserId,
      createdAt: Date.now(),
    })
    .returning();
  return row;
}

export async function listComments(db: AppDb, sessionId: string): Promise<DesignCommentRow[]> {
  const artifact = await getArtifactRowBySession(db, sessionId);
  if (!artifact) return [];
  return db
    .select()
    .from(designComments)
    .where(eq(designComments.artifactId, artifact.id))
    .orderBy(desc(designComments.createdAt));
}

export async function resolveComment(
  db: AppDb,
  opts: { sessionId: string; commentId: string },
): Promise<DesignCommentRow> {
  const artifact = await getArtifactRowBySession(db, opts.sessionId);
  if (!artifact) throw new NotFoundError("design artifact");
  const [row] = await db
    .update(designComments)
    .set({ resolvedAt: Date.now() })
    .where(
      and(eq(designComments.id, opts.commentId), eq(designComments.artifactId, artifact.id)),
    )
    .returning();
  if (!row) throw new NotFoundError(`comment ${opts.commentId}`);
  return row;
}

// ── Event emission ──────────────────────────────────────────────────

export type DesignEventName =
  | "design.artifact.created"
  | "design.artifact.updated"
  | "design.artifact.imported"
  | "design.comment.added"
  | "design.comment.resolved"
  | "design.export.started"
  | "design.export.completed"
  | "design.export.failed"
  | "design.handoff.spawned";

/**
 * Push a design event onto the session's durable event stream. The WS
 * bridge (`engine/bridge.ts`) maps `host_event` to the matching
 * `design.*` wire frame; connected canvases refetch over REST. Best-effort:
 * a failed append never fails the mutation that preceded it.
 */
export async function emitDesignEvent(
  stream: EventStream,
  opts: {
    sessionId: string;
    name: DesignEventName;
    payload: Record<string, unknown>;
    eventKey: string;
    /** The submission whose turn produced this event. Retention prunes
     * durable events by settled queueItemId, so tool-driven mutations MUST
     * pass it or their rows outlive every retention window. UI-driven
     * mutations (revert, comments) have no turn and stay unpruned — a
     * human-scale volume. */
    queueItemId?: string;
  },
): Promise<void> {
  try {
    await stream.append(
      {
        sessionId: opts.sessionId,
        ...(opts.queueItemId ? { queueItemId: opts.queueItemId } : {}),
        event: { type: "host_event", name: opts.name, payload: opts.payload },
        timestamp: Date.now(),
      },
      `design:${opts.eventKey}`,
    );
  } catch (err) {
    console.error(
      `design: event append failed for ${opts.name} on ${opts.sessionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
