import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";

describe("memory skill", () => {
  const memory = plugin.skills?.find((skill) => skill.name === "memory");

  it("is the skill to load when the person wants their memory used", () => {
    expect(memory?.description).toContain("Find and use what memory already holds");
  });

  it("tells the agent to open the files a search finds before it relies on them", () => {
    expect(memory?.content).toContain("## Find and use what you know");
    expect(memory?.content).toContain("`mem_read` each file your answer depends on");
    expect(memory?.content).not.toContain("Day-to-day remembering doesn't need this");
  });
});
