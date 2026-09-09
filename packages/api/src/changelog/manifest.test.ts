import { describe, expect, it } from "vitest";
import bundledManifest from "./manifest.json";
import type { ChangelogManifest } from "../wire/types.js";
import { changelogResponse, parseChangelogManifest, safeChangelogResponse } from "./manifest.js";

const manifest: ChangelogManifest = {
  schema: "valet-changelog/v2",
  generatedAt: "2026-09-09T12:00:00Z",
  checkpoints: [
    {
      kind: "released",
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
  it("publishes specific fallback copy instead of canned descriptions or raw internal subjects", () => {
    const parsed = parseChangelogManifest(bundledManifest);
    const entries = parsed.checkpoints.flatMap((checkpoint) => checkpoint.entries);
    const descriptions = entries.map((entry) => entry.description);
    const counts = descriptions.map((description) => descriptions.filter((item) => item === description).length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
    expect(descriptions).not.toContain("This change is now available in Valet.");
    expect(descriptions).not.toContain("This release corrects this behavior for users.");
    expect(
      entries.filter((entry) => entry.followUp).every((entry) => /^(?:Available now|Fixed|Security update|Improved): /.test(entry.description)),
    ).toBe(true);
    expect(entries.some((entry) => /^(?:build|chore|ci|docs|refactor|test)(?:\(|:)/i.test(entry.title))).toBe(false);
  });

  it("loads a valid bundled artifact and matches its released SHA", () => {
    expect(parseChangelogManifest(manifest)).toEqual(manifest);
    expect(changelogResponse(manifest, "1.0.0", "abc").artifact).toEqual({
      version: "1.0.0",
      sha: "abc",
      checkpointId: "1.0.0@abc",
      status: "exact",
    });
  });

  it("matches an unreleased artifact and requires its checkpoint first", () => {
    const rolling: ChangelogManifest = {
      ...manifest,
      checkpoints: [
        {
          kind: "unreleased",
          id: "unreleased@def",
          buildSha: "def",
          builtAt: "2026-09-10T12:00:00Z",
          previousSha: "abc",
          entries: [],
        },
        ...manifest.checkpoints,
      ],
    };
    expect(changelogResponse(rolling, "development", "def").artifact).toEqual({
      version: "development",
      sha: "def",
      checkpointId: "unreleased@def",
      status: "unreleased",
    });
    expect(parseChangelogManifest(rolling)).toEqual(rolling);
    expect(() => parseChangelogManifest({ ...rolling, checkpoints: rolling.checkpoints.reverse() })).toThrow(
      "unique and first",
    );
  });

  it("reports the latest known checkpoint when this commit has none", () => {
    expect(changelogResponse(manifest, "development", "def").artifact).toEqual({
      version: "development",
      sha: "def",
      checkpointId: "1.0.0@abc",
      status: "latest-known",
    });
  });

  it("loads a visible empty checkpoint without blocking its release", () => {
    const empty = structuredClone(manifest);
    empty.checkpoints[0].entries = [];
    expect(parseChangelogManifest(empty).checkpoints[0].entries).toEqual([]);
  });

  it("returns a safe empty response when the bundled manifest is invalid", () => {
    const errors: string[] = [];
    const response = safeChangelogResponse(
      { schema: "wrong" },
      "broken-build",
      "def",
      (message) => errors.push(message),
    );
    expect(response.artifact).toEqual({
      version: "broken-build",
      sha: "def",
      checkpointId: null,
      status: "empty",
    });
    expect(errors).toEqual(["Bundled changelog is invalid. Regenerate the release manifest."]);
  });

  it("rejects a checkpoint whose id does not match its version and SHA", () => {
    const invalid = structuredClone(manifest);
    invalid.checkpoints[0].id = "wrong";
    expect(() => parseChangelogManifest(invalid)).toThrow("released changelog checkpoint");
  });
});
