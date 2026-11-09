import { describe, expect, it } from "vitest";
import { collectHandles, scrubHandles, selectSubset, spreadPick, toCase, type SwrInstance } from "../src/swr-import.js";
import { parseEvalCase } from "../src/index.js";

const inst = (over: Partial<SwrInstance>): SwrInstance => ({
  repo: "psf/requests",
  instance_id: "psf__requests-2258",
  pr_title: "Add json parameter",
  pr_statement: "Thanks @someone for the idea. Uses @pytest.mark.skipif.",
  change_introduced: true,
  base_commit: "a".repeat(40),
  created_at: "2020-01-01T00:00:00Z",
  changes: [
    { change_type: "F.1 Interface", change_discussion: { discussion_summary: "Reviewer `kevinburke` noted that adding `json` before `params` breaks positional callers. kevinburke asked for a fix." } },
    { change_type: "E.1.1 Textual Changes", change_discussion: { discussion_summary: "The author (`Lukasa`) fixed a typo." } },
  ],
  pr_commits: [
    { sha: "b".repeat(40), diff_text: "+def prepare(self, json=None, params=None):\n" },
    { sha: "c".repeat(40), diff_text: "+    pass\n" },
  ],
  ...over,
});

describe("SWR-Bench import", () => {
  it("replaces handles with role words and keeps code identifiers", () => {
    const handles = collectHandles(["Reviewer `kevinburke` noted it.", "The author (`Lukasa`) agreed.", "Reviewer `params` is odd."]);
    expect(handles).toEqual(new Set(["kevinburke", "Lukasa", "params"]));
    const diff = "+def prepare(self, json=None, params=None):";
    expect(scrubHandles("Reviewer `kevinburke` said `params` moved. kevinburke asked.", handles, diff)).toBe("Reviewer said `params` moved. a participant asked.");
    expect(scrubHandles("The author (`Lukasa`) fixed it.", handles, diff)).toBe("The author fixed it.");
  });

  it("maps F.* changes to recall-bearing bugs and E.* to style, with head at the last pre-review commit", () => {
    const x = inst({});
    const doc = toCase(x, collectHandles(x.changes.map((c) => c.change_discussion.discussion_summary)));
    const parsed = parseEvalCase(doc, "swr.yaml");
    expect(parsed.id).toBe("swr-psf-requests-2258");
    expect(parsed.pull_request).toMatchObject({ repo: "psf-requests", head: "c".repeat(40), base: "a".repeat(40) });
    expect(parsed.pull_request?.body).toBe("Thanks @user for the idea. Uses @pytest.mark.skipif.");
    expect(parsed.checks[0]).toMatchObject({
      kind: "planted",
      golden: [
        { category: "bug", severity: "F.1 Interface" },
        { category: "style", severity: "E.1.1 Textual Changes", comment: "The author fixed a typo." },
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/kevinburke|Lukasa/);
  });

  it("turns a clean PR into a control case", () => {
    const clean = toCase(inst({ change_introduced: false, changes: [] }), new Set());
    expect(parseEvalCase(clean, "swr.yaml").checks[0]).toMatchObject({ kind: "control", golden: [] });
  });

  it("spreads the subset over repos, newest first, and skips clean-looking PRs that carry changes", () => {
    const a1 = inst({ repo: "a/a", instance_id: "a__a-1", created_at: "2020" });
    const a2 = inst({ repo: "a/a", instance_id: "a__a-2", created_at: "2021" });
    const b1 = inst({ repo: "b/b", instance_id: "b__b-1", created_at: "2019" });
    expect(spreadPick([a1, a2, b1], 2).map((x) => x.instance_id)).toEqual(["a__a-2", "b__b-1"]);
    const styleOnly = inst({ instance_id: "s__s-1", changes: [{ change_type: "E.2 Visual Representation", change_discussion: { discussion_summary: "s" } }] });
    const odd = inst({ instance_id: "o__o-1", change_introduced: false });
    const picked = selectSubset([a1, styleOnly, odd, inst({ instance_id: "c__c-1", change_introduced: false, changes: [] })], 5, 5);
    expect(picked.map((x) => x.instance_id)).toEqual(["a__a-1", "c__c-1"]);
  });
});
