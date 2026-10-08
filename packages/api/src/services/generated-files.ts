import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Type } from "typebox";
import type { BlobStore, ToolDef } from "@valet/engine";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@valet/shared";

import { and, count, eq, sum } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { generatedFiles, orgs } from "../schema/index.js";

export const GENERATED_FILE_LIMITS = { bytes: 1024 * 1024 * 1024, files: 1000 };
type FileScope = { orgId: string; sessionId: string; threadId: string };
const scopeFilter = (scope: FileScope) => and(eq(generatedFiles.orgId, scope.orgId), eq(generatedFiles.sessionId, scope.sessionId), eq(generatedFiles.threadId, scope.threadId));

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
        const digest = createHash("sha256").update(name).update("\0").update(bytes).digest("hex");
        const reservation = await db.transaction(async tx => {
          // Every host locks the same durable org row before checking either cap.
          const [org] = await tx.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, ctx.orgId)).for("update");
          if (!org) throw new Error("Missing organization");
          const [existing] = await tx.select().from(generatedFiles).where(and(scopeFilter(ctx), eq(generatedFiles.digest, digest))).limit(1);
          if (existing) return { row: existing, duplicate: true };
          const [usage] = await tx.select({ files: count(), bytes: sum(generatedFiles.bytes) }).from(generatedFiles).where(eq(generatedFiles.orgId, ctx.orgId));
          if (usage.files >= limits.files || Number(usage.bytes ?? 0) + bytes.byteLength > limits.bytes) return null;
          const [row] = await tx.insert(generatedFiles).values({ id: randomUUID(), orgId: ctx.orgId, sessionId: ctx.sessionId, threadId: ctx.threadId, digest, name, mimeType, bytes: bytes.byteLength, createdAt: Date.now() }).returning();
          return { row, duplicate: false };
        });
        if (!reservation) return { text: "Generated file storage is full. Ask an administrator to remove retained files before attaching another file.", ok: false };
        const { row, duplicate } = reservation;
        if (duplicate && !row.ready) return { text: "This file has an unfinished storage reservation. Retry later. If it persists, ask an administrator to inspect the reservation.", ok: false };
        const id = row.id;
        const key = generatedFileKey(ctx.orgId, ctx.sessionId, ctx.threadId, id);
        if (!duplicate) {
          try {
            await blobs.put(key, bytes, { contentType: mimeType });
            await db.update(generatedFiles).set({ ready: true }).where(and(scopeFilter(ctx), eq(generatedFiles.id, id)));
          } catch (error) {
            // A failed put can leave partial bytes. Release capacity only after deletion.
            // Crashes or failed deletion retain a charged reservation for manual cleanup.
            await blobs.delete(key);
            await db.delete(generatedFiles).where(and(scopeFilter(ctx), eq(generatedFiles.id, id)));
            throw error;
          }
        }
        const webUrl = `/api/sessions/${encodeURIComponent(ctx.sessionId)}/threads/${encodeURIComponent(ctx.threadId)}/files/${id}`;
        const url = `${origin ?? ""}${webUrl}`;
        return { text: JSON.stringify({ name, mimeType, bytes: bytes.byteLength, url, webUrl, ...(!origin ? { deliveryNote: "This relative URL works in the Valet web app. For channel delivery, configure VALET_PUBLIC_URL and attach the file again." } : {}) }), ok: true };
      } catch {
        return { text: "Could not attach the file. Verify the file exists and retry file_attach.", ok: false };
      }
    },
  };
  return tool;
}

export async function readGeneratedFile(db: AppDb, blobs: BlobStore, scope: FileScope, id: string) {
  const [metadata] = await db.select().from(generatedFiles).where(and(scopeFilter(scope), eq(generatedFiles.id, id), eq(generatedFiles.ready, true))).limit(1);
  if (!metadata) return null;
  const file = await blobs.get(generatedFileKey(scope.orgId, scope.sessionId, scope.threadId, id));
  if (!file) return null;
  return { data: file.data, name: metadata.name, mimeType: metadata.mimeType, bytes: metadata.bytes };
}
