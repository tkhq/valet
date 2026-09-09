import { describe, expect, it } from "vitest";
import type { ChangelogCheckpoint, ChangelogEntry } from "@valet/api/wire";
import {
  clampPage,
  filterAndSortCheckpoints,
  groupChangelogEntries,
  pageCount,
  paginateCheckpoints,
} from "./changelog-view";

function entry(
  title: string,
  category: ChangelogEntry["category"],
  commitSha = title,
): ChangelogEntry {
  return {
    title,
    description: `${title} description`,
    category,
    sources: { commitSha },
    followUp: false,
  };
}

function release(
  version: string,
  releasedAt: string,
  entries: ChangelogEntry[],
): ChangelogCheckpoint {
  return {
    kind: "released",
    id: `${version}@${version}`,
    version,
    releasedAt,
    releasedSha: version,
    previousSha: null,
    entries,
  };
}

describe("changelog view logic", () => {
  it("groups features first and keeps source order within each type", () => {
    const groups = groupChangelogEntries([
      entry("Fix one", "fix"),
      entry("Feature one", "feature"),
      entry("Security one", "security"),
      entry("Feature two", "feature"),
      entry("Improvement one", "improvement"),
    ]);

    expect(groups.map((group) => group.category)).toEqual([
      "feature",
      "improvement",
      "fix",
      "security",
    ]);
    expect(groups[0]?.entries.map((item) => item.title)).toEqual(["Feature one", "Feature two"]);
  });

  it("filters entries and sections by type and search text", () => {
    const checkpoints = [
      release("2.0.0", "2026-02-01T00:00:00Z", [
        entry("Shared sessions", "feature", "feature-sha"),
        entry("Login repair", "fix", "fix-sha"),
      ]),
      release("1.0.0", "2026-01-01T00:00:00Z", [entry("First release", "feature")]),
    ];

    const features = filterAndSortCheckpoints(checkpoints, "feature", "shared", "newest");
    expect(features).toHaveLength(1);
    expect(features[0]?.entries.map((item) => item.title)).toEqual(["Shared sessions"]);
    expect(filterAndSortCheckpoints(checkpoints, "all", "fix-sha", "newest")[0]?.entries).toHaveLength(1);
  });

  it("sorts sections by checkpoint time in both directions", () => {
    const checkpoints = [
      release("1.0.0", "2026-01-01T00:00:00Z", []),
      release("3.0.0", "2026-03-01T00:00:00Z", []),
      release("2.0.0", "2026-02-01T00:00:00Z", []),
    ];

    expect(filterAndSortCheckpoints(checkpoints, "all", "", "newest").map((item) => item.version)).toEqual([
      "3.0.0",
      "2.0.0",
      "1.0.0",
    ]);
    expect(filterAndSortCheckpoints(checkpoints, "all", "", "oldest").map((item) => item.version)).toEqual([
      "1.0.0",
      "2.0.0",
      "3.0.0",
    ]);
  });

  it("paginates whole sections and clamps invalid pages", () => {
    const checkpoints = Array.from({ length: 7 }, (_, index) =>
      release(`${index + 1}.0.0`, `2026-01-0${index + 1}T00:00:00Z`, []),
    );

    expect(pageCount(checkpoints.length, 3)).toBe(3);
    expect(paginateCheckpoints(checkpoints, 2, 3).map((item) => item.version)).toEqual([
      "4.0.0",
      "5.0.0",
      "6.0.0",
    ]);
    expect(paginateCheckpoints(checkpoints, 99, 3).map((item) => item.version)).toEqual(["7.0.0"]);
    expect(clampPage(4, pageCount(1, 3))).toBe(1);
  });
});
