import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { applyAppMigrations, missingSchemaRepairs, type AppDb } from "../lib/drizzle.js";
import { tagDimensionState, tagJobs, tagKeys, tagLabels, tagSubjects } from "../schema/index.js";
import { capSubjectText, defineDimension, normalizeKey, type Dimension, type TagSubject } from "./dimension.js";
import type { Classify } from "./classifier.js";
import { Tagger } from "./tagger.js";
import { toolIntentDimension } from "./tool-intent.js";

let db: AppDb;
beforeEach(async () => { db = (await freshTestPgDb()).appDb; });
const subject = (id: string, text = "Read reference material to answer the question.", userId = "alice"): TagSubject => ({ type: "external_call", id, text, userId, ownerType: "team", ownerId: "team" });
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
  it("keeps a two-user proposal provisional until ten assignments across two owner principals", async () => {
    const model = vi.fn<Classify>(async request => choice(newKey.key, request.subjects.length, [newKey]));
    const { tagger } = setup(toolIntentDimension, model);
    await tagger.tag("tool_intent", [subject("one"), subject("two", "Help a customer understand their account.", "bob")]);
    expect((await tagger.registry.list("tool_intent")).find(row => row.key === newKey.key)).toMatchObject({ status: "provisional", assignments: 2, owners: 1 });
    await tagger.tag("tool_intent", Array.from({ length: 8 }, (_, i) => subject(`same-${i}`)));
    expect((await tagger.registry.list("tool_intent")).find(row => row.key === newKey.key)).toMatchObject({ status: "provisional", assignments: 10, owners: 1 });
    await tagger.tag("tool_intent", [{ ...subject("other-owner"), ownerType: "user", ownerId: "team" }]);
    expect((await tagger.registry.list("tool_intent")).find(row => row.key === newKey.key)).toMatchObject({ status: "active" });
  });
  it("deduplicates proposals and keeps five assignments provisional", async () => {
    const { tagger } = setup(toolIntentDimension, async request => choice(newKey.key, request.subjects.length, [newKey, { ...newKey, key: "Customer Support" }]));
    await tagger.tag("tool_intent", Array.from({ length: 5 }, (_, i) => subject(String(i), `Help customer ${i} with an account question.`, i % 2 ? "bob" : "alice")));
    const keys = await tagger.registry.list("tool_intent");
    expect(keys.filter(key => key.key === newKey.key)).toHaveLength(1);
    expect(keys.find(key => key.key === newKey.key)).toMatchObject({ status: "provisional", assignments: 5 });
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
  it.each([JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "missing", confidence: 0.9 }] }] })])("falls back to other for invalid single output %s", async text => {
    const { tagger } = setup(smallDimension({ open: false }), async () => ({ text, model: "mock" }));
    await tagger.tag("custom", [subject("one")]);
    expect(await tagger.labelsFor("external_call", "one")).toEqual([expect.objectContaining({ key: "other" })]);
  });
  it("enforces exactly one label in single mode and allows zero or several in multi mode", async () => {
    const result = { text: JSON.stringify({ subjects: [{ index: 0, labels: [{ key: "lookup", confidence: 1 }, { key: "other", confidence: 0.5 }, { key: "missing", confidence: 1 }] }] }), model: "mock" };
    const one = setup(smallDimension(), async () => result).tagger;
    await one.tag("custom", [subject("one")]);
    expect((await one.labelsFor("external_call", "one")).map(row => row.key)).toEqual([]);
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
    const { tagger } = setup(smallDimension({ maxActiveKeys: 2 }), async request => choice(newKey.key, request.subjects.length, [newKey]));
    await tagger.tag("custom", [subject("one"), subject("two", "A new purpose.", "bob")]);
    expect((await db.select().from(tagDimensionState))[0]?.consolidationDue).toBe(true);
    expect(await tagger.registry.list("custom")).toHaveLength(2);
  });
  it("runs rules first and leaves unknown blank CLI subjects unlabeled", async () => {
    const model = vi.fn<Classify>();
    const { tagger } = setup(toolIntentDimension, model);
    await tagger.tag("tool_intent", [{ ...subject("one", ""), command: "threads list" }, { ...subject("two", ""), command: "tools search" }, { ...subject("status", ""), command: "status" }]);
    expect(model).not.toHaveBeenCalled();
    expect(await tagger.labelsFor("external_call", "one")).toEqual([expect.objectContaining({ key: "delegation", model: "rule", confidence: 1 })]);
    expect(await tagger.labelsFor("external_call", "two")).toEqual([]);
    expect((await tagger.labelsFor("external_call", "status"))[0]?.key).toBe("other");
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
// Fixed provider recordings, addressed by input bytes rather than expected position.
const CANNED: Record<string, string> = {
  "9da81e15bae235cc57c86a5450a445d803cd9029f21816596988e0222852c890": '{"labels":[{"key":"code_change","confidence":1}]}',
  "6e4f5c2d0ebd6c75edbe45aeb12dfe20878e2e401cfad3e6f1de04341aa9fbf8": '{"labels":[{"key":"code_review","confidence":1}]}',
  "eb68d63c3c8201298e7763477ee5894d28001c4003a14b92d5542516e81d2a97": '{"labels":[{"key":"debug_investigate","confidence":1}]}',
  "1ffe56157f8aaf378578b1f54533bffe27ddd6485c2e73c31a4b570ddeb2c55e": '{"labels":[{"key":"research_lookup","confidence":1}]}',
  "a7dc78a751ed5a1b3ed81683deaf09e9d9eaf5f3e94cd5ce09fef82c5041b06d": '{"labels":[{"key":"communicate","confidence":1}]}',
  "e3a830f5ffb6662ef4cec27b9f2b38ffc730a12e05578e11f919d7f4a36fe529": '{"labels":[{"key":"project_tracking","confidence":1}]}',
  "8ca038f4b71402ecfab1e2d93eedb6598f8eb211ce3d71a92c6ac8252932fbd6": '{"labels":[{"key":"data_analysis","confidence":1}]}',
  "9c4d5c29aa7fdf254ab746a937b9be8d1583e74b49f01faf2e656c3efe257d2f": '{"labels":[{"key":"scheduling","confidence":1}]}',
  "e6112259e680efd86d4ce5683eba8530683dd555831a655b496cc645ec22a79e": '{"labels":[{"key":"automation_setup","confidence":1}]}',
  "60f6f81c3048f14679eb1584a3b7328d406a10b0b0d5c8c4edde04e46475f89a": '{"labels":[{"key":"knowledge_memory","confidence":1}]}',
  "04d283b7da4d0f30a812731c910d9645b0da1420038e9c0a48b1ac2d8e2ff9b0": '{"labels":[{"key":"delegation","confidence":1}]}',
  "e3a1ff529bb99178c5a125cefd0b3e0ba3f95ee53ecd835dbd98dec8c0dbda88": '{"labels":[{"key":"deploy_ops","confidence":1}]}',
};
it("matches reordered input hashes and handles a deliberately wrong canned answer", async () => {
  const wrongText = "A deliberately misclassified recording.";
  const recordings = { ...CANNED, [createHash("sha256").update(wrongText).digest("hex")]: '{"labels":[{"key":"not_registered","confidence":1}]}' };
  const model: Classify = async request => ({ model: "golden-mock", text: JSON.stringify({
    subjects: request.subjects.map((item, index) => ({ index, ...JSON.parse(recordings[createHash("sha256").update(item.text).digest("hex")] ?? '{"labels":[{"key":"other","confidence":0}]}') })) }) });
  const { tagger } = setup(toolIntentDimension, model);
  const reordered = [...GOLDEN].reverse();
  await tagger.tag("tool_intent", reordered.map(([text], index) => subject(String(index), text)));
  for (const [index, [, key]] of reordered.entries()) expect((await tagger.labelsFor("external_call", String(index)))[0]?.key).toBe(key);
  await tagger.tag("tool_intent", [subject("wrong", wrongText), subject("changed", GOLDEN[0][0] + " Changed.")]);
  expect((await tagger.labelsFor("external_call", "wrong"))[0]?.key).toBe("other");
  expect((await tagger.labelsFor("external_call", "changed"))[0]?.key).not.toBe(GOLDEN[0][1]);
  // A valid but semantically wrong provider answer must not make the golden check pass.
  const implementationHash = createHash("sha256").update(GOLDEN[0][0]).digest("hex");
  recordings[implementationHash] = '{"labels":[{"key":"code_review","confidence":1}]}';
  await tagger.tag("tool_intent", [subject("semantic-error", GOLDEN[0][0])]);
  const wrongKey = (await tagger.labelsFor("external_call", "semantic-error"))[0]?.key;
  expect(wrongKey).toBe("code_review"); expect(wrongKey).not.toBe(GOLDEN[0][1]);
});

it("repairs deployed databases without replaying 0000 and keeps steady-state boot lock-free", async () => {
  const fixture = await freshTestPgDb();
  await fixture.pgdb.query("DROP VIEW tag_resolved_labels");
  await fixture.pgdb.query("DROP TABLE tag_keys, tag_labels, tag_subjects, tag_jobs, tag_dimension_state");
  await applyAppMigrations(fixture.pgdb);
  expect(await missingSchemaRepairs(fixture.pgdb)).toEqual([]);
  await setup().tagger.tag("tool_intent", [subject("repaired")]);
});

it("does not count automated team subjects as distinct users for key promotion", async () => {
  const { tagger } = setup(toolIntentDimension, async request => choice(newKey.key, request.subjects.length, [newKey]));
  await tagger.tag("tool_intent", ["one", "two"].map(id => ({ ...subject(id), userId: null, ownerType: "team", ownerId: "team" })));
  expect((await tagger.registry.list("tool_intent")).find(key => key.key === newKey.key)).toBeUndefined();
  expect((await db.select().from(tagSubjects)).every(row => row.userId === null)).toBe(true);
});

it("renews the lease between slow owner groups without reviving an expired token", async () => {
  const start = Date.now(); let now = start;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const model: Classify = async req => { now += 29_000; return choice("research_lookup", req.subjects.length); };
  try {
    const { tagger, rendered } = setup(toolIntentDimension, model);
    const subjects = Array.from({ length: 6 }, (_, i) => ({ ...subject(String(i)), ownerId: `team-${i}` }));
    subjects.forEach(item => rendered.set(item.id, item));
    await tagger.enqueueTagging("tool_intent", subjects);
    expect(await tagger.drain("tool_intent")).toBe(6);
    expect(await db.select().from(tagLabels)).toHaveLength(6);
    expect(now - start).toBeGreaterThan(120_000);
  } finally { clock.mockRestore(); }
});

it("requires ten assignments even after a second team principal contributes", async () => {
  const { tagger } = setup(toolIntentDimension, async req => choice(newKey.key, req.subjects.length, [newKey]));
  await tagger.tag("tool_intent", [subject("a"), subject("b", "Support the customer.", "bob")]);
  await tagger.tag("tool_intent", Array.from({ length: 7 }, (_, i) => ({ ...subject(`second-${i}`), ownerId: "second-team" })));
  expect((await tagger.registry.list("tool_intent")).find(row => row.key === newKey.key)).toMatchObject({ status: "provisional", assignments: 9, owners: 2 });
  await tagger.tag("tool_intent", [{ ...subject("tenth"), ownerId: "second-team" }]);
  expect((await tagger.registry.list("tool_intent")).find(row => row.key === newKey.key)).toMatchObject({ status: "active" });
});
it("repairs owner columns on an existing subject table", async () => {
  const fixture = await freshTestPgDb();
  await fixture.pgdb.query("ALTER TABLE tag_subjects DROP COLUMN owner_type, DROP COLUMN owner_id");
  await applyAppMigrations(fixture.pgdb);
  expect(await missingSchemaRepairs(fixture.pgdb)).toEqual([]);
});

it("stores classifier proposals with invalid Unicode without losing the batch", async () => {
  const { tagger } = setup(toolIntentDimension, async request => choice(newKey.key, request.subjects.length,
    [{ ...newKey, label: "Customer\u0000 support \ud800😀", definition: "Help\udfff customers." }]));
  await tagger.tag("tool_intent", [subject("one"), subject("two", "Help a customer.", "bob")]);
  expect((await tagger.registry.list("tool_intent")).find(key => key.key === newKey.key))
    .toMatchObject({ label: "Customer support 😀", definition: "Help customers.", assignments: 2 });
});

it("sanitizes administrator key edits and rejects labels empty after sanitation", async () => {
  const { tagger } = setup();
  await tagger.initialize("tool_intent");
  await tagger.registry.edit("tool_intent", "other", { label: "Other\u0000\ud800 😀", definition: "Unmatched\udfff purposes." });
  expect((await tagger.registry.list("tool_intent")).find(key => key.key === "other"))
    .toMatchObject({ label: "Other 😀", definition: "Unmatched purposes." });
  await expect(tagger.registry.edit("tool_intent", "other", { label: "\u0000\ud800", definition: "Valid definition." }))
    .rejects.toThrow("Use a label");
});
