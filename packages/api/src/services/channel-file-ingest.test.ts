import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { VirtualSandbox } from "@valet/engine";
import { ingestChannelFile } from "./channel-file-ingest.js";

/** A 599-byte one-page PDF whose only text is "Quarterly Revenue Report". */
function textPdf(): Uint8Array {
  return new Uint8Array(readFileSync(new URL("./__fixtures__/sample.pdf", import.meta.url)));
}

describe("ingestChannelFile", () => {
  it("writes a PDF into /workspace/uploads and extracts a markdown sidecar", async () => {
    const sandbox = new VirtualSandbox("sb-1");
    const data = textPdf();

    const result = await ingestChannelFile({
      sandbox,
      name: "report.pdf",
      mimeType: "application/pdf",
      data,
    });

    expect(result).toMatchObject({
      path: "/workspace/uploads/report.pdf",
      bytes: data.byteLength,
      mimeType: "application/pdf",
      markdownPath: "/workspace/uploads/report.pdf.md",
      name: "report.pdf",
    });
    expect(result?.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    // The bytes must land verbatim; the sidecar carries the extracted text.
    expect(await sandbox.readBinary("/workspace/uploads/report.pdf")).toEqual(data);
    expect(await sandbox.readFile("/workspace/uploads/report.pdf.md")).toContain(
      "Quarterly Revenue Report",
    );
  });

  it("writes a non-PDF document without claiming a sidecar", async () => {
    const sandbox = new VirtualSandbox("sb-2");
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

    const result = await ingestChannelFile({
      sandbox,
      name: "bundle.zip",
      mimeType: "application/zip",
      data,
    });

    expect(result).toMatchObject({
      path: "/workspace/uploads/bundle.zip",
      bytes: 7,
      mimeType: "application/zip",
      name: "bundle.zip",
    });
    expect(result?.markdownPath).toBeUndefined();
    expect(await sandbox.readBinary("/workspace/uploads/bundle.zip")).toEqual(data);
  });

  it("still delivers the file when PDF extraction fails", async () => {
    const sandbox = new VirtualSandbox("sb-3");
    // Passes the magic-byte check, but the native parser cannot read it.
    const data = new TextEncoder().encode("%PDF-1.4 not a real pdf");

    const result = await ingestChannelFile({
      sandbox,
      name: "broken.pdf",
      mimeType: "application/pdf",
      data,
    });

    // A PDF we cannot read is still worth handing over — the agent can say
    // what it is and ask for a readable copy. Dropping it is what stranded
    // the user.
    expect(result).toMatchObject({ path: "/workspace/uploads/broken.pdf", name: "broken.pdf" });
    expect(result?.markdownPath).toBeUndefined();
    expect(await sandbox.readBinary("/workspace/uploads/broken.pdf")).toEqual(data);
  });

  it("keeps a channel-supplied name inside the uploads directory", async () => {
    const sandbox = new VirtualSandbox("sb-4");

    const result = await ingestChannelFile({
      sandbox,
      name: "../../etc/passwd",
      mimeType: "application/octet-stream",
      data: new Uint8Array([1]),
    });

    // The filename arrives from a chat platform, so it is attacker-controlled.
    // It must never escape /workspace/uploads/.
    expect(result?.path).toBe("/workspace/uploads/passwd");
  });

  it("returns null when the file cannot be written", async () => {
    const sandbox = new VirtualSandbox("sb-5");
    sandbox.writeBinary = async () => {
      throw new Error("disk full");
    };

    const result = await ingestChannelFile({
      sandbox,
      name: "report.pdf",
      mimeType: "application/pdf",
      data: textPdf(),
    });

    // The caller degrades to a "skipped" note rather than losing the message.
    expect(result).toBeNull();
  });
});
