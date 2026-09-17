/**
 * Puts a file that arrived over a chat channel into the session sandbox.
 *
 * Chat platforms carry more than images. A message can hold a PDF, a
 * spreadsheet or an archive, and until now the channel host kept only the
 * images: everything else became the note "[attachment skipped: unsupported
 * media type …]". The agent then had no way to reach the file, because the
 * only other handle — the Slack `fetch_file` action — reports that a
 * non-image, non-text file cannot be viewed.
 *
 * The upload route (`POST /api/sessions/:id/files`) already solved the same
 * problem for files a person uploads in the web client: write the bytes into
 * `/workspace/uploads/`, extract a markdown sidecar beside a PDF, and hand
 * the agent a `type: "file"` attachment. The engine renders that attachment
 * as a system-authored note naming the path and the sidecar, so the agent
 * reads the file with its ordinary tools instead of receiving raw bytes.
 * Channel files take the same route through this service.
 *
 * A PDF is the case that matters most, because the agent cannot read one
 * from disk on its own: no sandbox image carries a PDF text tool, and the
 * native extractor ships beside the api bundle. Extraction therefore happens
 * here, and only here.
 */

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Sandbox } from "@valet/engine";
import { resolveUploadDest } from "./path-validation.js";
import { extractPdf, pdfStubMarkdown } from "./pdf-extract.js";

/** The `type: "file"` half of `PromptAttachment`, minus the discriminant. */
export interface IngestedChannelFile {
  path: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  /** Set only when a PDF yielded real text. */
  markdownPath?: string;
  name: string;
}

export interface IngestChannelFileOptions {
  sandbox: Sandbox;
  /** The platform-supplied filename. Untrusted: it never leaves /workspace/uploads/. */
  name: string;
  mimeType: string;
  data: Uint8Array;
}

/**
 * Write one channel file into the sandbox and describe it for the prompt.
 *
 * Returns `null` when the file cannot be stored, so the caller can fall back
 * to its "skipped" note. Losing a whole message because one attachment
 * failed to write would be worse than losing the attachment.
 */
export async function ingestChannelFile(
  opts: IngestChannelFileOptions,
): Promise<IngestedChannelFile | null> {
  const { sandbox, mimeType, data } = opts;

  // The name comes from a chat platform, so treat it as hostile. Passing no
  // `dest` makes `resolveUploadDest` take the basename and pin the result
  // under /workspace/uploads/.
  const dest = resolveUploadDest(fallbackName(opts.name));
  if (!dest.ok) return null;
  const uploadPath = dest.path;
  const filename = uploadPath.slice(uploadPath.lastIndexOf("/") + 1);

  try {
    const parentDir = dirname(uploadPath);
    if (parentDir && parentDir !== "/workspace") {
      await sandbox.mkdir(parentDir);
    }
    await sandbox.writeBinary(uploadPath, data);
  } catch (err) {
    console.error(
      `[channel-file-ingest] failed to write ${uploadPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  const file: IngestedChannelFile = {
    path: uploadPath,
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
    mimeType,
    name: filename,
  };

  if (isPdf(mimeType, data)) {
    file.markdownPath = await writePdfSidecar(sandbox, uploadPath, data);
  }

  return file;
}

/**
 * Extract the PDF's text next to it and return the sidecar path, or
 * `undefined` when there is no text to read.
 *
 * A scanned PDF gets a stub sidecar, matching the upload route: the file is
 * on disk and the stub says why it is empty, which reads better than a
 * sidecar that silently does not exist. Only a real extraction is reported
 * back, because `markdownPath` is what tells the agent there is text to read.
 */
async function writePdfSidecar(
  sandbox: Sandbox,
  uploadPath: string,
  data: Uint8Array,
): Promise<string | undefined> {
  const sidecarPath = `${uploadPath}.md`;
  try {
    const result = await extractPdf(data);
    await sandbox.writeBinary(
      sidecarPath,
      new TextEncoder().encode(result.markdown ?? pdfStubMarkdown()),
    );
    return result.markdown ? sidecarPath : undefined;
  } catch (err) {
    // The PDF itself is already stored. A failed extraction — a malformed
    // file, or a missing native binary — degrades to "no sidecar", the same
    // way the upload route's `extract=auto` does.
    console.error(
      `[channel-file-ingest] PDF extraction failed for ${uploadPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** `%PDF-` magic bytes, so a mislabeled upload still routes correctly. */
function isPdf(mimeType: string, data: Uint8Array): boolean {
  if (mimeType === "application/pdf") return true;
  return (
    data.length >= 5 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  );
}

/** Some platforms omit the filename. `resolveUploadDest` needs a basename. */
function fallbackName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed === "" ? "attachment" : trimmed;
}
