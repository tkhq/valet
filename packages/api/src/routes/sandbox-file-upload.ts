/**
 * `POST /api/sessions/:id/files` — sandbox file upload route.
 *
 * Multipart form-data upload with a size cap, magic-byte detection for
 * archives and PDFs, and attachment ref minting. Auth: session-owner only
 * (404 for non-owner, never 403). Sandbox-token requests 404 (not in
 * SANDBOX_ALLOWED_PATH_PREFIXES).
 *
 * Memory: a request with a Content-Length above the cap is rejected before
 * the body is parsed. A body without a Content-Length (chunked) is buffered
 * by the multipart parser before the cap re-check on the file — the cap
 * bounds well-formed clients, not adversarial chunked bodies.
 *
 * Fields per spec (docs/specs/2026-08-24-sandbox-file-upload-design.md):
 * - file (required)
 * - dest (optional, default /workspace/uploads/<name>)
 * - extract (optional, auto|true|false, default auto)
 * - overwrite (optional, boolean, default false)
 *
 * Response 200 includes exact wire shape from spec: path, bytes, sha256,
 * attachmentRef, plus optional extracted[]/extractedTo for zips and pdf{}
 * for PDFs.
 *
 * Error responses per spec: 400, 404, 409 (three variants), 413, 415, 422.
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@valet/shared";
import type { Sandbox } from "@valet/engine";
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

const MAX_UPLOAD_BYTES = parseInt(
  process.env.VALET_MAX_UPLOAD_BYTES ?? String(DEFAULT_MAX_UPLOAD_BYTES),
  10,
);

// Slack for multipart framing (boundaries, part headers, small text fields)
// on top of the file cap when pre-checking Content-Length.
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/**
 * Magic-byte detection for PDF (%PDF-) and ZIP (PK\x03\x04).
 */
function detectFileType(firstBytes: Uint8Array): "pdf" | "zip" | "other" {
  if (firstBytes.length >= 5 && firstBytes[0] === 0x25 && firstBytes[1] === 0x50 && firstBytes[2] === 0x44 && firstBytes[3] === 0x46 && firstBytes[4] === 0x2d) {
    return "pdf";
  }
  if (firstBytes.length >= 4 && firstBytes[0] === 0x50 && firstBytes[1] === 0x4b && firstBytes[2] === 0x03 && firstBytes[3] === 0x04) {
    return "zip";
  }
  return "other";
}

/**
 * Extract root for an uploaded zip. Strips a case-insensitive ".zip" suffix;
 * when the name has no such suffix (type detection is magic-byte based, so
 * any name can hold zip content) the root is "<path>.extracted/" — the root
 * must never collide with the archive file itself. The CLI prints the
 * server-computed value from the response; this rule lives only here.
 */
export function zipExtractRoot(uploadPath: string): string {
  const stripped = uploadPath.replace(/\.zip$/i, "");
  return `${stripped !== uploadPath ? stripped : `${uploadPath}.extracted`}/`;
}

/**
 * True for errors that mean "path does not exist" on some provider:
 * node:fs ENOENT (docker/local) or the kubernetes stat probe's exit 2
 * (PodFileOpError). Anything else — transport failure, exec timeout — is
 * NOT a not-found and must not bypass the overwrite guard.
 */
function isNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; name?: unknown; exitCode?: unknown; message?: unknown };
  return (
    e.code === "ENOENT" ||
    (e.name === "PodFileOpError" && e.exitCode === 2) ||
    // Providers that proxy a remote fs (gateway, virtual) may carry only
    // the message text.
    (typeof e.message === "string" && e.message.startsWith("ENOENT"))
  );
}

