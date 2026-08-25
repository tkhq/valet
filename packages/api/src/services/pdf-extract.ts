/**
 * PDF extraction via @firecrawl/pdf-inspector.
 *
 * Routing rules from the design spec's "PDF handling" section:
 * - TextBased → markdown populated, needsOcr: false.
 * - Mixed with confidence >= 0.5 → same as TextBased.
 * - Mixed with confidence < 0.5, Scanned, ImageBased → markdown: null, needsOcr: true.
 *
 * @firecrawl/pdf-inspector ships native .node binaries and stays external to
 * the esbuild bundle. The import is lazy so the bundled api can serve
 * without it: a missing binary fails the first PDF extraction with a clear
 * error (extract=true → 422; extract=auto degrades to no sidecar), not api
 * boot.
 */

type PdfInspector = typeof import("@firecrawl/pdf-inspector");

let inspectorPromise: Promise<PdfInspector> | null = null;

function loadInspector(): Promise<PdfInspector> {
  inspectorPromise ??= import("@firecrawl/pdf-inspector").catch((err) => {
    // A failed load must not stick: the module may be installed later
    // (e.g. the operator adds the platform package) without an api restart.
    inspectorPromise = null;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `PDF extraction is unavailable: @firecrawl/pdf-inspector did not load (${detail}). ` +
        `Install the package beside the api bundle to enable PDF text extraction.`,
    );
  });
  return inspectorPromise;
}

export interface PdfExtractionResult {
  type: "TextBased" | "Scanned" | "ImageBased" | "Mixed";
  confidence: number;
  pages: number;
  pagesNeedingOcr: number[];
  markdown: string | null; // null when we can't extract text
  needsOcr: boolean;
}

/**
 * Extract PDF metadata and text.
 *
 * Returns the result of PDF processing with routing applied per spec decision.
 * Uses `processPdfAsync` so the native parse runs off the api event loop —
 * a large PDF must not stall every other session's request.
 * Throws if the PDF is malformed or the binary is unavailable.
 */
export async function extractPdf(bytes: Uint8Array): Promise<PdfExtractionResult> {
  const { processPdfAsync } = await loadInspector();
  // View, not copy: processPdfAsync only reads the bytes, and the caller's
  // buffer can be 50 MB.
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = await processPdfAsync(buffer);

  // Route on pdfType: TextBased or Mixed with high confidence can write markdown.
  // PdfType is a const string enum; widen to string to narrow into our union.
  const rawType: string = result.pdfType;
  const pdfType: PdfExtractionResult["type"] =
    rawType === "Scanned" || rawType === "ImageBased" || rawType === "Mixed"
      ? rawType
      : "TextBased";
  const canExtractMarkdown =
    pdfType === "TextBased" || (pdfType === "Mixed" && result.confidence >= 0.5);

  return {
    type: pdfType,
    confidence: result.confidence,
    pages: result.pageCount,
    pagesNeedingOcr: result.pagesNeedingOcr,
    markdown: canExtractMarkdown ? (result.markdown ?? null) : null,
    needsOcr: !canExtractMarkdown,
  };
}

/**
 * Stub markdown for PDFs with no extractable text layer.
 * Returned when we can't extract text and OCR is not enabled.
 */
export function pdfStubMarkdown(): string {
  return "> PDF has no extractable text layer. OCR is not enabled in this build.";
}
