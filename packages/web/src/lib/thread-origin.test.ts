import { describe, expect, it } from "vitest";
import { bucketCounts, filterThreads, threadMatchesSearch, threadOriginBucket } from "./thread-origin";

describe("threadOriginBucket", () => {
  it("buckets web + default + keyless threads as chat", () => {
    expect(threadOriginBucket({ key: "web:abc-123" })).toBe("chat");
    expect(threadOriginBucket({ key: "default" })).toBe("chat");
    expect(threadOriginBucket({ key: undefined })).toBe("chat");
  });
  it("buckets events + workflow signals as auto", () => {
    expect(threadOriginBucket({ key: "events" })).toBe("auto");
    expect(threadOriginBucket({ key: "signal:workflow:wfrun_x" })).toBe("auto");
  });
  it("buckets channel-transport keys as channel", () => {
    expect(threadOriginBucket({ key: "telegram:dm:12345" })).toBe("channel");
    expect(threadOriginBucket({ key: "slack:C042:thread" })).toBe("channel");
  });
  it("buckets cross-orchestrator and unknown keys as other", () => {
    expect(threadOriginBucket({ key: "signal:orchestrator:user-2" })).toBe("other");
    expect(threadOriginBucket({ key: "mystery" })).toBe("other");
  });
});

describe("bucketCounts", () => {
  it("counts per bucket including all", () => {
    const counts = bucketCounts([
      { key: "web:a" },
      { key: "events" },
      { key: "telegram:dm:1" },
      { key: "signal:x" },
      { key: undefined },
    ]);
    expect(counts).toEqual({ all: 5, chat: 2, auto: 1, channel: 1, other: 1 });
  });
});

describe("threadMatchesSearch + filterThreads", () => {
  const threads = [
    { id: "t1", title: "Building CI Triage", key: "web:a" },
    { id: "t2", title: "Casual Vibes", key: "web:b" },
    { id: "t3", title: undefined, key: "events" },
  ];
  it("matches title case-insensitively and empty query matches everything", () => {
    expect(threadMatchesSearch(threads[0]!, "ci triage")).toBe(true);
    expect(threadMatchesSearch(threads[1]!, "")).toBe(true);
    expect(threadMatchesSearch(threads[1]!, "triage")).toBe(false);
  });
  it("matches key and id for untitled threads", () => {
    expect(threadMatchesSearch(threads[2]!, "events")).toBe(true);
    expect(threadMatchesSearch(threads[2]!, "t3")).toBe(true);
  });
  it("combines bucket and query, preserving order", () => {
    expect(filterThreads(threads, "chat", "").map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(filterThreads(threads, "all", "triage").map((t) => t.id)).toEqual(["t1"]);
    expect(filterThreads(threads, "auto", "vibes")).toEqual([]);
  });
});
