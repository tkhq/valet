/** Shared MIME checks and bounded document-response reads. */

/** Matches the channel transport's document budget. */
export const MAX_PDF_DOCUMENT_BYTES = 25 * 1024 * 1024;

/** Avoid returning unbounded extractor output to an action result. */
export const MAX_EXTRACTED_DOCUMENT_CHARS = 1_000_000;

const TEXT_APPLICATION_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/x-sh",
  "application/sql",
  "application/graphql",
  "application/xhtml+xml",
  "application/ld+json",
  "application/manifest+json",
  "application/vnd.google-apps.script+json",
]);

export function normalizeDocumentMime(mimeType: string | undefined): string {
  return (mimeType ?? "").split(";", 1)[0].trim().toLowerCase();
}

/** True for `text/*` and the application types we already return as text. */
export function isTextDocumentMime(mimeType: string | undefined): boolean {
  const mime = normalizeDocumentMime(mimeType);
  return mime.startsWith("text/") || TEXT_APPLICATION_MIMES.has(mime);
}

function hasPdfHeader(data: Uint8Array): boolean {
  return (
    data.length >= 5 &&
    data[0] === 0x25 &&
    data[1] === 0x50 &&
    data[2] === 0x44 &&
    data[3] === 0x46 &&
    data[4] === 0x2d
  );
}

/** A PDF must start with the `%PDF-` signature, regardless of its MIME type. */
export function isPdfDocument(input: { mimeType?: string; data?: Uint8Array }): boolean {
  return input.data !== undefined && hasPdfHeader(input.data);
}

export type BoundedResponseBytes =
  | { ok: true; data: Uint8Array }
  | { ok: false; size: number };

export type BoundedResponseText =
  | { ok: true; text: string }
  | { ok: false; size: number };

/** Result of prefix-first inspection for a generic PDF candidate. */
export type PdfCandidateResponse =
  | { kind: "pdf"; data: Uint8Array }
  | { kind: "not-pdf" }
  | { kind: "oversize"; size: number };

/** Start cancellation without waiting for a peer that never settles it. */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void reader.cancel().catch(() => {});
}

/**
 * Read a response body without accumulating more than `maxBytes`. A declared
 * size avoids a read. An unknown or false size is checked for every chunk.
 */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<BoundedResponseBytes> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const reader = response.body?.getReader();
    if (reader) {
      try {
        cancelReader(reader);
      } finally {
        reader.releaseLock();
      }
    }
    return { ok: false, size: declared };
  }
  if (!response.body) return { ok: true, data: new Uint8Array() };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        cancelReader(reader);
        return { ok: false, size };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, data };
}

/**
 * Inspect a generic stream prefix before buffering it. Non-PDF bodies are
 * cancelled after their first five bytes. PDF candidates keep the same chunks
 * while they continue through the byte cap.
 */
export async function readPdfCandidateResponse(response: Response, maxBytes: number): Promise<PdfCandidateResponse> {
  if (!response.body) return { kind: "not-pdf" };

  const declared = Number(response.headers.get("content-length"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let prefix = new Uint8Array();
  let pdf: boolean | undefined;
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (pdf === undefined) {
        const needed = 5 - prefix.byteLength;
        const nextPrefix = new Uint8Array(Math.min(5, prefix.byteLength + value.byteLength));
        nextPrefix.set(prefix);
        nextPrefix.set(value.subarray(0, needed), prefix.byteLength);
        prefix = nextPrefix;
        if (prefix.byteLength < 5) {
          chunks.push(value);
          size += value.byteLength;
          continue;
        }
        pdf = hasPdfHeader(prefix);
        if (!pdf) {
          cancelReader(reader);
          return { kind: "not-pdf" };
        }
        if (Number.isFinite(declared) && declared > maxBytes) {
          cancelReader(reader);
          return { kind: "oversize", size: declared };
        }
      }

      size += value.byteLength;
      if (size > maxBytes) {
        cancelReader(reader);
        return { kind: "oversize", size };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (!pdf) return { kind: "not-pdf" };
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "pdf", data };
}

/** Decode a bounded UTF-8 response. The cap applies to bytes, not characters. */
export async function readResponseText(response: Response, maxBytes: number): Promise<BoundedResponseText> {
  const result = await readResponseBytes(response, maxBytes);
  return result.ok ? { ok: true, text: new TextDecoder().decode(result.data) } : result;
}

export type DocumentExtractor = (doc: {
  data: Uint8Array;
  mimeType: string;
  name?: string;
}) => Promise<{ markdown: string } | null>;

export async function extractDownloadedPdf(input: {
  data: Uint8Array;
  name?: string;
  extractDocument?: DocumentExtractor;
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const name = input.name && input.name.length > 0 ? input.name : "document.pdf";
  if (!input.extractDocument) {
    return {
      ok: false,
      error:
        "PDF text extraction is not available on this deployment. Ask the user to paste the relevant text, or to re-share the file so it is attached to the message.",
    };
  }
  try {
    const extracted = await input.extractDocument({ data: input.data, mimeType: "application/pdf", name });
    if (!extracted) {
      return {
        ok: false,
        error: `${name} has no text layer. It is probably a scan or an image-only PDF. Ask the user for a text version, or for the specific figures you need.`,
      };
    }
    if (extracted.markdown.length > MAX_EXTRACTED_DOCUMENT_CHARS) {
      return {
        ok: false,
        error: `${name} has more extracted text than this action can return. Ask for a smaller PDF or specific pages.`,
      };
    }
    return { ok: true, content: extracted.markdown };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not read ${name}: ${detail}` };
  }
}
