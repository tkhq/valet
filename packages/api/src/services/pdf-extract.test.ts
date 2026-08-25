import { describe, it, expect } from "vitest";
import { pdfStubMarkdown } from "./pdf-extract.js";

describe("pdfStubMarkdown", () => {
  it("returns the expected stub text", () => {
    const stub = pdfStubMarkdown();
    expect(stub).toContain("PDF has no extractable text layer");
    expect(stub).toContain("OCR is not enabled");
  });

  it("returns a valid markdown string", () => {
    const stub = pdfStubMarkdown();
    expect(typeof stub).toBe("string");
    expect(stub.length).toBeGreaterThan(0);
  });
});

// Note: extractPdf tests are integration-level and require the actual
// @firecrawl/pdf-inspector native binary. Unit tests for the function itself
// would mock processPdf, but that requires careful module mocking. The route
// integration tests cover the full PDF extraction path with a fake sandbox.;

describe("pdfStubMarkdown", () => {
  it("returns the expected stub text", () => {
    const stub = pdfStubMarkdown();
    expect(stub).toContain("PDF has no extractable text layer");
    expect(stub).toContain("OCR is not enabled");
  });
});
