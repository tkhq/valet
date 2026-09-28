import { describe, expect, it } from "vitest";
import { DOCS } from "./brain-data.js";
import { SECTIONS, getDoc, listDocs, render, search, tokenize } from "./search.js";
import { brainActions } from "./actions.js";

describe("brain bundle", () => {
  it("ships entries and withholds confidential ones", () => {
    expect(DOCS.length).toBeGreaterThan(50);
    expect(DOCS.filter((d) => d.sensitivity === "confidential")).toEqual([]);
    expect(SECTIONS).toContain("03-clients");
  });
});

describe("search", () => {
  it("drops the brain's stopwords and one-character tokens", () => {
    // Same stopword list as xors-brain/tools/brainlib.py, which keeps "what".
    expect(tokenize("Is the status of a Anodyne x deal?")).toEqual(["status", "anodyne", "deal"]);
  });

  it("ranks the client dossier first for its own name", () => {
    const hits = search("anodyne medicare compliance", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.doc.id).toBe("anodyne-health");
    expect(hits[0]!.score).toBeGreaterThan(hits[hits.length - 1]!.score);
  });

  it("honours the section filter and the limit", () => {
    const hits = search("client", { section: "03-clients", limit: 3 });
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits.every((h) => h.doc.section === "03-clients")).toBe(true);
  });

  it("returns nothing for a query with no matching term", () => {
    expect(search("zzzqqqnotaterm")).toEqual([]);
  });

  it("renders metadata and body", () => {
    const doc = getDoc("anodyne-health")!;
    const text = render(doc);
    expect(text).toContain("(id: anodyne-health)");
    expect(text).toContain("sensitivity: internal");
    expect(text.length).toBeGreaterThan(doc.summary.length);
  });
});

describe("actions", () => {
  const byId = new Map(brainActions.actions.map((a) => [a.id, a]));
  const ctx = {} as Parameters<(typeof brainActions.actions)[number]["execute"]>[1];

  it("exposes three low-risk brain actions", () => {
    expect([...byId.keys()]).toEqual(["brain.search", "brain.get", "brain.list"]);
    expect(brainActions.actions.every((a) => a.riskLevel === "low")).toBe(true);
    expect(brainActions.requiresCredential).toBeUndefined();
  });

  it("brain.search returns ranked ids", async () => {
    const result = await byId.get("brain.search")!.execute({ query: "anodyne", limit: 2 }, ctx);
    expect(result.success).toBe(true);
    expect(String(result.data)).toContain("anodyne-health");
  });

  it("brain.get reports a missing id instead of failing", async () => {
    const result = await byId.get("brain.get")!.execute({ ids: ["anodyne-health", "no-such-entry"] }, ctx);
    expect(String(result.data)).toContain("# Anodyne");
    expect(String(result.data)).toContain("Not found");
  });

  it("brain.list covers every bundled entry", async () => {
    const result = await byId.get("brain.list")!.execute({}, ctx);
    expect(String(result.data).split("\n")).toHaveLength(listDocs().length);
  });

  it("rejects arguments that miss the schema", async () => {
    const result = await byId.get("brain.search")!.execute({ limit: 2 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid");
  });
});
