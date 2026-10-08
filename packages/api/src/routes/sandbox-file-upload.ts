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
 * Error responses per spec: 400, 404, 408, 409, 413, 415, 422, 500.
 */

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DEFAULT_MAX_UPLOAD_BYTES } from "@valet/shared";
import {
  SANDBOX_READY_TIMEOUT_MS,
  SandboxPreparationError,
  SandboxStartupError,
  SandboxUnavailableError,
  WorkspaceProvisioningError,
  type AttachmentState,
  type Sandbox,
} from "@valet/engine";
import type { AppEnv } from "../env.js";
import { resolveUploadDest } from "../services/path-validation.js";
import { extractPdf, pdfStubMarkdown } from "../services/pdf-extract.js";
import { extractZip } from "../services/archive-extract.js";
import { getAttachmentRefStore, type AttachmentInfo } from "../services/attachment-refs.js";
import { canAccessSessionResources } from "../services/session-access.js";
import { loadOwnedSession } from "./messages.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import type {
  PostSessionFileUploadResponse,
  PostSessionFileUploadPdfInfo,
} from "../wire/types.js";
import { readGeneratedFile } from "../services/generated-files.js";
import { threadsVisibleTo, viewerOf } from "./_thread-access.js";
import { workflowSessionOwner } from "../workflows/session-owner.js";
import { parseWorkflowSessionId } from "../workflows/engine-deps.js";
import { isAuthorizedForOwner } from "../workflows/service.js";
import { runEventVisible, runOriginVisible } from "../services/thread-access.js";

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
/** Whether this upload unpacks (zip) or converts (PDF sidecar) the file. */
function shouldExtractUpload(type: ReturnType<typeof detectFileType>, shouldExtract: boolean): boolean {
  return shouldExtract && (type === "zip" || type === "pdf");
}

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

type SandboxReadyError = { status: 408 | 409 | 500; body: { error: string; corrective: string; wake?: true } };

export function sandboxReadyError(err: unknown, state: AttachmentState, aborted: boolean): SandboxReadyError {
  if (aborted) return { status: 408, body: { error: "upload canceled", corrective: "Upload the file again." } };
  if (err instanceof WorkspaceProvisioningError && state === "provisioning") {
    return {
      status: 409,
      body: { error: "sandbox not ready", corrective: "The sandbox is still waking. Retry in a few seconds.", wake: true },
    };
  }
  if (err instanceof WorkspaceProvisioningError) {
    return { status: 409, body: { error: "sandbox did not start", corrective: "Retry the upload to start it again." } };
  }
  if (err instanceof SandboxStartupError || err instanceof SandboxPreparationError) {
    return {
      status: 500,
      body: { error: "sandbox failed to start", corrective: "Retry the upload. If this repeats, fix the sandbox configuration." },
    };
  }
  if (state === "released") {
    return { status: 409, body: { error: "sandbox was released", corrective: "Start a new session, then upload the file again." } };
  }
  if (err instanceof SandboxUnavailableError) {
    return { status: 409, body: { error: "sandbox is unavailable", corrective: "Start a new session, then upload the file again." } };
  }
  return { status: 500, body: { error: "Failed to prepare sandbox", corrective: "Try uploading again." } };
}

