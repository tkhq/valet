import { describe, expect, it } from "vitest";
import { extractDocx } from "./docx-extract.js";
import { extractDocumentText } from "./pdf-extract.js";

import { zip } from "./docx-test-fixture.js";

const xml = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

describe("DOCX extraction", () => {
  it("extracts paragraphs, table cells, headers, notes, and comments locally", async () => {
    const data = zip({
      "word/document.xml": xml(paragraph("A &amp; B") + '<w:tbl><w:tr><w:tc>' + paragraph("Cell 1") + '</w:tc><w:tc>' + paragraph("Cell 2") + '</w:tc></w:tr></w:tbl>'),
      "word/header1.xml": xml(paragraph("Header")),
      "word/footnotes.xml": xml(paragraph("Footnote")),
      "word/endnotes.xml": xml(paragraph("Endnote")),
      "word/comments.xml": xml(paragraph("Comment")),
    }, true);
    const result = await extractDocumentText({ data, mimeType: "application/octet-stream", name: "contract.DOCX" });
    expect(result?.markdown).toContain("A & B");
    expect(result?.markdown).toContain("Cell 1\tCell 2");
    for (const text of ["Header", "Footnote", "Endnote", "Comment"]) expect(result?.markdown).toContain(text);
  });
  it("rejects malformed ZIPs and ZIPs without the Word document part", async () => {
    await expect(extractDocx(Buffer.from("bad"))).rejects.toThrow();
    await expect(extractDocx(zip({ "other.xml": xml("x") }))).rejects.toThrow(/document.xml/);
  });
  it("rejects doctypes and unknown entities", async () => {
    for (const body of ['<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + xml(paragraph("&secret;")), xml(paragraph("&secret;"))]) {
      await expect(extractDocx(zip({ "word/document.xml": body }))).rejects.toThrow();
    }
  });
  it("rejects malformed XML and unsupported embedded content instead of silently omitting it", async () => {
    for (const body of [xml("<w:p>"), xml('<w:altChunk/>')]) {
      await expect(extractDocx(zip({ "word/document.xml": body }))).rejects.toThrow();
    }
  });
  it("rejects tracked revisions instead of mixing deleted contract clauses into text", async () => {
    for (const revision of ['<w:del><w:r><w:delText>Deleted obligation</w:delText></w:r></w:del>', '<w:ins><w:r><w:t>Proposed obligation</w:t></w:r></w:ins>', '<w:pPrChange/>']) {
      await expect(extractDocx(zip({ "word/document.xml": xml(paragraph("Agreed clause") + revision) }))).rejects.toThrow(/Accept or reject the revisions/);
    }
  });
  it("rejects output beyond the text budget instead of truncating", async () => {
    await expect(extractDocx(zip({ "word/document.xml": xml(paragraph("a".repeat(1_000_001))) }))).rejects.toThrow(/limit/);
  });
  it("rejects an oversized expanded part before opening its stream", async () => {
    const data = zip({ "word/document.xml": xml(paragraph("tiny")) });
    const central = data.indexOf(Buffer.from([80, 75, 1, 2]));
    data.writeUInt16LE(8, central + 10); // Deflated entry can declare a different expanded size.
    data.writeUInt32LE(9 * 1024 * 1024, central + 24);
    await expect(extractDocx(data)).rejects.toThrow(/limit/);
  });
  it("marks images as unextracted and rejects non-Word XML", async () => {
    expect((await extractDocx(zip({ "word/document.xml": xml(paragraph("Text") + '<w:drawing/>') })))?.markdown).toContain("visual content was not extracted");
    await expect(extractDocx(zip({ "word/document.xml": "<document>pretend contract</document>" }))).rejects.toThrow(/namespace/);
  });
  it("honors cancellation before opening an archive", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(extractDocx(zip({ "word/document.xml": xml(paragraph("x")) }), controller.signal)).rejects.toThrow(/abort/i);
  });
});
