import { describe, expect, it } from "vitest";
import type { ArtifactCommentWire } from "@valet/api/wire";
import { groupThreads } from "./artifact-comments";

function comment(overrides: Partial<ArtifactCommentWire>): ArtifactCommentWire {
  return {
    id: "c1",
    vdid: null,
    parentId: null,
    body: "body",
    authorUserId: "u1",
    authorName: "User One",
    version: 1,
    sentToSession: null,
    resolvedAt: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("groupThreads", () => {
  it("groups replies under their root, in order", () => {
    const threads = groupThreads([
      comment({ id: "a" }),
      comment({ id: "b" }),
      comment({ id: "a-1", parentId: "a", createdAt: 2 }),
      comment({ id: "a-2", parentId: "a", createdAt: 3 }),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual(["a", "b"]);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual(["a-1", "a-2"]);
    expect(threads[1]?.replies).toEqual([]);
  });

  it("drops replies whose root is missing instead of rendering them unparented", () => {
    const threads = groupThreads([comment({ id: "orphan-reply", parentId: "gone" })]);
    expect(threads).toEqual([]);
  });
});
