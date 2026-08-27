// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { qkUsage } from "./usage";

describe("qkUsage", () => {
  it("breakdown key includes window", () => {
    expect(qkUsage.breakdown("30d")).toEqual(["usage", "breakdown", "30d"]);
  });

  it("sessions key includes window and useCase", () => {
    expect(qkUsage.sessions("7d", "orchestrator")).toEqual([
      "usage", "sessions", "7d", "orchestrator",
    ]);
  });

  it("sessions key with no useCase omits it", () => {
    expect(qkUsage.sessions("7d")).toEqual(["usage", "sessions", "7d", undefined]);
  });
});
