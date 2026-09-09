import { describe, expect, it } from "vitest";
import type { ChangelogCheckpoint } from "@valet/api/wire";
import {
  lastSeenCheckpoint,
  markChangelogSeen,
  unreadCheckpointIds,
} from "./changelog-read-state";

function checkpoint(id: string): ChangelogCheckpoint {
  const [version, releasedSha] = id.split("@");
  return {
    id,
    version,
    releasedAt: "2026-09-09T12:00:00Z",
    releasedSha,
    previousSha: null,
    entries: [],
  };
}

describe("changelog read state", () => {
  it("stores the last checkpoint separately for each user", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    markChangelogSeen("user-a", "2@bbb", storage);
    expect(lastSeenCheckpoint("user-a", storage)).toBe("2@bbb");
    expect(lastSeenCheckpoint("user-b", storage)).toBeNull();
  });

  it("marks only checkpoints newer than the last visit as unread", () => {
    const checkpoints = [checkpoint("3@ccc"), checkpoint("2@bbb"), checkpoint("1@aaa")];
    expect([...unreadCheckpointIds(checkpoints, "2@bbb")]).toEqual(["3@ccc"]);
    expect([...unreadCheckpointIds(checkpoints, null)]).toEqual(["3@ccc", "2@bbb", "1@aaa"]);
    expect([...unreadCheckpointIds(checkpoints, "3@ccc")]).toEqual([]);
  });
});