/** stat() that returns null for a missing path and rethrows everything else. */
async function statIfExists(
  sandbox: Sandbox,
  path: string,
): Promise<{ isFile: boolean; isDirectory: boolean; size: number } | null> {
  try {
    return await sandbox.stat(path);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

fileUploadRouter.post("/:id/files", async (c) => {
  const row = await loadOwnedSession(c);
  if (!row) return c.json({ error: "session not found" }, 404);

  const { engineHost, db } = c.var.providers;

  // Reject oversized requests before the multipart parser buffers the body.
  const contentLength = Number(c.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES) {
    return c.json(
      {
        error: `File exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload cap`,
        corrective: "Reduce the file, or raise VALET_MAX_UPLOAD_BYTES on the server.",
      },
      413,
    );
  }

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

  // Extract optional fields. formData.get returns string | File | null —
  // narrow instead of casting; a File in a text field reads as absent.
  const destField = formData.get("dest");
  const dest = typeof destField === "string" && destField.length > 0 ? destField : undefined;
  const extractField = formData.get("extract");
  const extractStr = (typeof extractField === "string" && extractField.length > 0 ? extractField : "auto").toLowerCase();
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

  // Size cap. The multipart parser already buffered the body, so this bounds
  // what proceeds to the sandbox, not parser memory (see the header comment).
  if (fileField.size > MAX_UPLOAD_BYTES) {
    return c.json(
      {
        error: `File exceeds ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload cap`,
        corrective: "Reduce the file, or raise VALET_MAX_UPLOAD_BYTES on the server.",
      },
      413,
    );
  }

  // Read the (already buffered) bytes once; hash and type-detect from the
  // same buffer. Nothing is written to the sandbox until every pre-write
  // check passed — an error here must NOT touch `uploadPath` (with
  // overwrite=true a pre-existing file lives there).
  let totalBytes: Uint8Array;
  try {
    totalBytes = new Uint8Array(await fileField.arrayBuffer());
  } catch {
    return c.json(
      { error: "Upload stream error", corrective: "Try uploading again." },
      400,
    );
  }

  const fileBytes = totalBytes.length;
  const sha256Hex = createHash("sha256").update(totalBytes).digest("hex");
  const detectedType = detectFileType(totalBytes.subarray(0, 5));

  // extract=true on a file that is neither a zip nor a PDF: nothing to
  // extract. Checked before the write, so the failed request leaves no
  // file behind and a retry with extract=false does not hit the 409
  // destination-exists check.
  if (forceExtract && detectedType === "other") {
    return c.json(
      { error: "This file cannot be extracted", corrective: "Set extract=false or omit it." },
      415,
    );
  }

  // Load engine session and check sandbox readiness
  let engineSession;
  try {
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

  // Overwrite protection: check every path this request will write before
  // writing any of them. The PDF sidecar counts — overwrite=false must not
  // clobber a pre-existing `<dest>.md` either. A stat failure that is not a
  // clean not-found (transport error, exec timeout) must NOT read as "does
  // not exist": that would silently bypass the 409 contract.
  const sidecarPath = `${uploadPath}.md`;
  let skipSidecar = false;
  if (!overwrite) {
    try {
      if ((await statIfExists(sandbox, uploadPath)) !== null) {
        return c.json(
          { error: "File already exists", corrective: "Retry with overwrite=true, or choose a different dest." },
          409,
        );
      }
      if (detectedType === "pdf" && shouldExtract && (await statIfExists(sandbox, sidecarPath)) !== null) {
        if (forceExtract) {
          return c.json(
            {
              error: `A file already exists at ${sidecarPath}`,
              corrective: "Retry with overwrite=true, or choose a different dest.",
            },
            409,
          );
        }
        // extract=auto: upload the PDF, keep the existing sidecar untouched.
        skipSidecar = true;
      }
    } catch {
      return c.json(
        { error: "Could not verify the destination", corrective: "Try uploading again." },
        500,
      );
    }
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

  try {
    await sandbox.writeBinary(uploadPath, totalBytes);
  } catch (err) {
    return c.json(
      { error: "Failed to write file to sandbox", corrective: "Try uploading again." },
      500,
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

      // Write the sidecar: real markdown when the PDF has text, a one-line
      // stub otherwise (scanned / no extractable text). Only a real sidecar
      // is reported via markdownPath. Skipped when overwrite=false found an
      // existing file at the sidecar path.
      if (!skipSidecar) {
        await sandbox.writeBinary(
          sidecarPath,
          new TextEncoder().encode(result.markdown ?? pdfStubMarkdown()),
        );
        if (result.markdown) {
          markdownPath = sidecarPath;
          pdfInfo.markdownPath = sidecarPath;
        }
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
  let extractedTo: string | undefined;

  if (detectedType === "zip" && shouldExtract) {
    const extractRoot = zipExtractRoot(uploadPath);

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

    // A zip can legally extract to nothing (all entries symlinks, or only
    // empty directories). Report an extraction only when files landed —
    // the note the agent reads must not point at content that is not there.
    if (zipResult.extracted.length > 0) {
      extracted = zipResult.extracted;
      extractedTo = extractRoot;
    }
  }

  // Mint attachment ref
  const attachmentInfo: Omit<AttachmentInfo, "ref" | "sessionId" | "createdAt"> = {
    path: uploadPath,
    bytes: fileBytes,
    sha256: sha256Hex,
    mimeType: mimeType !== "application/octet-stream" ? mimeType : undefined,
    markdownPath,
    extractedFiles: extracted,
    extractedTo,
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

  if (extracted) {
    response.extracted = extracted;
    response.extractedTo = extractedTo;
  }

  if (pdfInfo) {
    response.pdf = pdfInfo;
  }

  return c.json(response, 200);
});
