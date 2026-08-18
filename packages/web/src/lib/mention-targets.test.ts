import { describe, it, expect } from "vitest";
import {
  applyMention,
  findMentionQuery,
  matchRank,
  rankMentionTargets,
  type MentionTarget,
} from "./mention-targets";

describe("findMentionQuery", () => {
  it("finds a mention at the start of the text", () => {
    expect(findMentionQuery("@src", 4)).toEqual({ start: 0, end: 4, query: "src" });
  });

  it("finds a mention after a space", () => {
    expect(findMentionQuery("look at @src/app", 16)).toEqual({ start: 8, end: 16, query: "src/app" });
  });

  it("opens on a bare @ so a person can browse", () => {
    expect(findMentionQuery("fix @", 5)).toEqual({ start: 4, end: 5, query: "" });
  });

  it("does not open inside an email address", () => {
    // The `@` follows a letter, so it is not a mention.
    expect(findMentionQuery("mail someone@example.com", 24)).toBeNull();
  });

  it("does not open when the caret sits past a space", () => {
    expect(findMentionQuery("@src/app.ts and", 15)).toBeNull();
  });

  it("uses the caret, not the end of the text", () => {
    // Caret between "@sr" and "c later".
    expect(findMentionQuery("@src later", 3)).toEqual({ start: 0, end: 3, query: "sr" });
  });

  it("finds the mention the caret is in when the text holds several", () => {
    const text = "@a.ts and @b.ts";
    expect(findMentionQuery(text, 15)).toEqual({ start: 10, end: 15, query: "b.ts" });
  });

  it("returns null for text with no mention", () => {
    expect(findMentionQuery("just a message", 14)).toBeNull();
  });

  it("clamps a caret past the end of the text", () => {
    expect(findMentionQuery("@a", 99)).toEqual({ start: 0, end: 2, query: "a" });
  });

  it("returns null at caret zero", () => {
    expect(findMentionQuery("@a", 0)).toBeNull();
  });

  it("does not open across a newline", () => {
    expect(findMentionQuery("@a\nb", 4)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the token and leaves the caret after the inserted path", () => {
    const mention = findMentionQuery("look at @app", 12);
    expect(mention).not.toBeNull();
    const result = applyMention("look at @app", mention!, "src/app.ts");
    expect(result.text).toBe("look at @src/app.ts ");
    expect(result.caret).toBe(result.text.length);
  });

  it("keeps the text that follows the token", () => {
    const mention = findMentionQuery("see @app and stop", 8);
    const result = applyMention("see @app and stop", mention!, "src/app.ts");
    expect(result.text).toBe("see @src/app.ts  and stop");
    // The caret lands right after the inserted path and its trailing space.
    expect(result.text.slice(0, result.caret)).toBe("see @src/app.ts ");
  });
});

describe("matchRank", () => {
  it("ranks a file-name prefix above a path prefix", () => {
    const byName = matchRank("deep/nested/app.ts", "app");
    const byPath = matchRank("app/other/thing.ts", "app");
    expect(byName).not.toBeNull();
    expect(byPath).not.toBeNull();
    expect(byName!).toBeLessThan(byPath!);
  });

  it("ranks a name prefix above a name substring", () => {
    expect(matchRank("src/app.ts", "app")!).toBeLessThan(matchRank("src/myapp.ts", "app")!);
  });

  it("ignores case", () => {
    expect(matchRank("src/App.tsx", "app")).toBe(0);
  });

  it("matches everything at one rank for an empty query", () => {
    expect(matchRank("anything", "")).toBe(0);
  });

  it("returns null when nothing matches", () => {
    expect(matchRank("src/app.ts", "zzz")).toBeNull();
  });
});

const TARGETS: MentionTarget[] = [
  { path: "src/app.ts", group: "Changed files", detail: "+2 -1" },
  { path: "docs/appendix.md", group: "Memory", detail: "Appendix" },
  { path: "src/util/helper.ts", group: "Changed files" },
  { path: "notes/journal.md", group: "Memory" },
];

describe("rankMentionTargets", () => {
  it("puts the closest match first", () => {
    expect(rankMentionTargets(TARGETS, "app").map((t) => t.path)).toEqual([
      "src/app.ts",
      "docs/appendix.md",
    ]);
  });

  it("keeps the given order for equal ranks, so changed files lead", () => {
    const equal: MentionTarget[] = [
      { path: "a/x.ts", group: "Changed files" },
      { path: "b/x.ts", group: "Memory" },
    ];
    expect(rankMentionTargets(equal, "x").map((t) => t.group)).toEqual(["Changed files", "Memory"]);
  });

  it("lists everything for a bare @", () => {
    expect(rankMentionTargets(TARGETS, "")).toHaveLength(4);
  });

  it("drops what does not match", () => {
    expect(rankMentionTargets(TARGETS, "journal").map((t) => t.path)).toEqual(["notes/journal.md"]);
  });

  it("caps the list so the popup stays scannable", () => {
    const many: MentionTarget[] = Array.from({ length: 40 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      group: "Changed files",
    }));
    expect(rankMentionTargets(many, "file")).toHaveLength(12);
  });

  it("returns nothing when no target matches", () => {
    expect(rankMentionTargets(TARGETS, "nothing-like-this")).toEqual([]);
  });

  it("keeps each group's rows together, because the popup renders by group", () => {
    // Ranking alone would interleave these: memory/app.md outranks
    // changed/zzz-app.ts, which outranks memory/other-app.md. A split group
    // breaks the popup's arrow-key walk, so the groups must come out whole.
    const mixed: MentionTarget[] = [
      { path: "changed/app.ts", group: "Changed files" },
      { path: "memory/app.md", group: "Memory" },
      { path: "changed/zzz-app.ts", group: "Changed files" },
      { path: "memory/other-app.md", group: "Memory" },
    ];
    const groups = rankMentionTargets(mixed, "app").map((t) => t.group);
    const firstMemory = groups.indexOf("Memory");
    const lastMemory = groups.lastIndexOf("Memory");
    // Every row between the first and last of a group belongs to it.
    expect(groups.slice(firstMemory, lastMemory + 1).every((g) => g === "Memory")).toBe(true);
  });
});
