import { describe, expect, it } from "vitest";
import { findMisses, goldenText, groupMisses, insideRepo, keptFindings, missCase, missCaseId, reviewedBy } from "../src/review-misses.js";
import type { OutcomeRow, PullNode } from "../src/review-outcomes.js";

const row = (over: Partial<OutcomeRow>): OutcomeRow => ({
  repo: "acme/shop", pr: 7, prTitle: "Add carts", prBody: "", base: "b".repeat(40), mergedHead: "m".repeat(40),
  bot: "Copilot", commentId: 1, commit: "c".repeat(40), path: "src/cart.ts", line: 20, side: "RIGHT",
  severity: "unrated", body: "The total skips the last item.", changed: "changed", resolvedByPerson: false,
  thumbsUp: 0, thumbsDown: 0, replies: 0, outcome: "addressed", ...over,
});

const pull = (number: number, reviews: [login: string, commit: string][]): PullNode => ({
  number, title: "t", body: "", baseRefOid: "b", headRefOid: "h",
  reviews: { nodes: reviews.map(([login, oid]) => ({ author: { login }, commit: { oid } })) },
  reviewThreads: { nodes: [] },
});

describe("review misses", () => {
  it("lists the commits our reviewer reviewed, matching an app's bot login", () => {
    expect([...reviewedBy("acme/shop", [pull(7, [["acme-review[bot]", "c1"], ["Copilot", "c2"]]), pull(8, [["someone", "c3"]])], "acme-review")]).toEqual(["acme/shop#7@c1"]);
  });

  it("keeps another reviewer's addressed comment when ours left nothing nearby", () => {
    const reviewed = new Set([`acme/shop#7@${"c".repeat(40)}`]);
    const theirs = row({ commentId: 1 });
    expect(findMisses([theirs], { ours: "acme-review", reviewed })).toEqual([theirs]);
    // Ours flagged the same spot.
    expect(findMisses([theirs, row({ bot: "acme-review", commentId: 2, line: 25 })], { ours: "acme-review", reviewed })).toEqual([]);
    // Ours flagged the same file far away, or another file at the same line.
    expect(findMisses([theirs, row({ bot: "acme-review", line: 40 }), row({ bot: "acme-review", path: "src/a.ts" })], { ours: "acme-review", reviewed })).toEqual([theirs]);
    // Not addressed, a deleted line, a pull request ours never reviewed, or a commit ours never saw.
    expect(findMisses([row({ outcome: "ignored" }), row({ side: "LEFT" }), row({ pr: 8 }), row({ commit: "e".repeat(40) })], { ours: "acme-review", reviewed })).toEqual([]);
    // Ours' own addressed comments are not misses.
    expect(findMisses([row({ bot: "acme-review[bot]" })], { ours: "acme-review", reviewed })).toEqual([]);
  });

  it("writes golden text without HTML, collapsed details or code blocks", () => {
    expect(goldenText("<!-- id -->**Clear the id**\n\nThe sync keeps a stale id.\n<details><summary>SQL</summary>\n\nselect 1\n</details>\n```suggestion\nx\n```")).toBe("**Clear the id** The sync keeps a stale id.");
    const long = goldenText("word ".repeat(300));
    expect(long.length).toBeLessThanOrEqual(603);
    expect(long.endsWith("...")).toBe(true);
  });

  it("makes one case per pull request commit, with the comments as golden comments", () => {
    const other = "d".repeat(40);
    const groups = groupMisses([row({ commentId: 1 }), row({ commentId: 2, line: 90 }), row({ commentId: 3, commit: other })]);
    expect(groups.map((g) => [g.commit.slice(0, 1), g.rows.length])).toEqual([["c", 2], ["d", 1]]);
    const [first] = groups;
    if (!first) throw new Error("no group");
    expect(missCaseId(first)).toBe("miss-shop-7-ccccccc");
    expect(missCase(first, "a".repeat(40), true)).toMatchObject({
      id: "miss-shop-7-ccccccc",
      pull_request: { repo: "acme-shop", remote: "https://github.com/acme/shop.git", base: "a".repeat(40), head: "c".repeat(40), number: 7, private: true },
      checks: [{ type: "review_match", golden: [{ comment: "The total skips the last item.", category: "bug" }, { category: "bug" }] }],
    });
    const rated = missCase(groupMisses([row({ severity: "medium", category: "security" })])[0] ?? first, "a", false);
    expect(rated).toMatchObject({ checks: [{ golden: [{ severity: "Medium", category: "security" }] }] });
  });

  it("keeps our own addressed comments as kept cases, apart from misses", () => {
    const rows = [
      row({ bot: "acme-review[bot]", commentId: 2 }),
      row({ bot: "acme-review[bot]", commentId: 3, outcome: "ignored" }),
      row({ bot: "acme-review[bot]", commentId: 4, side: "LEFT" }),
      row({ commentId: 5 }),
    ];
    expect(keptFindings(rows, "acme-review").map((r) => r.commentId)).toEqual([2]);
    const [g] = groupMisses(keptFindings(rows, "acme-review"));
    expect(missCase(g, "b".repeat(40), true, "kept")).toMatchObject({ id: "kept-shop-7-ccccccc", description: expect.stringContaining("our reviewer commented on") });
  });

  it("refuses an output directory inside the repository", () => {
    expect(insideRepo("/repo/evals/private", "/repo")).toBe(true);
    expect(insideRepo("/repo", "/repo")).toBe(true);
    expect(insideRepo("/home/me/cases", "/repo")).toBe(false);
    expect(insideRepo("/repo-other/cases", "/repo")).toBe(false);
  });
});
