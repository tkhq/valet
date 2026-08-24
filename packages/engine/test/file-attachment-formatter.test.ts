import { describe, it, expect } from "vitest";
import { formatFileAttachmentsNote } from "../src/file-attachment-formatter.js";
import type { MessageEntry } from "../src/types.js";

type FileAttachment = Extract<MessageEntry["attachments"], unknown[] | undefined>[number] & {
  type: "file";
};

describe("formatFileAttachmentsNote", () => {
  it("returns empty string for empty array", () => {
    const result = formatFileAttachmentsNote([]);
    expect(result).toBe("");
  });

  it("returns empty string for undefined", () => {
    const result = formatFileAttachmentsNote(undefined);
    expect(result).toBe("");
  });

  it("formats a PDF with markdown sidecar", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/report.pdf",
        bytes: 843 * 1024, // 843 KB
        sha256: "abc123",
        mimeType: "application/pdf",
        markdownPath: "/workspace/uploads/report.pdf.md",
        name: "report.pdf",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain(
      "- /workspace/uploads/report.pdf (843 KB, PDF, markdown at /workspace/uploads/report.pdf.md)"
    );
    expect(result).toContain("[User attached files to the sandbox:");
    expect(result).toContain("]");
  });

  it("formats a PDF without markdown sidecar", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/scan.pdf",
        bytes: 512 * 1024, // 512 KB
        sha256: "def456",
        mimeType: "application/pdf",
        name: "scan.pdf",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/scan.pdf (512 KB, application/pdf)");
    expect(result).not.toContain("markdown at");
  });

  it("formats a zip with extraction root", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/data.zip",
        bytes: 2 * 1024 * 1024, // 2 MB
        sha256: "ghi789",
        extractedTo: "/workspace/uploads/data",
        name: "data.zip",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/data.zip (extracted to /workspace/uploads/data/)");
  });

  it("formats a plain text file", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/notes.txt",
        bytes: 1024, // 1 KB
        sha256: "jkl012",
        mimeType: "text/plain",
        name: "notes.txt",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/notes.txt (1 KB, text/plain)");
  });

  it("handles bytes in B, KB, MB correctly", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/small.txt",
        bytes: 512, // 512 B
        sha256: "small1",
        mimeType: "text/plain",
        name: "small.txt",
      },
      {
        type: "file",
        path: "/workspace/uploads/medium.bin",
        bytes: 512 * 1024, // 512 KB
        sha256: "medium1",
        mimeType: "application/octet-stream",
        name: "medium.bin",
      },
      {
        type: "file",
        path: "/workspace/uploads/large.iso",
        bytes: 500 * 1024 * 1024, // 500 MB
        sha256: "large1",
        mimeType: "application/octet-stream",
        name: "large.iso",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("512 B");
    expect(result).toContain("512 KB");
    expect(result).toContain("500 MB");
  });

  it("formats mixed list with PDFs, zips, and text files", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/report.pdf",
        bytes: 843 * 1024,
        sha256: "abc123",
        mimeType: "application/pdf",
        markdownPath: "/workspace/uploads/report.pdf.md",
        name: "report.pdf",
      },
      {
        type: "file",
        path: "/workspace/uploads/data.zip",
        bytes: 2 * 1024 * 1024,
        sha256: "ghi789",
        extractedTo: "/workspace/uploads/data",
        name: "data.zip",
      },
      {
        type: "file",
        path: "/workspace/uploads/notes.txt",
        bytes: 1024,
        sha256: "jkl012",
        mimeType: "text/plain",
        name: "notes.txt",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("[User attached files to the sandbox:");
    expect(result).toContain(
      "- /workspace/uploads/report.pdf (843 KB, PDF, markdown at /workspace/uploads/report.pdf.md)"
    );
    expect(result).toContain("- /workspace/uploads/data.zip (extracted to /workspace/uploads/data/)");
    expect(result).toContain("- /workspace/uploads/notes.txt (1 KB, text/plain)");
    expect(result).toContain("]");
  });

  it("handles files without mimeType", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/mystery",
        bytes: 1024,
        sha256: "unknown1",
        name: "mystery",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/mystery (1 KB, application/octet-stream)");
  });

  it("correctly formats fractional KB values", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/tiny.txt",
        bytes: 1024 + 512, // 1.5 KB
        sha256: "tiny1",
        mimeType: "text/plain",
        name: "tiny.txt",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    // Should format as "1.5 KB"
    expect(result).toMatch(/1\.5 KB/);
  });

  it("formats only extractedTo set (no mimeType, no markdownPath)", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/bundle.tgz",
        bytes: 2048,
        sha256: "abc",
        name: "bundle.tgz",
        extractedTo: "/workspace/uploads/bundle/",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/bundle.tgz (extracted to /workspace/uploads/bundle/)");
  });

  it("formats markdownPath set with mimeType absent (presence, not mimeType, is the signal)", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/report.pdf",
        bytes: 843 * 1024,
        sha256: "abc123",
        name: "report.pdf",
        markdownPath: "/workspace/uploads/report.pdf.md",
        // mimeType deliberately absent
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/report.pdf (843 KB, PDF, markdown at /workspace/uploads/report.pdf.md)");
  });

  it("formats neither extractedTo nor markdownPath set (plain file)", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/notes.txt",
        bytes: 1024,
        sha256: "txt123",
        name: "notes.txt",
        mimeType: "text/plain",
      },
      {
        type: "file",
        path: "/workspace/uploads/data.bin",
        bytes: 2048,
        sha256: "bin123",
        name: "data.bin",
        // mimeType absent - should default to application/octet-stream
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/notes.txt (1 KB, text/plain)");
    expect(result).toContain("- /workspace/uploads/data.bin (2 KB, application/octet-stream)");
  });

  it("appends trailing slash to extractedTo when not present", () => {
    const files: FileAttachment[] = [
      {
        type: "file",
        path: "/workspace/uploads/bundle.zip",
        bytes: 2048,
        sha256: "abc",
        name: "bundle.zip",
        extractedTo: "/workspace/uploads/bundle",
      },
    ];

    const result = formatFileAttachmentsNote(files);
    expect(result).toContain("- /workspace/uploads/bundle.zip (extracted to /workspace/uploads/bundle/)");
  });
});
