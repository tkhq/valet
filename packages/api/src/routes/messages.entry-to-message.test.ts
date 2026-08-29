/**
 * Wire projection of engine `MessageEntry.attachments`. See
 * `entryToMessage` in ./messages.ts and `PromptImageAttachment` in
 * ../wire/types.ts.
 *
 * The engine holds attachments as either a `data:` URL (the format the
 * REST route accepts today) or raw bytes; the wire ships one canonical
 * `data:` URL string. Assistant/tool/system messages never carry
 * attachments — the field is dropped for those.
 */
import { describe, expect, it } from "vitest";
import type { MessageEntry } from "@valet/engine";
import { entryToMessage } from "./messages.js";

function baseEntry(overrides: Partial<MessageEntry> = {}): MessageEntry {
  const base: MessageEntry = {
    id: "e_1",
    sessionId: "sess",
    threadId: "th",
    parentId: null,
    type: "message",
    role: "user",
    content: "look at this",
    createdAt: Date.parse("2024-01-01T00:00:00.000Z"),
  };
  return { ...base, ...overrides };
}

describe("entryToMessage — attachments projection", () => {
  it("passes through a data: URL attachment unchanged", () => {
    const entry = baseEntry({
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          name: "screenshot.png",
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments).toEqual([
      { kind: "image", url: "data:image/png;base64,AAAA", mimeType: "image/png", name: "screenshot.png" },
    ]);
  });

  it("synthesizes a data: URL from raw bytes", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const entry = baseEntry({
      attachments: [
        { type: "image", data: bytes, mimeType: "image/png", name: "raw.png" },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    const b64 = Buffer.from(bytes).toString("base64");
    expect(msg?.attachments).toEqual([
      { kind: "image", url: `data:image/png;base64,${b64}`, mimeType: "image/png", name: "raw.png" },
    ]);
  });

  it("defaults name to 'image' when the engine entry has none", () => {
    const entry = baseEntry({
      attachments: [
        { type: "image", url: "data:image/jpeg;base64,ZZZ", mimeType: "image/jpeg" },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments?.[0].name).toBe("image");
  });

  it("skips attachments with neither url nor data", () => {
    const entry = baseEntry({
      attachments: [
        { type: "image", mimeType: "image/png", name: "empty.png" },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          name: "good.png",
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments).toHaveLength(1);
    expect(msg?.attachments?.[0].name).toBe("good.png");
  });

  it("omits attachments entirely when the entry has none", () => {
    const msg = entryToMessage(baseEntry(), "sess", "th");
    expect(msg).not.toBeNull();
    expect(msg && "attachments" in msg).toBe(false);
  });

  it("omits attachments when every engine attachment was skipped", () => {
    const entry = baseEntry({
      attachments: [{ type: "image", mimeType: "image/png", name: "empty.png" }],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg && "attachments" in msg).toBe(false);
  });

  it("projects file attachments to the wire format", () => {
    const entry = baseEntry({
      attachments: [
        {
          type: "file",
          path: "/workspace/uploads/report.pdf",
          bytes: 843 * 1024,
          sha256: "abc123def456",
          mimeType: "application/pdf",
          markdownPath: "/workspace/uploads/report.pdf.md",
          name: "report.pdf",
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments).toEqual([
      {
        kind: "file",
        path: "/workspace/uploads/report.pdf",
        bytes: 843 * 1024,
        sha256: "abc123def456",
        mimeType: "application/pdf",
        markdownPath: "/workspace/uploads/report.pdf.md",
        name: "report.pdf",
      },
    ]);
  });

  it("handles mixed image and file attachments", () => {
    const entry = baseEntry({
      attachments: [
        { type: "image", url: "data:image/png;base64,AAAA", mimeType: "image/png", name: "img.png" },
        {
          type: "file",
          path: "/workspace/uploads/data.zip",
          bytes: 2048000,
          sha256: "xyz789",
          mimeType: "application/zip",
          name: "data.zip",
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments).toHaveLength(2);
    expect(msg?.attachments?.[0].kind).toBe("image");
    expect(msg?.attachments?.[1].kind).toBe("file");
  });

  it("preserves optional file fields (mimeType, markdownPath, extractedTo, extractedFiles)", () => {
    const entry = baseEntry({
      attachments: [
        {
          type: "file",
          path: "/workspace/uploads/plain.txt",
          bytes: 1024,
          sha256: "txt123",
          name: "plain.txt",
          // mimeType, markdownPath, extractedTo, extractedFiles omitted
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments?.[0]).toEqual({
      kind: "file",
      path: "/workspace/uploads/plain.txt",
      bytes: 1024,
      sha256: "txt123",
      name: "plain.txt",
      // optional fields not present
    });
  });

  it("projects extractedTo and extractedFiles through to wire shape", () => {
    const extractedFiles = [
      "/workspace/uploads/bundle/file1.txt",
      "/workspace/uploads/bundle/file2.txt",
      "/workspace/uploads/bundle/subdir/file3.txt",
    ];
    const entry = baseEntry({
      attachments: [
        {
          type: "file",
          path: "/workspace/uploads/bundle.tar.gz",
          bytes: 5120,
          sha256: "tar123",
          name: "bundle.tar.gz",
          extractedTo: "/workspace/uploads/bundle/",
          extractedFiles: extractedFiles,
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments?.[0]).toEqual({
      kind: "file",
      path: "/workspace/uploads/bundle.tar.gz",
      bytes: 5120,
      sha256: "tar123",
      name: "bundle.tar.gz",
      extractedTo: "/workspace/uploads/bundle/",
      extractedFiles: extractedFiles,
    });
  });

  it("projects image and file attachments side by side", () => {
    // MessageEntry.attachments admits only image and file variants, so
    // there is no third kind to filter at the type level; this covers the
    // mixed projection.
    const entry = baseEntry({
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          name: "img.png",
        },
        {
          type: "file",
          path: "/workspace/uploads/file.txt",
          bytes: 512,
          sha256: "file123",
          name: "file.txt",
        },
      ],
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.attachments).toHaveLength(2);
    expect(msg?.attachments?.every((a) => a.kind === "image" || a.kind === "file")).toBe(true);
  });
});

describe("entryToMessage — skill invocation projection", () => {
  it("projects metadata.skill / metadata.skillArgs on a user entry", () => {
    const entry = baseEntry({
      metadata: { skill: "review", skillArgs: "src/ please" },
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.skill).toEqual({ name: "review", args: "src/ please" });
  });

  it("omits args when the stamp has none (host Thread.skill submission)", () => {
    const entry = baseEntry({ metadata: { skill: "deploy", syntheticFrom: "skill" } });
    expect(entryToMessage(entry, "sess", "th")?.skill).toEqual({ name: "deploy" });
  });

  it("drops the field for non-user roles and unstamped entries", () => {
    expect(entryToMessage(baseEntry({}), "sess", "th")?.skill).toBeUndefined();
    const assistant = baseEntry({ role: "assistant", metadata: { skill: "review" } });
    expect(entryToMessage(assistant, "sess", "th")?.skill).toBeUndefined();
    const badType = baseEntry({ metadata: { skill: 42 } });
    expect(entryToMessage(badType, "sess", "th")?.skill).toBeUndefined();
  });
});

describe("entryToMessage — author projection", () => {
  it("projects the sender's identity from a user entry", () => {
    const entry = baseEntry({
      author: { id: "u_alice", name: "Alice", email: "alice@example.com" },
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.author).toEqual({ id: "u_alice", name: "Alice", email: "alice@example.com" });
  });

  it("keeps channel-plugin externalId off the wire", () => {
    const entry = baseEntry({
      author: { id: "u_bob", name: "Bob", externalId: "U123SLACK" },
    });
    const msg = entryToMessage(entry, "sess", "th");
    expect(msg?.author).toEqual({ id: "u_bob", name: "Bob" });
  });

  it("omits the field for authorless entries and non-user roles", () => {
    expect(entryToMessage(baseEntry(), "sess", "th")?.author).toBeUndefined();
    const assistant = baseEntry({
      role: "assistant",
      author: { id: "u_alice", name: "Alice" },
    });
    expect(entryToMessage(assistant, "sess", "th")?.author).toBeUndefined();
  });
});
