import { describe, expect, it } from "vitest";
import type { PluginEventContext } from "@valet/engine";
import { parseLearnedNote, renderLearnedNote, writeLessons, type Lesson } from "../src/learn.js";

const lesson = (over: Partial<Lesson>): Lesson => ({
  action: "create",
  scope: "repo",
  kind: "check",
  title: "Audit every deleted order",
  description: "Deleting an order writes an audit entry.",
  rule: "Every function that deletes a stored order calls recordAudit first.",
  paths: ["src/orders.ts"],
  terms: ["orders.delete", "say \"hi\""],
  evidence: ["https://github.com/c/1"],
  ...over,
});

function memory(existing: Record<string, string> = {}) {
  const files = new Map(Object.entries(existing).map(([p, c]) => [p, { content: c, description: "" }]));
  const port: PluginEventContext["memory"] = {
    search: async () => [],
    read: async (path) => (files.has(path) ? { path, content: files.get(path)?.content ?? "" } : null),
    list: async (prefix) => [...files.keys()].filter((p) => p.startsWith(prefix)).map((path) => ({ path, title: path, description: "" })),
    write: async (path, file) => void files.set(path, file),
  };
  return { files, port };
}

describe("learned notes", () => {
  it("reads back what it writes, terms with quotes included", () => {
    const parsed = parseLearnedNote("code-review/learned/acme/site/x.md", renderLearnedNote(lesson({})));
    expect(parsed).toMatchObject({ title: "Audit every deleted order", kind: "check", paths: ["src/orders.ts"], terms: ["orders.delete", 'say "hi"'], retired: false });
    expect(parsed?.body).toBe("Every function that deletes a stored order calls recordAudit first.");
    expect(parseLearnedNote("notes/x.md", "# A plain note\n\nNo kind line.")).toBeUndefined();
  });

  it("creates under this repository or as a learned principle, and never overwrites a person's file", async () => {
    const m = memory({ "code-review/learned/acme/site/audit-every-deleted-order.md": "# x\n\nKind: check\n", "principles/prove-it-works.md": "# Prove it works" });
    const existing = new Set(["code-review/learned/acme/site/audit-every-deleted-order.md"]);
    const out = await writeLessons(m.port, "acme/site", [
      lesson({}),
      lesson({ scope: "principle", title: "Prove it works" }),
      lesson({ action: "update", path: "principles/prove-it-works.md" }),
      lesson({ action: "update", path: "code-review/learned/acme/site/audit-every-deleted-order.md", kind: "skip" }),
    ], existing);
    expect(out.written).toEqual([
      { path: "code-review/learned/acme/site/audit-every-deleted-order-2.md", action: "create" },
      { path: "principles/review-prove-it-works.md", action: "create" },
      { path: "code-review/learned/acme/site/audit-every-deleted-order.md", action: "update" },
    ]);
    expect(out.skipped).toEqual([{ title: "Audit every deleted order", reason: "update names principles/prove-it-works.md, which is not an existing learned lesson" }]);
    expect(m.files.get("principles/prove-it-works.md")?.content).toBe("# Prove it works");
  });
});
