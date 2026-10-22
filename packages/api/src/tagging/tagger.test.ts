import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { applyAppMigrations, missingSchemaRepairs, type AppDb } from "../lib/drizzle.js";
import { tagDimensionState, tagJobs, tagKeys, tagLabels } from "../schema/index.js";
import { capSubjectText, defineDimension, normalizeKey, type Dimension, type TagSubject } from "./dimension.js";
import type { Classify } from "./classifier.js";
import { Tagger } from "./tagger.js";
import { toolIntentDimension } from "./tool-intent.js";

let db: AppDb;
beforeEach(async () => { db = (await freshTestPgDb()).appDb; });
const subject = (id: string, text = "Read reference material to answer the question.", userId = "alice"): TagSubject => ({ type: "external_call", id, text, userId, ownerType: "user", ownerId: userId });
const choice = (key: string, count = 1, newKeys: { key: string; label: string; definition: string }[] = []) => ({ text: JSON.stringify({ subjects: Array.from({ length: count }, (_, index) => ({ index, labels: [{ key, confidence: 0.9 }] })), newKeys }), model: "mock-small" });
const newKey = { key: "customer_support", label: "Customer support", definition: "Help customers resolve account and product questions." };
function setup(dimension: Dimension = toolIntentDimension, classify: Classify = vi.fn<Classify>(async request => choice("research_lookup", request.subjects.length))) {
  const rendered = new Map<string, TagSubject>();
  const tagger = new Tagger({ db, orgId: "org", dimensions: [dimension], classify,
    renderers: new Map([["external_call", async refs => refs.flatMap(ref => { const row = rendered.get(ref.id); return row ? [row] : []; })]]) });
  return { tagger, classify, rendered };
}
const smallDimension = (overrides: Partial<Dimension> = {}) => defineDimension({ id: "custom", mode: "single", open: true, seeds: [{ key: "lookup", label: "Lookup", definition: "Look up facts." }], instructions: "Classify purposes.", subjectTypes: ["external_call"], ...overrides });

describe("tag dimensions and registry", () => {
  it("normalizes keys, pins limits, and rejects duplicate seeds", () => {
    expect(normalizeKey(" Customer Support! ")).toBe("customer_support");
    expect(normalizeKey("a".repeat(40))).toHaveLength(32);
    expect(smallDimension().maxActiveKeys).toBe(100);
    expect(() => smallDimension({ seeds: [{ key: "x", label: "X", definition: "X" }, { key: "x", label: "X", definition: "X" }] })).toThrow("unique");
    expect(capSubjectText("😀".repeat(500))).toHaveLength(512);
  });
  it("is unique per organization and dimension, not across dimensions", async () => {
    const { tagger } = setup();
    await Promise.all([tagger.initialize("tool_intent"), tagger.initialize("tool_intent")]);
    expect(await db.select().from(tagKeys)).toHaveLength(13);
    await setup(smallDimension({ id: "second" })).tagger.initialize("second");
    expect((await db.select().from(tagKeys)).filter(key => key.key === "other")).toHaveLength(2);
  });
  it("promotes a provisional key at two distinct users", async () => {
    const model = vi.fn<Classify>(async request => choice(newKey.key, request.subjects.length, [newKey]));
    const { tagger } = setup(toolIntentDimension, model);
    await tagger.tag("tool_intent", [subject("one")]);
    expect((await tagger.registry.list("tool_intent")).find(row => row.key === newKey.key)?.status).toBe("provisional");
    await tagger.tag("tool_intent", [subject("two", "Help a customer understand their account.", "bob")]);
    expect((await tagger.registry.list("tool_intent")).find(row => row.key === newKey.key)).toMatchObject({ status: "active", assignments: 2, users: 2 });
  });
  it("promotes at five assignments and deduplicates proposals within a batch", async () => {
    const { tagger } = setup(toolIntentDimension, async request => choice(newKey.key, request.subjects.length, [newKey, { ...newKey, key: "Customer Support" }]));
    await tagger.tag("tool_intent", Array.from({ length: 5 }, (_, i) => subject(String(i), `Help customer ${i} with an account question.`)));
    const keys = await tagger.registry.list("tool_intent");
    expect(keys.filter(key => key.key === newKey.key)).toHaveLength(1);
    expect(keys.find(key => key.key === newKey.key)).toMatchObject({ status: "active", assignments: 5, users: 1 });
    expect(keys.find(key => key.key === newKey.key)?.examples).toHaveLength(3);
  });
  it("resolves merge chains at read time without rewriting labels and rejects cycles", async () => {
    const { tagger } = setup();
    await tagger.tag("tool_intent", [subject("one")]);
    await tagger.registry.merge("tool_intent", "research_lookup", "knowledge_memory");
    await expect(tagger.registry.merge("tool_intent", "knowledge_memory", "research_lookup")).rejects.toThrow("cycle");
    await tagger.registry.merge("tool_intent", "knowledge_memory", "other");
    expect(await tagger.labelsFor("external_call", "one")).toEqual([expect.objectContaining({ key: "other", originalKey: "research_lookup" })]);
    expect((await db.select().from(tagLabels))[0]?.key).toBe("research_lookup");
    expect(await tagger.aggregate("tool_intent")).toEqual([{ key: "other", calls: 1 }]);
    await expect(tagger.registry.merge("tool_intent", "other", "code_change")).rejects.toThrow("terminal");
    await tagger.registry.edit("tool_intent", "other", { label: "Other purpose", definition: "No matching class." });
    expect((await tagger.registry.list("tool_intent")).find(key => key.key === "other")?.label).toBe("Other purpose");
  });
});

