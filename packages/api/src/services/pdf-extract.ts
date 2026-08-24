/**
 * PDF extraction via @firecrawl/pdf-inspector.
 *
 * Routing rules from the design spec's "PDF handling" section:
 * - TextBased → markdown populated, needsOcr: false.
 * - Mixed with confidence >= 0.5 → same as TextBased.
 * - Mixed with confidence < 0.5, Scanned, ImageBased → markdown: null, needsOcr: true.
 *
 * The native binaries required by @firecrawl/pdf-inspector must be available
 * for linux-x64 and linux-arm64. If a target platform's binary is missing,
 * boot fails loudly at API startup — this is a real dependency, not best-effort.
 */

import { processPdfAsync } from "@firecrawl/pdf-inspector";

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
  // Convert Uint8Array to Buffer for processPdfAsync
  const buffer = Buffer.from(bytes);
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
