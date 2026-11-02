import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Type } from "typebox";
import type { BlobStore, ThreadFile, ThreadFileStore, ToolDef } from "@valet/engine";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@valet/shared";

import { and, count, eq, sum } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { generatedFiles, orgs } from "../schema/index.js";

export const GENERATED_FILE_LIMITS = { bytes: 1024 * 1024 * 1024, files: 1000 };
type FileScope = { orgId: string; sessionId: string; threadId: string };
const scopeFilter = (scope: FileScope) => and(eq(generatedFiles.orgId, scope.orgId), eq(generatedFiles.sessionId, scope.sessionId), eq(generatedFiles.threadId, scope.threadId));
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MIME_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pdf": "application/pdf",
};

export function generatedFileKey(orgId: string, sessionId: string, threadId: string, fileId: string): string {
  const scope = [orgId, sessionId, threadId].map(value => Buffer.from(value).toString("hex")).join("/");
  return `generated-files/${scope}/${fileId}`;
}

/** Accept only the host's configured origin, never a model argument or request header. */
export function generatedFileOrigin(configuredUrl?: string): string | undefined {
  if (!configuredUrl) return undefined;
  try {
    const url = new URL(configuredUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch { return undefined; }
}

function describeFile(scope: FileScope, row: { id: string; name: string; mimeType: string; bytes: number }, origin?: string): ThreadFile {
  const webUrl = `/api/sessions/${encodeURIComponent(scope.sessionId)}/threads/${encodeURIComponent(scope.threadId)}/files/${row.id}`;
  return { id: row.id, name: row.name, mimeType: row.mimeType, bytes: row.bytes, url: `${origin ?? ""}${webUrl}`, webUrl };
}

type SaveResult = { ok: true; file: ThreadFile } | { ok: false; error: string };

/**
 * Snapshot bytes into the thread's durable downloads. A refusal (a full org
 * store, an unfinished duplicate) returns its corrective text; a storage
 * failure throws after it releases the reservation.
 */
async function saveGeneratedFile(db: AppDb, blobs: BlobStore, scope: FileScope, file: { name: string; mimeType: string; data: Uint8Array }, origin: string | undefined, limits: typeof GENERATED_FILE_LIMITS): Promise<SaveResult> {
  const { name, mimeType, data } = file;
  const digest = createHash("sha256").update(name).update("\0").update(data).digest("hex");
  const reservation = await db.transaction(async tx => {
    // Every host locks the same durable org row before checking either cap.
    const [org] = await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, scope.orgId)).for("update");
    if (!org) throw new Error("Missing organization");
    const [existing] = await tx.select().from(generatedFiles).where(and(scopeFilter(scope), eq(generatedFiles.digest, digest))).limit(1);
    if (existing) return { row: existing, duplicate: true };
    const [usage] = await tx.select({ files: count(), bytes: sum(generatedFiles.bytes) }).from(generatedFiles).where(eq(generatedFiles.orgId, scope.orgId));
    if (usage.files >= limits.files || Number(usage.bytes ?? 0) + data.byteLength > limits.bytes) return null;
    const [row] = await tx.insert(generatedFiles).values({ id: randomUUID(), orgId: scope.orgId, sessionId: scope.sessionId, threadId: scope.threadId, digest, name, mimeType, bytes: data.byteLength, createdAt: Date.now() }).returning();
    return { row, duplicate: false };
  });
  if (!reservation) return { ok: false, error: "Generated file storage is full. Ask an administrator to remove retained files before attaching another file." };
  const { row, duplicate } = reservation;
  if (duplicate && !row.ready) return { ok: false, error: "This file has an unfinished storage reservation. Retry later. If it persists, ask an administrator to inspect the reservation." };
  const key = generatedFileKey(scope.orgId, scope.sessionId, scope.threadId, row.id);
  if (!duplicate) {
    try {
      await blobs.put(key, data, { contentType: mimeType });
      await db.update(generatedFiles).set({ ready: true }).where(and(scopeFilter(scope), eq(generatedFiles.id, row.id)));
    } catch (error) {
      // A failed put can leave partial bytes. Release capacity only after deletion.
      // Crashes or failed deletion retain a charged reservation for manual cleanup.
      await blobs.delete(key);
      await db.delete(generatedFiles).where(and(scopeFilter(scope), eq(generatedFiles.id, row.id)));
      throw error;
    }
  }
  return { ok: true, file: describeFile(scope, row, origin) };
}

