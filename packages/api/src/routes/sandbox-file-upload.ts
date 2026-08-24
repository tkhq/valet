/**
 * `POST /api/sessions/:id/files` — sandbox file upload route.
 *
 * Multipart form-data upload with streaming size cap, magic-byte detection for
 * archives and PDFs, and attachment ref minting. Auth: session-owner only (404
 * for non-owner, never 403). Sandbox-token requests 404 (not in SANDBOX_ALLOWED_PATH_PREFIXES).
 *
 * Fields per spec:
 * - file (required, streamed)
 * - dest (optional, default /workspace/uploads/<name>)
 * - extract (optional, auto|true|false, default auto)
 * - overwrite (optional, boolean, default false)
 *
 * Response 200 includes exact wire shape from spec: path, bytes, sha256,
 * attachmentRef, plus optional extracted[] for zips and pdf{} for PDFs.
 *
 * Error responses per spec: 400, 404, 409 (two variants), 413, 415, 422.
 */

import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { basename, dirname } from "node:path";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import { resolveUploadDest } from "../services/path-validation.js";
import { extractPdf, pdfStubMarkdown } from "../services/pdf-extract.js";
import { extractZip } from "../services/archive-extract.js";
import { getAttachmentRefStore, type AttachmentInfo } from "../services/attachment-refs.js";
import { canViewSession } from "../services/session-access.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type {
  PostSessionFileUploadResponse,
  PostSessionFileUploadPdfInfo,
} from "../wire/types.js";

export const fileUploadRouter = new Hono<AppEnv>();

/**
 * Load owned session — same pattern as messages.ts but for write-level auth.
 * Non-owner → 404, never 403.
 */
async function loadOwnedSession(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, id)).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, userId))) return null;
  return row;
}

const MAX_UPLOAD_BYTES = parseInt(process.env.VALET_MAX_UPLOAD_BYTES ?? "52428800", 10); // 50 MB default

/**
 * Size-counting transform stream. Aborts when exceeding the cap.
 */
function createSizeCounter(maxBytes: number): {
  transform: Transform;
  getBytes: () => number;
} {
  let count = 0;

  const transform = new Transform({
    transform(chunk: Buffer | Uint8Array, encoding, callback) {
      count += Buffer.byteLength(chunk);
      if (count > maxBytes) {
        callback(new FileSizeExceededError(maxBytes));
      } else {
        callback(null, chunk);
      }
    },
  });

  return { transform, getBytes: () => count };
}

class FileSizeExceededError extends Error {
  constructor(maxBytes: number) {
    super(`File exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB upload cap`);
    this.name = "FileSizeExceededError";
  }
}

/**
 * Magic-byte detection for PDF and ZIP.
 */
function detectFileType(
  firstBytes: Uint8Array,
): { type: "pdf" | "zip" | "other"; magicBytes: Uint8Array } {
  // PDF: %PDF-
  if (firstBytes.length >= 5 && firstBytes[0] === 0x25 && firstBytes[1] === 0x50 && firstBytes[2] === 0x44 && firstBytes[3] === 0x46 && firstBytes[4] === 0x2d) {
    return { type: "pdf", magicBytes: firstBytes };
  }

  // ZIP: PK\x03\x04
  if (firstBytes.length >= 4 && firstBytes[0] === 0x50 && firstBytes[1] === 0x4b && firstBytes[2] === 0x03 && firstBytes[3] === 0x04) {
    return { type: "zip", magicBytes: firstBytes };
  }

  return { type: "other", magicBytes: firstBytes };
}

