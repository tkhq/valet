import { describe, expect, it } from "vitest";
import {
  extractDownloadedPdf,
  isPdfDocument,
  normalizeDocumentMime,
  readResponseBytes,
  readPdfCandidateResponse,
} from "../src/document-text.js";

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

describe("document text helpers", () => {
  it("normalizes MIME parameters and case before routing", () => {
    expect(normalizeDocumentMime("Application/PDF; charset=binary")).toBe("application/pdf");
    expect(isPdfDocument(pdfBytes)).toBe(true);
    expect(isPdfDocument(new TextEncoder().encode("<html>"))).toBe(false);
  });

  it("identifies a PDF header for a generic MIME type", () => {
    expect(isPdfDocument(pdfBytes)).toBe(true);
    expect(isPdfDocument(new Uint8Array())).toBe(false);
  });

  it("rejects an oversized declared response with no body", async () => {
    const result = await readResponseBytes(
      new Response(null, { headers: { "content-length": "4" } }),
      3,
    );
    expect(result).toEqual({ ok: false, size: 4 });
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

  it("returns before a cancellation promise settles", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });

    await expect(readResponseBytes(new Response(body), 3)).resolves.toEqual({ ok: false, size: 4 });
    expect(body.locked).toBe(false);
  });

  it("stops a generic non-PDF after its prefix", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x50, 0x4b, 3, 4, 0]));
      },
      cancel() { cancelled = true; },
    });

    await expect(readPdfCandidateResponse(new Response(body), 3)).resolves.toEqual({ kind: "not-pdf" });
    expect(cancelled).toBe(true);
  });

  it("bounds a generic PDF after its prefix", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("%PDF-"));
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readPdfCandidateResponse(new Response(body), 5)).resolves.toEqual({ kind: "oversize", size: 9 });
    expect(cancelled).toBe(true);
  });

  it("stops a stalled response when the action signal aborts", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const controller = new AbortController();
    const result = readResponseBytes(new Response(body), 3, controller.signal);
    controller.abort(new Error("action timed out"));

    await expect(result).rejects.toThrow("action timed out");
    expect(cancelled).toBe(true);
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

  it("does not start extraction when the action signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("action timed out"));
    let extracted = false;

    await expect(extractDownloadedPdf({
      data: pdfBytes,
      extractDocument: async () => { extracted = true; return { markdown: "must not extract" }; },
      signal: controller.signal,
    })).resolves.toMatchObject({ ok: false, error: expect.stringContaining("action timed out") });
    expect(extracted).toBe(false);
  });

  it("limits extracted document output", async () => {
    const result = await extractDownloadedPdf({
      data: pdfBytes,
      name: "large.pdf",
      extractDocument: async () => ({ markdown: "x".repeat(1_000_001) }),
    });

    expect(result).toEqual({
      ok: false,
      error: "large.pdf has more extracted text than this action can return. Ask for a smaller PDF or specific pages.",
    });
  });

  it("names a missing extractor", async () => {
    const result = await extractDownloadedPdf({ data: pdfBytes, name: "nda.pdf" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("PDF text extraction is not available");
  });
});