fileUploadRouter.post("/:id/files", async (c) => {
  const row = await loadOwnedSession(c);
  if (!row || !await canAccessSessionResources(c.var.providers, row, c.var.principal)) return c.json({ error: "session not found" }, 404);

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

  const attachment = engineSession.attachment;
  const requestSignal = c.req.raw.signal;
  if (attachment.state === "ready" && !attachment.current()) {
    return c.json(
      { error: "sandbox handle is missing", corrective: "Reload the session. If this repeats, contact support." },
      500,
    );
  }
  if (attachment.state === "released") {
    return c.json(
      { error: "sandbox was released", corrective: "Start a new session, then upload the file again." },
      409,
    );
  }

  let sandbox: Sandbox;
  try {
    ({ sandbox } = await attachment.ensureReady({
      timeoutMs: SANDBOX_READY_TIMEOUT_MS,
      signal: requestSignal,
    }));
  } catch (err) {
    const failure = sandboxReadyError(err, attachment.state, requestSignal.aborted);
    return c.json(failure.body, failure.status);
  }
  if (requestSignal.aborted) return c.json({ error: "upload canceled", corrective: "Upload the file again." }, 408);

  // Overwrite protection: check every path this request will write before
  // writing any of them. The PDF sidecar counts — overwrite=false must not
  // clobber a pre-existing `<dest>.md` either. A stat failure that is not a
  // clean not-found (transport error, exec timeout) must NOT read as "does
  // not exist": that would silently bypass the 409 contract.
  const sidecarPath = `${uploadPath}.md`;
  let skipSidecar = false;
  // A person who attaches the same file twice sends the same bytes to the
  // same path. That is already uploaded, so the request succeeds with a new
  // ref and writes nothing. Only plain files qualify: an extracting upload
  // would skip the extraction a caller may expect to run again.
  let alreadyUploaded = false;
  if (!overwrite) {
    try {
      const existing = await statIfExists(sandbox, uploadPath);
      if (existing !== null && existing.isFile && existing.size === fileBytes && !shouldExtractUpload(detectedType, shouldExtract)) {
        const stored = await sandbox.readBinary(uploadPath);
        alreadyUploaded = createHash("sha256").update(stored).digest("hex") === sha256Hex;
      }
      if (existing !== null && !alreadyUploaded) {
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
    if (!alreadyUploaded && parentDir && parentDir !== "/workspace") {
      await sandbox.mkdir(parentDir);
    }
  } catch (err) {
    return c.json(
      { error: "Failed to create parent directory", corrective: "Check permissions and try again." },
      500,
    );
  }

  try {
    if (!alreadyUploaded) await sandbox.writeBinary(uploadPath, totalBytes);
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

/**
 * `GET /api/sessions/:id/threads/:threadId/files?path=` downloads a file that
 * a person attached to a message in the thread. A caller who can read the
 * thread's messages can read its attachments. The path must match a file
 * attachment of that thread, so the route never serves other sandbox files.
 */
fileUploadRouter.get("/:id/threads/:threadId/files", async (c) => {
  const row = await loadOwnedSession(c);
  if (!row || !await canAccessSessionResources(c.var.providers, row, c.var.principal)) return c.json({ error: "session not found" }, 404);
  const { engineHost, db } = c.var.providers;
  const engineSession = await engineHost.sessionFor(row.id, await loadSessionMeta(db, row));
  await engineSession.ensureDefaultThread();
  const found = engineSession.threadById(c.req.param("threadId"));
  const thread = found && await threadsVisibleTo(c, row)(found.key) ? found : undefined;
  const path = c.req.query("path");
  const entries = thread && path ? await thread.readEntries() : [];
  const file = entries
    .flatMap((entry) => (entry.type === "message" ? entry.attachments ?? [] : []))
    .find((att) => att.type === "file" && att.path === path);
  if (!file || file.type !== "file") {
    return c.json({ error: "file not found", corrective: "Attach the file to the thread again." }, 404);
  }

  let bytes: Uint8Array;
  try {
    const { sandbox } = await engineSession.attachment.ensureReady({ timeoutMs: SANDBOX_READY_TIMEOUT_MS, signal: c.req.raw.signal });
    bytes = await sandbox.readBinary(file.path);
  } catch (err) {
    if (isNotFoundError(err)) {
      return c.json({ error: "file is no longer in the sandbox", corrective: "Attach the file to the thread again." }, 404);
    }
    return c.json({ error: "could not read the file from the sandbox", corrective: "Try the download again in a few seconds." }, 409);
  }
  const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return c.body(new Uint8Array(bytes), 200, {
    "content-type": file.mimeType ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"; filename*=UTF-8''${encoded}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  });
});

/** Generated downloads use durable bytes and the current thread access policy. */
fileUploadRouter.get("/:id/threads/:threadId/files/:fileId", async (c) => {
  const { engineStore, blobs, db, workflowStore } = c.var.providers;
  const sessionId = c.req.param("id");
  const ordinary = await loadOwnedSession(c);
  let row: { id: string; orgId: string; ownerType: string };
  if (ordinary) {
    row = ordinary;
    if (!await canAccessSessionResources(c.var.providers, ordinary, c.var.principal)) return c.json({ error: "file not found" }, 404);
  } else {
    // Workflow engine sessions intentionally have no agent_sessions row.
    const owner = await workflowSessionOwner(db, sessionId, c.var.user.orgId);
    if (!owner) return c.json({ error: "file not found" }, 404);
    const run = await workflowStore.getRun(parseWorkflowSessionId(sessionId).runId);
    const viewer = viewerOf(c);
    if (!run || !await isAuthorizedForOwner(db, {
      orgId: c.var.user.orgId,
      userId: c.var.principal?.type === "team" ? `team:${c.var.principal.id}` : c.var.user.id,
      principal: c.var.principal,
    }, { ownerType: owner.type, ownerId: owner.id })
      || !await runOriginVisible(c.var.providers, viewer, { ownerType: owner.type, origin: run.params.origin, actorUserId: run.actorUserId })
      || !await runEventVisible(c.var.providers, viewer, run.params)) return c.json({ error: "file not found" }, 404);
    row = { id: sessionId, orgId: c.var.user.orgId, ownerType: owner.type };
  }
  const thread = await engineStore.getThread(row.id, c.req.param("threadId"));
  const fileId = c.req.param("fileId");
  if (!thread || !await threadsVisibleTo(c, row)(thread.key) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fileId)) {
    return c.json({ error: "file not found" }, 404);
  }
  const file = await readGeneratedFile(db, blobs, { orgId: row.orgId, sessionId: row.id, threadId: thread.id }, fileId);
  if (!file) return c.json({ error: "file not found", corrective: "Ask the assistant to attach the file again." }, 404);
  const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(file.data, { headers: {
    "content-type": file.mimeType,
    "content-length": String(file.bytes),
    "content-disposition": `attachment; filename="${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"; filename*=UTF-8''${encoded}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
  } });
});
