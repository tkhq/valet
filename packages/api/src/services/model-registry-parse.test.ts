/**
 * Runtime model-registry parsing (TKAI-327). These are the rules that decide
 * what a REMOTE payload may put in front of a user, so they are pinned
 * directly: a malformed entry is skipped, never guessed at, and a payload
 * this code cannot read yields an empty list, which every caller reads as
 * "keep the bundled catalog".
 */
import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { isRegistryModel, parseLastModified, parseRemoteCatalog } from "./model-registry-parse.js";

/** A complete, valid model record — the baseline each test perturbs. */
function validModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "claude-test-1",
    name: "Claude Test 1",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
    ...overrides,
  };
}

describe("isRegistryModel", () => {
  it("accepts a complete model record", () => {
    expect(isRegistryModel(validModel())).toBe(true);
  });

  it("accepts a record carrying unknown extra fields", () => {
    // An upstream addition must not need a Valet change.
    expect(isRegistryModel(validModel({ somethingNew: { nested: true } }))).toBe(true);
  });

  it.each(["anthropic", "openai", "google", "openrouter"] as const)(
    "accepts every %s model pi-ai bundles, so the fallback list is never filtered away",
    (provider) => {
      const bundled: readonly Model<Api>[] = getBuiltinModels(provider);
      expect(bundled.length).toBeGreaterThan(0);
      // Walk as `unknown` so the predicate does real runtime work here
      // instead of being short-circuited by the static type.
      const rejected: string[] = [];
      for (const model of bundled) {
        const candidate: unknown = model;
        if (!isRegistryModel(candidate)) rejected.push(model.id);
      }
      expect(rejected).toEqual([]);
    },
  );

  it.each([
    ["a non-object", 42],
    ["null", null],
    ["an array", []],
  ])("rejects %s", (_label, value) => {
    expect(isRegistryModel(value)).toBe(false);
  });

  it.each([
    ["id", { id: "" }],
    ["name", { name: 123 }],
    ["api", { api: undefined }],
    ["provider", { provider: "" }],
    ["baseUrl", { baseUrl: null }],
    ["reasoning", { reasoning: "yes" }],
    ["input", { input: "text" }],
    ["contextWindow", { contextWindow: "200000" }],
    ["maxTokens", { maxTokens: Number.NaN }],
  ])("rejects a record with a bad %s", (_field, patch) => {
    expect(isRegistryModel(validModel(patch))).toBe(false);
  });

  it("rejects partial pricing rather than billing a wrong number", () => {
    expect(isRegistryModel(validModel({ cost: { input: 1, output: 5 } }))).toBe(false);
    expect(isRegistryModel(validModel({ cost: null }))).toBe(false);
  });
});

describe("parseRemoteCatalog", () => {
  it("reads the grouped shape pi-ai publishes", () => {
    const models = parseRemoteCatalog("anthropic", {
      "anthropic-messages": {
        "claude-test-1": validModel(),
        "claude-test-2": validModel({ id: "claude-test-2", name: "Claude Test 2" }),
      },
    });
    expect(models.map((m) => m.id)).toEqual(["claude-test-1", "claude-test-2"]);
  });

  it("reads a flat id-keyed map", () => {
    const models = parseRemoteCatalog("anthropic", { "claude-test-1": validModel() });
    expect(models.map((m) => m.id)).toEqual(["claude-test-1"]);
  });

  it("skips malformed entries and keeps the good ones", () => {
    const models = parseRemoteCatalog("anthropic", {
      "anthropic-messages": {
        good: validModel(),
        truncated: { id: "truncated", name: "Truncated" },
        notAnObject: "nope",
      },
    });
    expect(models.map((m) => m.id)).toEqual(["claude-test-1"]);
  });

  it("skips entries attributed to another provider", () => {
    // A catalog served for anthropic must not inject models that claim to
    // belong elsewhere — one provider's fetch cannot rewrite another's list.
    const models = parseRemoteCatalog("anthropic", {
      "anthropic-messages": {
        mine: validModel(),
        theirs: validModel({ id: "gpt-test", provider: "openai" }),
      },
    });
    expect(models.map((m) => m.id)).toEqual(["claude-test-1"]);
  });

  it("keeps the first record when an id repeats across groups", () => {
    const models = parseRemoteCatalog("anthropic", {
      groupA: { dup: validModel({ name: "First" }) },
      groupB: { dup: validModel({ name: "Second" }) },
    });
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe("First");
  });

  it.each([
    ["null", null],
    ["a string", "not a catalog"],
    ["an array", []],
    ["an empty object", {}],
    ["a payload of only bad entries", { g: { bad: { id: "x" } } }],
  ])("returns an empty list for %s", (_label, payload) => {
    expect(parseRemoteCatalog("anthropic", payload)).toEqual([]);
  });
});

describe("parseLastModified", () => {
  it("parses an HTTP date to epoch ms", () => {
    expect(parseLastModified("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(Date.parse("2015-10-21T07:28:00Z"));
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["junk", "not-a-date"],
  ])("returns undefined for %s", (_label, header) => {
    expect(parseLastModified(header)).toBeUndefined();
  });
});
