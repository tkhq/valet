import { describe, expect, it } from "vitest";
import { gateFinding, similarity } from "../src/gate.js";
import type { FindingRecord, FindingOutcome } from "../src/records.js";

const rec = (number: number, result: FindingOutcome, over: Partial<FindingRecord> = {}): FindingRecord => ({
  repo: "acme/site", number, id: "f1", title: "Timeout looks short in fetch client", body: "The fetch client timeout of two seconds may cut slow responses.",
  severity: "low", category: "performance", path: "src/net/client.ts", line: 10, placement: "inline", head: "1".repeat(40), at: "2026-11-10T00:00:00Z", rules: [],
  outcome: { result, merged: true, closedHead: "2".repeat(40), at: "2026-11-11T00:00:00Z" }, ...over,
});
const finding = { title: "Fetch client timeout looks short", body: "A two second timeout in the fetch client may cut slow responses.", path: "src/net/retry.ts", category: "performance" as const, severity: "low" as const };

describe("outcome gate", () => {
  it("scores shared words, with a bonus for the same directory and category", () => {
    const near = similarity(finding, rec(1, "ignored"));
    const far = similarity(finding, rec(1, "ignored", { title: "Null deref in parse", body: "An empty input makes parse read undefined.", path: "lib/parse.ts", category: "bug" }));
    expect(near).toBeGreaterThan(0.35);
    expect(far).toBeLessThan(0.2);
  });

  it("moves a finding like three unaddressed ones on distinct merged pull requests", () => {
    expect(gateFinding(finding, [rec(1, "ignored"), rec(2, "rejected"), rec(3, "ignored")])).toEqual({ suppress: true, unaddressed: 3, addressed: 0 });
  });

  it("keeps it when authors addressed three similar ones, or when the repeats share one pull request", () => {
    const addressed = [rec(4, "addressed"), rec(5, "addressed"), rec(6, "addressed")];
    expect(gateFinding(finding, [rec(1, "ignored"), rec(2, "ignored"), rec(3, "ignored"), ...addressed]).suppress).toBe(false);
    expect(gateFinding(finding, [rec(1, "ignored"), rec(1, "ignored", { id: "f2" }), rec(1, "ignored", { id: "f3" })]).suppress).toBe(false);
  });

  it("ignores unmerged, shadow and same-pull-request records", () => {
    const unmerged = (n: number) => rec(n, "ignored", { outcome: { result: "ignored", merged: false, closedHead: "x", at: "y" } });
    expect(gateFinding(finding, [unmerged(1), unmerged(2), unmerged(3)]).suppress).toBe(false);
    expect(gateFinding(finding, [rec(1, "ignored", { shadow: true }), rec(2, "ignored", { shadow: true }), rec(3, "ignored", { shadow: true })]).suppress).toBe(false);
    expect(gateFinding(finding, [rec(7, "ignored"), rec(8, "ignored"), rec(9, "ignored")], undefined, 9).suppress).toBe(false);
  });

  it("never moves a high, critical or security finding", () => {
    const history = [rec(1, "ignored"), rec(2, "ignored"), rec(3, "ignored")];
    expect(gateFinding({ ...finding, severity: "high" }, history).suppress).toBe(false);
    expect(gateFinding({ ...finding, category: "security" }, history.map((r) => ({ ...r, category: "security" as const }))).suppress).toBe(false);
  });
});