fileUploadRouter.post("/:id/files", async (c) => {
  const row = await loadOwnedSession(c);
  if (!row) return c.json({ error: "session not found" }, 404);

  const { engineHost, db } = c.var.providers;

  // Parse multipart form
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch (err) {
    return c.json(
      { error: "Failed to parse multipart form-data", corrective: "Ensure the request is valid multipart/form-data." },
      400,
    );
  }

  // Extract file field (required)
  const fileField = formData.get("file");
  if (!fileField || !(fileField instanceof File)) {
    return c.json({ error: "Missing required field: file", corrective: "Include a file in the multipart form." }, 400);
  }

  const filename = fileField.name;
  if (!filename) {
    return c.json({ error: "File must have a name", corrective: "The file field must include a filename." }, 400);
  }

  // Extract optional fields
  const dest = (formData.get("dest") as string) || undefined;
  const extractStr = ((formData.get("extract") as string) || "auto").toLowerCase();
  const overwrite = formData.get("overwrite") === "true" || formData.get("overwrite") === "1";

  // Validate extract value
  if (!["auto", "true", "false"].includes(extractStr)) {
    return c.json(
      { error: `Unknown extract value: ${extractStr}`, corrective: "Use auto, true, or false." },
      400,
    );
  }

  const shouldExtract = extractStr === "true" || extractStr === "auto";
  const forceExtract = extractStr === "true";

  // Resolve destination path
  const pathResult = resolveUploadDest(filename, dest);
  if (!pathResult.ok) {
    return c.json({ error: pathResult.error, corrective: pathResult.corrective }, 400);
  }

  const uploadPath = pathResult.path;

  // Load engine session and check sandbox readiness
  let engineSession;
  try {
    const { db } = c.var.providers;
    engineSession = await engineHost.sessionFor(row.id, await loadSessionMeta(db, row));
  } catch {
    return c.json(
      { error: "Failed to load session", corrective: "Try again in a moment." },
      500,
    );
  }

  const sandbox = engineSession.attachment.current();
  if (!sandbox) {
    engineSession.attachment.warm();
    return c.json({ error: "sandbox not ready", wake: true }, 409);
  }

  // Check if dest already exists (unless overwrite=true)
  try {
    await sandbox.stat(uploadPath);
    // File exists
    if (!overwrite) {
      return c.json(
        { error: "File already exists", corrective: "Retry with overwrite=true, or choose a different dest." },
        409,
      );
    }
  } catch {
    // File does not exist, which is what we want
  }

  // Create parent directory
  try {
    const parentDir = dirname(uploadPath);
    if (parentDir && parentDir !== "/workspace") {
      await sandbox.mkdir(parentDir);
    }
  } catch (err) {
    return c.json(
      { error: "Failed to create parent directory", corrective: "Check permissions and try again." },
      500,
    );
  }

  // Stream the file, counting size and computing hash
  const sha256 = createHash("sha256");
  const { transform: sizeCounter, getBytes } = createSizeCounter(MAX_UPLOAD_BYTES);

  let fileBytes = 0;
  let detectedType: "pdf" | "zip" | "other" = "other";
  const chunks: Uint8Array[] = [];

  try {
    const stream = fileField.stream();
    const reader = stream.getReader();

    let firstChunkRead = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = new Uint8Array(value);

      // Detect type from first bytes
      if (!firstChunkRead) {
        firstChunkRead = true;
        const detection = detectFileType(chunk);
        detectedType = detection.type;
      }

      fileBytes += chunk.length;
      sha256.update(chunk);

      // Check size cap
      if (fileBytes > MAX_UPLOAD_BYTES) {
        // Delete partial file
        try {
          await sandbox.rm(uploadPath);
        } catch {
          // Ignore
        }
        return c.json(
          {
            error: `File exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload cap`,
            corrective: "Reduce the file, or raise VALET_MAX_UPLOAD_BYTES on the server.",
          },
          413,
        );
      }

      chunks.push(chunk);
    }
  } catch (err) {
    // Delete partial file on stream error
    try {
      await sandbox.rm(uploadPath);
    } catch {
      // Ignore
    }
    return c.json(
      { error: "Upload stream error", corrective: "Try uploading again." },
      400,
    );
  }

  // Combine chunks and write to sandbox
  const totalBytes = new Uint8Array(fileBytes);
  let offset = 0;
  for (const chunk of chunks) {
    totalBytes.set(chunk, offset);
    offset += chunk.length;
  }

  const sha256Hex = sha256.update(totalBytes).digest("hex");

  try {
    await sandbox.writeBinary(uploadPath, totalBytes);
  } catch (err) {
    return c.json(
      { error: "Failed to write file to sandbox", corrective: "Try uploading again." },
      500,
    );
  }

  // Mint attachment ref
  const attachmentRefStore = getAttachmentRefStore();

  // Determine MIME type
  const mimeType = fileField.type || "application/octet-stream";

  // Handle PDF extraction
  let pdfInfo: PostSessionFileUploadPdfInfo | undefined;
  let markdownPath: string | undefined;

  if (detectedType === "pdf" && shouldExtract) {
    try {
      const result = extractPdf(totalBytes);

      pdfInfo = {
        type: result.type,
        confidence: result.confidence,
        pages: result.pages,
        pagesNeedingOcr: result.pagesNeedingOcr,
        needsOcr: result.needsOcr,
      };

      // Write markdown sidecar if we have extractable text
      if (result.markdown) {
        markdownPath = `${uploadPath}.md`;
        await sandbox.writeBinary(markdownPath, new TextEncoder().encode(result.markdown));
        pdfInfo.markdownPath = markdownPath;
      } else if (!result.needsOcr) {
        // If we should have text but don't, write stub
        markdownPath = `${uploadPath}.md`;
        await sandbox.writeBinary(markdownPath, new TextEncoder().encode(pdfStubMarkdown()));
        // Don't set markdownPath in response when we wrote a stub
      } else {
        // Needs OCR, write stub
        markdownPath = `${uploadPath}.md`;
        await sandbox.writeBinary(markdownPath, new TextEncoder().encode(pdfStubMarkdown()));
        // Don't set markdownPath in response
      }
    } catch (err) {
      console.error("PDF extraction error:", err);
      // Continue without PDF info on error
    }
  } else if (detectedType === "pdf" && forceExtract) {
    // extract=true but PDF extraction failed or was disabled
    return c.json(
      { error: "This file cannot be extracted", corrective: "Set extract=false or omit it." },
      415,
    );
  }

  // Handle ZIP extraction
  let extracted: string[] | undefined;

  if (detectedType === "zip" && shouldExtract) {
    const extractRoot = `${dirname(uploadPath)}/${basename(uploadPath, ".zip")}/`;

    const zipResult = await extractZip({
      sandbox,
      archivePath: uploadPath,
      extractRoot,
      maxTotalUncompressed: Math.min(MAX_UPLOAD_BYTES * 10, 500 * 1024 * 1024),
      maxEntries: 10000,
    });

    if (!zipResult.ok) {
      // Delete partial files
      for (const file of zipResult.partialFiles) {
        try {
          await sandbox.rm(file);
        } catch {
          // Ignore
        }
      }
      return c.json(
        { error: zipResult.error, corrective: zipResult.corrective },
        422,
      );
    }

    extracted = zipResult.extracted;
  } else if (detectedType === "zip" && forceExtract) {
    // extract=true but ZIP extraction failed
    return c.json(
      { error: "This file cannot be extracted", corrective: "Set extract=false or omit it." },
      415,
    );
  }

  // Mint attachment ref
  const attachmentInfo: Omit<AttachmentInfo, "ref" | "sessionId" | "createdAt"> = {
    path: uploadPath,
    bytes: fileBytes,
    sha256: sha256Hex,
    mimeType: mimeType !== "application/octet-stream" ? mimeType : undefined,
    markdownPath,
    extractedFiles: extracted,
    extractedTo: extracted ? `${dirname(uploadPath)}/${basename(uploadPath, ".zip")}/` : undefined,
    name: filename,
  };

  const attachmentRef = attachmentRefStore.mint(row.id, attachmentInfo);

  // Build response
  const response: PostSessionFileUploadResponse = {
    path: uploadPath,
    bytes: fileBytes,
    sha256: sha256Hex,
    attachmentRef,
  };

  if (extracted && extracted.length > 0) {
    response.extracted = extracted;
  }

  if (pdfInfo) {
    response.pdf = pdfInfo;
  }

  return c.json(response, 200);
});