describe("classifier contract", () => {
  it("shows definitions, counts, domain instructions, and creation permission only for open registries", async () => {
    const model = vi.fn<Classify>(async request => choice("lookup", request.subjects.length));
    await setup(smallDimension({ open: false }), model).tagger.tag("custom", [subject("one")]);
    expect(model.mock.calls[0]?.[0].prompt).toContain("This registry is closed");
    expect(model.mock.calls[0]?.[0].prompt).not.toContain("You may create");
    expect(model.mock.calls[0]?.[0].prompt).toContain('"assignments":0');
    expect(model.mock.calls[0]?.[0].prompt).toContain("Look up facts.");
  });
  it.each(["garbage", JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "missing", confidence: 0.9 }] }] }), JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "lookup", confidence: 3 }] }] })])("falls back to other for invalid single output %s", async text => {
    const { tagger } = setup(smallDimension({ open: false }), async () => ({ text, model: "mock" }));
    await tagger.tag("custom", [subject("one")]);
    expect(await tagger.labelsFor("external_call", "one")).toEqual([expect.objectContaining({ key: "other" })]);
  });
  it("enforces exactly one label in single mode and allows zero or several in multi mode", async () => {
    const result = { text: JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "lookup", confidence: 1 }, { key: "other", confidence: 0.5 }, { key: "missing", confidence: 1 }] }] }), model: "mock" };
    const one = setup(smallDimension(), async () => result).tagger;
    await one.tag("custom", [subject("one")]);
    expect((await one.labelsFor("external_call", "one")).map(row => row.key)).toEqual(["other"]);
    const multi = setup(smallDimension({ id: "multi", mode: "multi" }), async () => result).tagger;
    await multi.tag("multi", [subject("two"), subject("three")]);
    expect((await multi.labelsFor("external_call", "two")).map(row => row.key).sort()).toEqual(["lookup", "other"]);
    expect(await multi.labelsFor("external_call", "three")).toEqual([]);
  });
  it("deduplicates multi tags when a merge makes them the same key", async () => {
    const result = { text: JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "lookup", confidence: 1 }, { key: "other", confidence: 0.5 }] }] }), model: "mock" };
    const { tagger } = setup(smallDimension({ mode: "multi" }), async () => result);
    await tagger.tag("custom", [subject("one")]);
    await tagger.registry.merge("custom", "lookup", "other");
    expect(await db.select().from(tagLabels)).toHaveLength(2);
    expect(await tagger.labelsFor("external_call", "one")).toHaveLength(1);
    expect(await tagger.aggregate("custom")).toEqual([{ key: "other", calls: 1 }]);
  });
  it("never creates proposed keys in a closed registry", async () => {
    const { tagger } = setup(smallDimension({ open: false }), async () => choice(newKey.key, 1, [newKey]));
    await tagger.tag("custom", [subject("one")]);
    expect(await tagger.registry.list("custom")).toHaveLength(2);
    expect((await tagger.labelsFor("external_call", "one"))[0]?.key).toBe("other");
  });
  it("stops creation at the registry cap and raises consolidation due", async () => {
    const { tagger } = setup(smallDimension({ maxActiveKeys: 2 }), async () => choice(newKey.key, 1, [newKey]));
    await tagger.tag("custom", [subject("one")]);
    expect((await db.select().from(tagDimensionState))[0]?.consolidationDue).toBe(true);
    expect(await tagger.registry.list("custom")).toHaveLength(2);
  });
  it("runs rules first and leaves unknown blank CLI subjects unlabeled", async () => {
    const model = vi.fn<Classify>();
    const { tagger } = setup(toolIntentDimension, model);
    await tagger.tag("tool_intent", [{ ...subject("one", ""), command: "threads list" }, { ...subject("two", ""), command: "tools search" }]);
    expect(model).not.toHaveBeenCalled();
    expect(await tagger.labelsFor("external_call", "one")).toEqual([expect.objectContaining({ key: "delegation", model: "rule", confidence: 1 })]);
    expect(await tagger.labelsFor("external_call", "two")).toEqual([]);
  });
});

