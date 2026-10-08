import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Type } from "typebox";
import type { BlobStore, ToolDef } from "@valet/engine";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@valet/shared";

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

export function buildFileAttachTool(blobs: BlobStore, configuredPublicUrl?: string): ToolDef {
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
        const id = randomUUID();
        const key = generatedFileKey(ctx.orgId, ctx.sessionId, ctx.threadId, id);
        await blobs.put(key, bytes, { contentType: mimeType });
        try {
          await blobs.put(`${key}.json`, new TextEncoder().encode(JSON.stringify({ name, mimeType, bytes: bytes.byteLength })), { contentType: "application/json" });
        } catch (error) {
          await blobs.delete(key);
          throw error;
        }
        const url = `${origin ?? ""}/api/sessions/${encodeURIComponent(ctx.sessionId)}/threads/${encodeURIComponent(ctx.threadId)}/files/${id}`;
        return { text: JSON.stringify({ name, mimeType, bytes: bytes.byteLength, url, ...(!origin ? { deliveryNote: "This relative URL works in the Valet web app. For channel delivery, configure VALET_PUBLIC_URL and attach the file again." } : {}) }), ok: true };
      } catch {
        return { text: "Could not attach the file. Verify the file exists and retry file_attach.", ok: false };
      }
    },
  };
  return tool;
}

export async function readGeneratedFile(blobs: BlobStore, key: string) {
  const metadata = await blobs.get(`${key}.json`);
  if (!metadata) return null;
  const value: unknown = await new Response(metadata.data).json();
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string" ||
      !("mimeType" in value) || typeof value.mimeType !== "string" || !("bytes" in value) || typeof value.bytes !== "number") return null;
  const file = await blobs.get(key);
  if (!file) return null;
  return { data: file.data, name: value.name, mimeType: value.mimeType, bytes: value.bytes };
}
