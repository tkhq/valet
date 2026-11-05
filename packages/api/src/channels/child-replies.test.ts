import { describe, expect, it } from "vitest";
import { CHILD_REPLY_MAX_ATTEMPTS, childReplyRetryDelayMs } from "./child-replies.js";

describe("childReplyRetryDelayMs", () => {
  it("doubles from one second and caps at five minutes", () => {
    const delays = Array.from({ length: 12 }, (_, index) => childReplyRetryDelayMs(index + 1));
    expect(delays).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000, 300_000,
    ]);
  });

  it("keeps retrying for about an hour, longer than a typical provider incident", () => {
    const waits = Array.from({ length: CHILD_REPLY_MAX_ATTEMPTS - 1 }, (_, index) => childReplyRetryDelayMs(index + 1));
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(3_511_000);
  });
});