describe("durable worker", () => {
  it("bounds runs to 50, skips unchanged inputs, and re-tags changed text", async () => {
    const { tagger, rendered, classify } = setup();
    const refs = Array.from({ length: 51 }, (_, i) => ({ type: "external_call", id: String(i) }));
    refs.forEach(ref => rendered.set(ref.id, subject(ref.id)));
    await tagger.enqueueTagging("tool_intent", refs);
    expect(await tagger.drain("tool_intent")).toBe(50);
    expect(await db.select().from(tagJobs)).toHaveLength(1);
    expect(await tagger.drain("tool_intent")).toBe(1);
    expect(classify).toHaveBeenCalledTimes(2);
    await tagger.enqueueTagging("tool_intent", refs.slice(0, 1)); await tagger.drain("tool_intent");
    expect(classify).toHaveBeenCalledTimes(2);
    rendered.set("0", subject("0", "Look up a changed question."));
    await tagger.enqueueTagging("tool_intent", refs.slice(0, 1)); await tagger.drain("tool_intent");
    expect(classify).toHaveBeenCalledTimes(3);
    await expect(tagger.tag("tool_intent", [...rendered.values()])).rejects.toThrow("50");
  });
  it("serializes concurrent workers and keeps an enqueue that arrives during classification", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const model = vi.fn(async () => { await pending; return choice("research_lookup"); });
    const { tagger, rendered } = setup(toolIntentDimension, model);
    rendered.set("one", subject("one"));
    const refs = [{ type: "external_call", id: "one" }];
    await tagger.enqueueTagging("tool_intent", refs);
    const first = tagger.drain("tool_intent");
    await vi.waitFor(() => expect(model).toHaveBeenCalledOnce());
    expect(await tagger.drain("tool_intent")).toBe(0);
    await tagger.enqueueTagging("tool_intent", refs);
    release?.(); await first;
    expect(await db.select().from(tagJobs)).toHaveLength(1);
    await tagger.drain("tool_intent");
    expect(model).toHaveBeenCalledOnce();
  });
  it("backs off failures without persisting input or exception text", async () => {
    const { tagger, rendered } = setup(toolIntentDimension, async () => { throw new Error("private provider payload"); });
    rendered.set("one", subject("one"));
    await tagger.enqueueTagging("tool_intent", [{ type: "external_call", id: "one" }]);
    await expect(tagger.drain("tool_intent")).rejects.toThrow();
    const [job] = await db.select().from(tagJobs);
    expect(job?.attempts).toBe(1);
    expect(JSON.stringify(job)).not.toContain("private");
    expect(await tagger.drain("tool_intent")).toBe(0);
  });
  it("re-runs other once when a new key is created", async () => {
    const model = vi.fn<Classify>().mockResolvedValueOnce(choice("other")).mockResolvedValue(choice(newKey.key, 1, [newKey]));
    const { tagger, rendered } = setup(toolIntentDimension, model);
    rendered.set("old", subject("old"));
    await tagger.tag("tool_intent", [subject("old")]);
    await tagger.tag("tool_intent", [subject("new")]);
    expect(await db.select().from(tagJobs)).toEqual([expect.objectContaining({ subjectId: "old", force: true })]);
    await tagger.drain("tool_intent");
    expect((await tagger.labelsFor("external_call", "old"))[0]?.key).toBe(newKey.key);
    expect(await db.select().from(tagJobs)).toEqual([]);
    expect(model).toHaveBeenCalledTimes(3);
  });
  it("rejects a stale worker's writes after its dimension lease was replaced", async () => {
    const model: Classify = async () => {
      await db.update(tagDimensionState).set({ leaseToken: "replacement", leaseUntil: Date.now() + 120000 });
      return choice("research_lookup");
    };
    await expect(setup(toolIntentDimension, model).tagger.tag("tool_intent", [subject("one")])).rejects.toThrow("lease expired");
    expect(await db.select().from(tagLabels)).toHaveLength(0);
  });
});

