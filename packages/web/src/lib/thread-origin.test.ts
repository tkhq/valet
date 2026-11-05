import { describe, expect, it } from "vitest";
import { bucketCounts, threadChannelType, threadOriginBucket } from "./thread-origin";

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

describe("threadChannelType", () => {
  it("reads the channel from a channel-owned key only", () => {
    expect(threadChannelType({ key: "slack:C1:1.2" })).toBe("slack");
    expect(threadChannelType({ key: "telegram:42" })).toBe("telegram");
    expect(threadChannelType({ key: "web:abc" })).toBeUndefined();
    expect(threadChannelType({ key: undefined })).toBeUndefined();
  });
});
