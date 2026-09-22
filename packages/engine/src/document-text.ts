/** Shared MIME checks and bounded document-response reads. */

/** Matches the channel transport's document budget. */
export const MAX_PDF_DOCUMENT_BYTES = 25 * 1024 * 1024;

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

/** A declared PDF is a PDF. A generic type needs the `%PDF-` header. */
export function isPdfDocument(input: { mimeType?: string; data?: Uint8Array }): boolean {
  const mime = normalizeDocumentMime(input.mimeType);
  return mime === "application/pdf" || ((mime === "" || mime === "application/octet-stream") && input.data !== undefined && hasPdfHeader(input.data));
}

export type BoundedResponseBytes =
  | { ok: true; data: Uint8Array }
  | { ok: false; size: number };

/**
 * Read a response body without accumulating more than `maxBytes`. A declared
 * size avoids a read. An unknown or false size is checked for every chunk.
 */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<BoundedResponseBytes> {
  if (!response.body) return { ok: true, data: new Uint8Array() };
  const reader = response.body.getReader();
  const cancel = async () => {
    try {
      await reader.cancel();
    } catch {
      // The result remains a bounded-size failure when cancellation fails.
    }
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancel();
      return { ok: false, size: declared };
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await cancel();
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
    return { ok: true, content: extracted.markdown };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not read ${name}: ${detail}` };
  }
}
