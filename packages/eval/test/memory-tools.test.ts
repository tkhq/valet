import { describe, expect, it } from "vitest";
import { buildEvalMemoryTools, EvalMemoryStore } from "../src/memory-tools.js";

describe("eval mem_search", () => {
  it("OR-matches local terms, preserves phrases, and ranks stronger matches first", async () => {
    const store = new EvalMemoryStore();
    store.files.set("notes/project.md", { content: "Project notes." });
    store.files.set("notes/both.md", { content: "Project milestones and a release update." });
    store.files.set("notes/split.md", { content: "Release notes contain an update." });
    const search = buildEvalMemoryTools(store).find((tool) => tool.name === "mem_search");
    if (!search) throw new Error("mem_search missing");

    const broad = await search.execute({ query: "project milestones" }, {} as never);
    expect(broad.text.split("\n")).toEqual(["notes/both.md", "notes/project.md"]);

    const mixed = await search.execute({ query: '"release update" absent' }, {} as never);
    expect(mixed.text).toBe("notes/both.md");
  });
});