export function buildFileAttachTool(db: AppDb, blobs: BlobStore, configuredPublicUrl?: string, limits = GENERATED_FILE_LIMITS): ToolDef {
  const origin = generatedFileOrigin(configuredPublicUrl);
  const parameters = Type.Object({ path: Type.String({ description: "Absolute path of the completed file in the sandbox." }) });
  const tool: ToolDef<typeof parameters> = {
    name: "file_attach",
    description: "Attach a completed sandbox file to this chat as a durable, private download. Return the download URL verbatim in a Markdown link. This does not publish a page or share with the organization.",
    parameters,
    execute: async ({ path }, ctx) => {
      if (!posix.isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) {
        return { text: "Invalid file path. Supply an absolute sandbox file path.", ok: false };
      }
      const name = posix.basename(path);
      if (!name || name.length > 255) return { text: "Invalid filename. Use a filename of at most 255 characters.", ok: false };
      try {
        const stat = await ctx.sandbox.stat(path);
        if (!stat.isFile) return { text: "The path is not a file. Supply a completed file path.", ok: false };
        if (stat.size > DEFAULT_MAX_UPLOAD_BYTES) return { text: "The file exceeds the attachment size limit. Reduce its size and retry.", ok: false };
        const bytes = await ctx.sandbox.readBinary(path);
        if (bytes.byteLength > DEFAULT_MAX_UPLOAD_BYTES) return { text: "The file exceeds the attachment size limit. Reduce its size and retry.", ok: false };
        const mimeType = MIME_TYPES[posix.extname(name).toLowerCase()] ?? "application/octet-stream";
        const saved = await saveGeneratedFile(db, blobs, ctx, { name, mimeType, data: bytes }, origin, limits);
        if (!saved.ok) return { text: saved.error, ok: false };
        return { text: JSON.stringify({ ...saved.file, ...(!origin ? { deliveryNote: "This relative URL works in the Valet web app. For channel delivery, configure VALET_PUBLIC_URL and attach the file again." } : {}) }), ok: true };
      } catch {
        return { text: "Could not attach the file. Verify the file exists and retry file_attach.", ok: false };
      }
    },
  };
  return tool;
}

/**
 * The host's `ToolContext.threadFiles` seam over the same store and caps as
 * `file_attach`, so plugin actions can save downloads and read them back.
 */
export function generatedFileStore(db: AppDb, blobs: BlobStore, configuredPublicUrl?: string, limits = GENERATED_FILE_LIMITS) {
  const origin = generatedFileOrigin(configuredPublicUrl);
  return (scope: FileScope): ThreadFileStore => ({
    save: async ({ name, mimeType, data }) => {
      if (!name || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) {
        throw new Error("Invalid filename. Use a filename of at most 255 characters, without slashes or control characters.");
      }
      if (data.byteLength > DEFAULT_MAX_UPLOAD_BYTES) {
        throw new Error(`The file is ${data.byteLength} bytes, over the ${DEFAULT_MAX_UPLOAD_BYTES}-byte download limit. Reduce its size and retry.`);
      }
      const saved = await saveGeneratedFile(db, blobs, scope, { name, mimeType, data }, origin, limits);
      if (!saved.ok) throw new Error(saved.error);
      return saved.file;
    },
    read: async (id) => {
      if (!FILE_ID.test(id)) return null;
      const [row] = await db.select().from(generatedFiles).where(and(scopeFilter(scope), eq(generatedFiles.id, id), eq(generatedFiles.ready, true))).limit(1);
      if (!row) return null;
      const blob = await blobs.get(generatedFileKey(scope.orgId, scope.sessionId, scope.threadId, id));
      if (!blob) return null;
      const data = new Uint8Array(await new Response(blob.data).arrayBuffer());
      return { ...describeFile(scope, row, origin), data };
    },
  });
}

export async function readGeneratedFile(db: AppDb, blobs: BlobStore, scope: FileScope, id: string) {
  const [metadata] = await db.select().from(generatedFiles).where(and(scopeFilter(scope), eq(generatedFiles.id, id), eq(generatedFiles.ready, true))).limit(1);
  if (!metadata) return null;
  const file = await blobs.get(generatedFileKey(scope.orgId, scope.sessionId, scope.threadId, id));
  if (!file) return null;
  return { data: file.data, name: metadata.name, mimeType: metadata.mimeType, bytes: metadata.bytes };
}
