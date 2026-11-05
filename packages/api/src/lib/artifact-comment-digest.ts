/**
 * The agent's view of an artifact's comments, shared by the `artifact_comments`
 * engine tool and the MCP `list_artifact_comments` tool. Both read
 * `GET /api/artifacts/:ref/comment-threads` and hand the model this shape.
 */
import type { ArtifactCommentThreadWire, ArtifactCommentWire, ArtifactCommentsResponse } from "../wire/types.js";

/** The route's `:ref` from what a model is likely to hold: the page link
 * (`…/a/<token>`), the bare token, or the artifact id. */
export function artifactCommentRef(input: string): string {
  const trimmed = input.trim();
  const match = /\/a\/([^/?#\s]+)/.exec(trimmed);
  return match ? decodeURIComponent(match[1]!) : trimmed;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function parseComment(v: unknown): ArtifactCommentWire | null {
  if (!isRecord(v)) return null;
  const id = str(v.id), body = str(v.body), authorUserId = str(v.authorUserId);
  const version = num(v.version), createdAt = num(v.createdAt);
  if (id === null || body === null || authorUserId === null || version === null || createdAt === null) return null;
  return {
    id, body, authorUserId, version, createdAt,
    vdid: str(v.vdid),
    anchorLabel: str(v.anchorLabel),
    parentId: str(v.parentId),
    authorName: str(v.authorName) ?? authorUserId,
    sentToSession: str(v.sentToSession),
    resolvedAt: num(v.resolvedAt),
  };
}

/** Narrows a fetched `ArtifactCommentsResponse`; null when the shape is off.
 * A malformed reply is dropped rather than failing the whole read. */
export function parseArtifactComments(body: unknown): ArtifactCommentsResponse | null {
  if (!isRecord(body) || !isRecord(body.artifact) || !Array.isArray(body.threads)) return null;
  const a = body.artifact;
  const id = str(a.id), title = str(a.title), url = str(a.url), version = num(a.version);
  if (id === null || title === null || url === null || version === null) return null;
  const threads: ArtifactCommentThreadWire[] = [];
  for (const raw of body.threads) {
    const root = parseComment(raw);
    if (!root || !isRecord(raw)) continue;
    const replies = Array.isArray(raw.replies) ? raw.replies.map(parseComment).filter((r): r is ArtifactCommentWire => r !== null) : [];
    threads.push({ ...root, replies });
  }
  return { artifact: { id, title, url, version }, threads };
}

function anchorOf(comment: ArtifactCommentWire): string {
  if (comment.vdid === null) return "page";
  return comment.anchorLabel ? `element "${comment.anchorLabel}"` : "an element (no label recorded)";
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function artifactCommentDigest(res: ArtifactCommentsResponse) {
  return {
    artifact_id: res.artifact.id,
    title: res.artifact.title,
    url: res.artifact.url,
    current_version: res.artifact.version,
    threads: res.threads.map((t) => ({
      comment_id: t.id,
      author: t.authorName,
      created_at: iso(t.createdAt),
      on: anchorOf(t),
      page_version: t.version,
      status: t.resolvedAt === null ? "open" : "resolved",
      ...(t.resolvedAt !== null ? { resolved_at: iso(t.resolvedAt) } : {}),
      sent_to_agent: t.sentToSession !== null,
      body: t.body,
      replies: t.replies.map((r) => ({ author: r.authorName, created_at: iso(r.createdAt), body: r.body })),
    })),
    ...(res.threads.length === 0 ? { note: "No comments on this page yet." } : {}),
  };
}
