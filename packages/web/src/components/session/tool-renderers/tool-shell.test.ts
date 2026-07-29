import { describe, expect, it } from "vitest";
import { prettyToolName } from "./tool-shell";

describe("prettyToolName", () => {
  it("maps known engine tools to friendly names", () => {
    expect(prettyToolName("bash")).toBe("shell");
    expect(prettyToolName("mem_write")).toBe("memory write");
    expect(prettyToolName("thread_read")).toBe("thread read");
  });

  it("de-snake_cases unknown plugin tools", () => {
    expect(prettyToolName("github_create_pr")).toBe("github create pr");
    expect(prettyToolName("stripe.create_charge")).toBe("stripe create charge");
  });

  it("passes plain names through", () => {
    expect(prettyToolName("read")).toBe("read");
  });
});
