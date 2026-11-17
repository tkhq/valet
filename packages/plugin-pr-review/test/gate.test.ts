import { describe, expect, it } from "vitest";
import type { PluginStoreDoc, ScopedPluginStore } from "@valet/engine";
import { gateFinding, repoHistory, similarity } from "../src/gate.js";
import type { FindingRecord, FindingOutcome } from "../src/records.js";

const rec = (number: number, result: FindingOutcome, over: Partial<FindingRecord> = {}): FindingRecord => ({
  repo: "acme/site", number, id: "f1", title: "Timeout looks short in fetch client", body: "The fetch client timeout of two seconds may cut slow responses.",
  severity: "low", category: "performance", path: "src/net/client.ts", line: 10, placement: "inline", head: "1".repeat(40), at: "2026-11-10T00:00:00Z", rules: [],
  outcome: { result, merged: true, closedHead: "2".repeat(40), at: "2026-11-11T00:00:00Z" }, ...over,
});
/** A store that pages records in key order, as the real store does. */
class PagedStore implements ScopedPluginStore {
  constructor(private readonly keyed: { key: string; doc: FindingRecord }[]) {}
  async get(): Promise<null> {
    return null;
  }
  async put(): Promise<never> {
    throw new Error("the gate only reads");
  }
  async delete(): Promise<boolean> {
    return false;
  }
  async list<T>(_collection: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ items: PluginStoreDoc<T>[]; nextCursor: string | null }> {
    const start = opts.cursor ? Number(opts.cursor) : 0;
    const end = start + (opts.limit ?? 1000);
    // Test-only store: every key holds a FindingRecord, the type the gate reads.
    const items = this.keyed.slice(start, end).map(({ key, doc }) => ({ key, doc, revision: 1, createdAt: 0, updatedAt: 0 }) as PluginStoreDoc<T>);
    return { items, nextCursor: end < this.keyed.length ? String(end) : null };
  }
}

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
  it("ignores findings that were never an open finding, so the gate does not feed on itself", () => {
    for (const placement of ["suppressed", "unsupported", "unconfirmed"] as const) {
      expect(gateFinding(finding, [rec(1, "ignored", { placement }), rec(2, "ignored", { placement }), rec(3, "ignored", { placement })]).suppress).toBe(false);
    }
    expect(gateFinding(finding, [rec(1, "ignored", { placement: "outside" }), rec(2, "ignored"), rec(3, "ignored")]).suppress).toBe(true);
  });

  it("keeps the newest records by close time, whatever their key order", async () => {
    const docs = Array.from({ length: 2500 }, (_, i) => rec(i + 1, "ignored", { outcome: { result: "ignored", merged: true, closedHead: "2".repeat(40), at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() } }));
    const keyed = docs.map((doc) => ({ key: `acme/site#${doc.number}/f1`, doc })).sort((a, b) => a.key.localeCompare(b.key));
    const store = new PagedStore(keyed);
    const history = await repoHistory(store, "acme/site");
    expect(history).toHaveLength(2000);
    expect(history[0].number).toBe(2500);
    expect(Math.min(...history.map((r) => r.number))).toBe(501);
  });
});
