import { describe, expect, it } from "vitest";
import type { ChangelogCheckpoint, ChangelogEntry } from "@valet/api/wire";
import {
  isUnreadChangelogEntry,
  lastSeenChangelogState,
  lastSeenCheckpoint,
  markChangelogSeen,
  unreadCheckpointIds,
} from "./changelog-read-state";

function checkpoint(id: string): ChangelogCheckpoint {
  const [version, releasedSha] = id.split("@");
  return {
    kind: "released",
    id,
    version,
    releasedAt: "2026-09-09T12:00:00Z",
    releasedSha,
    previousSha: null,
    entries: [],
  };
}

function entry(commitSha: string): ChangelogEntry {
  return {
    title: commitSha,
    description: "",
    category: "feature",
    sources: { commitSha },
    followUp: false,
  };
}

describe("changelog read state", () => {
  it("stores the last checkpoint separately for each user", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    markChangelogSeen("user-a", "2@bbb", [], storage);
    expect(lastSeenCheckpoint("user-a", storage)).toBe("2@bbb");
    expect(lastSeenCheckpoint("user-b", storage)).toBeNull();
  });

  it("keeps replaced rolling checkpoints from making released history unread", () => {
    const released = checkpoint("1@aaa");
    const rolling: ChangelogCheckpoint = {
      kind: "unreleased",
      id: "unreleased@ccc",
      buildSha: "ccc",
      builtAt: "2026-09-10T12:00:00Z",
      previousSha: "aaa",
      entries: [],
    };
    expect([...unreadCheckpointIds([rolling, released], "unreleased@bbb")]).toEqual([
      "unreleased@ccc",
    ]);
    expect([...unreadCheckpointIds([checkpoint("2@bbb"), released], "unreleased@bbb")]).toEqual([]);
  });

  it("marks only checkpoints newer than the last visit as unread", () => {
    const checkpoints = [checkpoint("3@ccc"), checkpoint("2@bbb"), checkpoint("1@aaa")];
    expect([...unreadCheckpointIds(checkpoints, "2@bbb")]).toEqual(["3@ccc"]);
    expect([...unreadCheckpointIds(checkpoints, null)]).toEqual(["3@ccc", "2@bbb", "1@aaa"]);
    expect([...unreadCheckpointIds(checkpoints, "3@ccc")]).toEqual([]);
  });

  it("fails closed for malformed JSON read state", () => {
    const storage = {
      getItem: () => "{",
      setItem: () => undefined,
    };

    expect(lastSeenChangelogState("user-a", storage)).toEqual({
      checkpointId: null,
      unreleasedEntryCommitShas: null,
    });
  });

  it("fails closed for an unknown JSON read state", () => {
    const storage = {
      getItem: () => JSON.stringify({ version: 2, seen: "unreleased@previous" }),
      setItem: () => undefined,
    };

    expect(lastSeenChangelogState("user-a", storage)).toEqual({
      checkpointId: null,
      unreleasedEntryCommitShas: null,
    });
  });

  it("marks only added entries in a partially seen unreleased checkpoint as new", () => {
    const first = entry("first");
    const added = entry("added");
    const current: ChangelogCheckpoint = {
      kind: "unreleased",
      id: "unreleased@current",
      buildSha: "current",
      builtAt: "2026-09-10T12:00:00Z",
      previousSha: "aaa",
      entries: [added, first],
    };
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    markChangelogSeen("user-a", "unreleased@previous", [{ ...current, entries: [first] }], storage);
    const seen = lastSeenChangelogState("user-a", storage);
    const unread = unreadCheckpointIds([current], seen?.checkpointId ?? null);

    expect(isUnreadChangelogEntry(current, first, unread, seen)).toBe(false);
    expect(isUnreadChangelogEntry(current, added, unread, seen)).toBe(true);
  });

  it("reads old checkpoint-only values without marking all rolling entries as new", () => {
    const current: ChangelogCheckpoint = {
      kind: "unreleased",
      id: "unreleased@current",
      buildSha: "current",
      builtAt: "2026-09-10T12:00:00Z",
      previousSha: "aaa",
      entries: [entry("first"), entry("second")],
    };
    const storage = {
      getItem: () => "unreleased@previous",
      setItem: () => undefined,
    };
    const seen = lastSeenChangelogState("user-a", storage);
    const unread = unreadCheckpointIds([current], seen?.checkpointId ?? null);

    expect(seen).toEqual({ checkpointId: "unreleased@previous", unreleasedEntryCommitShas: null });
    expect(current.entries.map((currentEntry) => isUnreadChangelogEntry(current, currentEntry, unread, seen))).toEqual([
      false,
      false,
    ]);
  });
});
