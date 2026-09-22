import { describe, expect, it } from "vitest";
import {
  extractDownloadedPdf,
  isPdfDocument,
  normalizeDocumentMime,
  readResponseBytes,
} from "../src/document-text.js";

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

describe("document text helpers", () => {
  it("normalizes MIME parameters and case before routing", () => {
    expect(normalizeDocumentMime("Application/PDF; charset=binary")).toBe("application/pdf");
    expect(isPdfDocument({ mimeType: "Application/PDF; charset=binary" })).toBe(true);
  });

  it("identifies a PDF header for a generic MIME type", () => {
    expect(isPdfDocument({ mimeType: "application/octet-stream", data: pdfBytes })).toBe(true);
    expect(isPdfDocument({ mimeType: "application/octet-stream", data: new Uint8Array() })).toBe(false);
  });

  it("cancels an oversized declared response and releases its reader", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = await readResponseBytes(
      new Response(body, { headers: { "content-length": "4" } }),
      3,
    );

    expect(result).toEqual({ ok: false, size: 4 });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("stops an unknown-length response at the byte cap", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readResponseBytes(new Response(body), 3);
    expect(result).toEqual({ ok: false, size: 4 });
    expect(cancelled).toBe(true);
  });

  it("returns a size failure when unknown-length cancellation fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        return Promise.reject(new Error("connection reset"));
      },
    });

    await expect(readResponseBytes(new Response(body), 3)).resolves.toEqual({ ok: false, size: 4 });
    expect(body.locked).toBe(false);
  });

  it("extracts a downloaded PDF", async () => {
    const result = await extractDownloadedPdf({
      data: pdfBytes,
      name: "nda.pdf",
      extractDocument: async () => ({ markdown: "# NDA" }),
    });
    expect(result).toEqual({ ok: true, content: "# NDA" });
  });

  it("names a missing extractor", async () => {
    const result = await extractDownloadedPdf({ data: pdfBytes, name: "nda.pdf" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("PDF text extraction is not available");
  });
});