const GOLDEN = [
  ["Implement the login timeout fix and add a regression test.", "code_change"],
  ["Review the payment PR for unsafe retries.", "code_review"],
  ["Investigate why the production alert fired.", "debug_investigate"],
  ["Find the SDK documentation to answer the integration question.", "research_lookup"],
  ["Send the release announcement to the team.", "communicate"],
  ["Create an issue to track the customer bug.", "project_tracking"],
  ["Compare weekly usage to find the largest increase.", "data_analysis"],
  ["Check calendars so we can schedule the design review.", "scheduling"],
  ["Create a workflow to publish the weekly report.", "automation_setup"],
  ["Save this team convention so future work follows it.", "knowledge_memory"],
  ["Delegate the test migration to another assistant.", "delegation"],
  ["Deploy the reviewed build to staging.", "deploy_ops"],
] as const;
it("matches the 12-intent golden set through the mocked batch model", async () => {
  const model: Classify = async request => ({ model: "golden-mock", text: JSON.stringify({ subjects: request.subjects.map((row, index) => ({ index, labels: [{ key: GOLDEN.find(([text]) => text === row.text)?.[1] ?? "other", confidence: 1 }] })) }) });
  const { tagger } = setup(toolIntentDimension, model);
  await tagger.tag("tool_intent", GOLDEN.map(([text], index) => subject(String(index), text)));
  for (const [index, [, key]] of GOLDEN.entries()) expect((await tagger.labelsFor("external_call", String(index)))[0]?.key).toBe(key);
});

it("repairs deployed databases without replaying 0000 and keeps steady-state boot lock-free", async () => {
  const fixture = await freshTestPgDb();
  await fixture.pgdb.query("DROP VIEW tag_resolved_labels");
  await fixture.pgdb.query("DROP TABLE tag_keys, tag_labels, tag_subjects, tag_jobs, tag_dimension_state");
  await applyAppMigrations(fixture.pgdb);
  expect(await missingSchemaRepairs(fixture.pgdb)).toEqual([]);
  await setup().tagger.tag("tool_intent", [subject("repaired")]);
});
