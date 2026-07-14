import { describe, it, expect } from "vitest";
import { relativeTime } from "./relative-time";

describe("relativeTime", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("formats sub-minute as just now", () => {
    expect(relativeTime(now - 10_000, now)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
  });

  it("formats hours", () => {
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });

  it("formats days", () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("treats a future timestamp (clock skew) as just now", () => {
    expect(relativeTime(now + 5_000, now)).toBe("just now");
  });
});
