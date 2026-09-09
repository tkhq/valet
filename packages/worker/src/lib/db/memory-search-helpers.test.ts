import { describe, expect, it } from "vitest";
import { buildFTS5Query } from "./memory-search-helpers.js";

describe("buildFTS5Query", () => {
  it("ORs plain terms while preserving phrases and negation", () => {
    expect(buildFTS5Query('projects "release update" -archived')).toBe(
      '("projects"* OR "release update") NOT "archived"*',
    );
  });
});
