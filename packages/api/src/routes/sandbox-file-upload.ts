/**
 * `POST /api/sessions/:id/files` — sandbox file upload route.
 *
 * Multipart form-data upload with a size cap (the body is buffered in
 * memory up to the cap, then written to the sandbox in one call),
 * magic-byte detection for archives and PDFs, and attachment ref minting.
 * Auth: session-owner only (404 for non-owner, never 403). Sandbox-token
 * requests 404 (not in SANDBOX_ALLOWED_PATH_PREFIXES).
 *
 * Fields per spec:
 * - file (required)
 * - dest (optional, default /workspace/uploads/<name>)
 * - extract (optional, auto|true|false, default auto)
 * - overwrite (optional, boolean, default false)
 *
 * Response 200 includes exact wire shape from spec: path, bytes, sha256,
 * attachmentRef, plus optional extracted[] for zips and pdf{} for PDFs.
 *
 * Error responses per spec: 400, 404, 409 (two variants), 413, 415, 422.
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { AppEnv } from "../env.js";
import { resolveUploadDest } from "../services/path-validation.js";
import { extractPdf, pdfStubMarkdown } from "../services/pdf-extract.js";
import { extractZip } from "../services/archive-extract.js";
import { getAttachmentRefStore, type AttachmentInfo } from "../services/attachment-refs.js";
import { loadOwnedSession } from "./messages.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type {
  PostSessionFileUploadResponse,
  PostSessionFileUploadPdfInfo,
} from "../wire/types.js";

export const fileUploadRouter = new Hono<AppEnv>();

const MAX_UPLOAD_BYTES = parseInt(process.env.VALET_MAX_UPLOAD_BYTES ?? "52428800", 10); // 50 MB default

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
    return c.json(
      {
        error: "sandbox not ready",
        corrective: "The sandbox is waking. Retry in a few seconds.",
        wake: true,
      },
      409,
    );
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

  // Read the file, counting size and computing the hash. Nothing is written
  // to the sandbox until the whole body passed the cap — an error here must
  // NOT touch `uploadPath` (with overwrite=true a pre-existing file lives
  // there).
  const sha256 = createHash("sha256");

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
  } catch {
    return c.json(
      { error: "Upload stream error", corrective: "Try uploading again." },
      400,
    );
  }

  const totalBytes: Uint8Array = Buffer.concat(chunks);
  const sha256Hex = sha256.digest("hex");

  try {
    await sandbox.writeBinary(uploadPath, totalBytes);
  } catch (err) {
    return c.json(
      { error: "Failed to write file to sandbox", corrective: "Try uploading again." },
      500,
    );
  }

  // extract=true on a file that is neither a zip nor a PDF: nothing to
  // extract. The file is already written; the client asked for an
  // extraction that cannot happen, so report it.
  if (forceExtract && detectedType === "other") {
    return c.json(
      { error: "This file cannot be extracted", corrective: "Set extract=false or omit it." },
      415,
    );
  }

  const attachmentRefStore = getAttachmentRefStore();

  // Determine MIME type
  const mimeType = fileField.type || "application/octet-stream";

  // Handle PDF extraction
  let pdfInfo: PostSessionFileUploadPdfInfo | undefined;
  let markdownPath: string | undefined;

  if (detectedType === "pdf" && shouldExtract) {
    try {
      const result = await extractPdf(totalBytes);

      pdfInfo = {
        type: result.type,
        confidence: result.confidence,
        pages: result.pages,
        pagesNeedingOcr: result.pagesNeedingOcr,
        needsOcr: result.needsOcr,
      };

      // Always write the sidecar: real markdown when the PDF has text, a
      // one-line stub otherwise (scanned / no extractable text). Only a
      // real sidecar is reported via markdownPath.
      const sidecarPath = `${uploadPath}.md`;
      await sandbox.writeBinary(
        sidecarPath,
        new TextEncoder().encode(result.markdown ?? pdfStubMarkdown()),
      );
      if (result.markdown) {
        markdownPath = sidecarPath;
        pdfInfo.markdownPath = sidecarPath;
      }
    } catch (err) {
      if (forceExtract) {
        // The client explicitly asked for extraction — fail loudly.
        return c.json(
          {
            error: `PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`,
            corrective: "Retry with extract=false to upload the PDF without a markdown sidecar.",
          },
          422,
        );
      }
      // extract=auto: the upload itself succeeded; degrade to no sidecar.
      console.error("PDF extraction error:", err);
    }
  }

  // Handle ZIP extraction
  let extracted: string[] | undefined;

  if (detectedType === "zip" && shouldExtract) {
    const extractRoot = `${dirname(uploadPath)}/${basename(uploadPath, ".zip")}/`;

    const zipResult = await extractZip({
      sandbox,
      archivePath: uploadPath,
      zipBytes: totalBytes,
      extractRoot,
      maxTotalUncompressed: Math.min(MAX_UPLOAD_BYTES * 10, 500 * 1024 * 1024),
      maxEntries: 10000,
    });

    if (!zipResult.ok) {
      // extractZip already deleted everything it wrote; the raw zip stays.
      return c.json(
        { error: zipResult.error, corrective: zipResult.corrective },
        422,
      );
    }

    extracted = zipResult.extracted;
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
