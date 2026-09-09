import { describe, expect, it } from "vitest";
import type { ChangelogManifest } from "../wire/types.js";
import { changelogResponse, parseChangelogManifest } from "./manifest.js";

const manifest: ChangelogManifest = {
  schema: "valet-changelog/v1",
  generatedAt: "2026-09-09T12:00:00Z",
  checkpoints: [
    {
      id: "1.0.0@abc",
      version: "1.0.0",
      releasedAt: "2026-09-09T12:00:00Z",
      releasedSha: "abc",
      previousSha: null,
      entries: [
        {
          title: "Open the changelog",
          description: "Users can read release notes inside Valet.",
          category: "feature",
          sources: { commitSha: "abc", pullRequest: 1 },
          followUp: false,
        },
      ],
    },
  ],
};

describe("changelog manifest", () => {
  it("loads a valid bundled artifact and matches its released SHA", () => {
    expect(parseChangelogManifest(manifest)).toEqual(manifest);
    expect(changelogResponse(manifest, "1.0.0", "abc").artifact).toEqual({
      version: "1.0.0",
      sha: "abc",
      checkpointId: "1.0.0@abc",
      status: "exact",
    });
  });

  it("reports the latest known checkpoint when this commit has none", () => {
    expect(changelogResponse(manifest, "development", "def").artifact).toEqual({
      version: "development",
      sha: "def",
      checkpointId: "1.0.0@abc",
      status: "latest-known",
    });
  });

  it("rejects a checkpoint whose id does not match its version and SHA", () => {
    const invalid = structuredClone(manifest);
    invalid.checkpoints[0].id = "wrong";
    expect(() => parseChangelogManifest(invalid)).toThrow("checkpoint id");
  });
});
