import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";

describe("plugin manifest", () => {
  it("ships base and advanced browser skills", () => {
    expect(plugin.skills?.map((skill) => skill.name)).toEqual([
      "browser",
      "browser-advanced",
    ]);
  });

  it("routes complex browser work to the advanced skill", () => {
    const base = plugin.skills?.find((skill) => skill.name === "browser");
    expect(base?.content).toContain("`browser-advanced` skill");
    expect(base?.content).toContain("frames");
    expect(base?.content).toContain("diagnostics");
  });
});
