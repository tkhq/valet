import { describe, expect, it } from "vitest";
import {
  GitReplayPayloadError,
  readBoundedGitReplayJson,
  validateGitReplayPayload,
} from "./git-replay-limits.js";

const limits = { bodyBytes: 1_024, decodedBytes: 128, objects: 4, treeEntries: 4 };

function normalPayload() {
  const binary = Buffer.from([0, 255, 1, 2]);
  const lfs = Buffer.from([5, 6, 7]);
  return {
    repoFullName: "acme/widgets",
    targetRef: "refs/heads/main",
    expectedRemoteSha: "old",
    blobs: [{ sha: "blob", contentBase64: binary.toString("base64") }],
    trees: [{ sha: "tree", entries: [{ path: "binary.dat", mode: "100644", type: "blob", sha: "blob" }] }],
    lfsObjects: [{ oid: "lfs", size: lfs.length, contentBase64: lfs.toString("base64") }],
    commits: [{ localSha: "commit", message: "Subject\n", treeSha: "tree", parents: [] }],
  };
}

describe("Git replay transport limits", () => {
  it("rejects an oversized declared Content-Length before reading", async () => {
    const request = new Request("http://localhost", { method: "POST", headers: { "content-length": "33" }, body: "{}" });
    await expect(readBoundedGitReplayJson(request, 32)).rejects.toMatchObject({ status: 413 });
  });

  it("rejects chunked and lying-length bodies when streamed bytes overflow", async () => {
    for (const headers of [undefined, { "content-length": "2" }]) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"value":"'));
          controller.enqueue(new TextEncoder().encode('too large"}'));
          controller.close();
        },
      });
      const request = new Request("http://localhost", { method: "POST", headers, body: stream, duplex: "half" });
      await expect(readBoundedGitReplayJson(request, 8)).rejects.toMatchObject({ status: 413 });
    }
  });
});

describe("Git replay semantic limits", () => {
  it("accepts normal binary and LFS objects", () => {
    const payload = normalPayload();
    expect(validateGitReplayPayload(payload, JSON.stringify(payload).length, limits)).toMatchObject({ repoFullName: "acme/widgets" });
  });

  it("rejects too many replay objects", () => {
    const payload = normalPayload();
    payload.commits.push({ localSha: "second", message: "Subject\n", treeSha: "tree", parents: [] });
    expect(() => validateGitReplayPayload(payload, 100, limits)).toThrow(/more than 4 objects/u);
  });

  it("rejects aggregate decoded overflow across object classes", () => {
    const payload = normalPayload();
    payload.commits[0]!.message = "x".repeat(100);
    expect(() => validateGitReplayPayload(payload, 100, { ...limits, decodedBytes: 64 })).toThrow(/exceeds 64 decoded bytes/u);
  });
});
