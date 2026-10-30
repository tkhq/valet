import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BEDROCK_DEFAULT_MODEL_IDS,
  bedrockRegistry,
  curatedBedrockModels,
  discoverBedrockModels,
  geoPrefixForRegion,
  parseBedrockDiscovery,
  resetBedrockDiscoveryCache,
  type BedrockDiscoveryClient,
} from "./bedrock-discovery.js";

const fm = (
  modelId: string,
  inferenceTypes: string[],
  extra: Partial<{ output: string[]; input: string[]; streaming: boolean; status: string; name: string }> = {},
) => ({
  modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}`,
  modelId,
  modelName: extra.name ?? modelId,
  providerName: modelId.split(".")[0],
  inputModalities: extra.input ?? ["TEXT"],
  outputModalities: extra.output ?? ["TEXT"],
  responseStreamingSupported: extra.streaming ?? true,
  inferenceTypesSupported: inferenceTypes,
  modelLifecycle: { status: extra.status ?? "ACTIVE" },
});

const profile = (id: string, ...modelIds: string[]) => ({
  inferenceProfileId: id,
  inferenceProfileName: id,
  status: "ACTIVE",
  type: "SYSTEM_DEFINED",
  models: modelIds.flatMap((m) =>
    ["us-east-1", "us-west-2"].map((r) => ({ modelArn: `arn:aws:bedrock:${r}::foundation-model/${m}` })),
  ),
});

const FOUNDATION = {
  modelSummaries: [
    fm("qwen.qwen3-coder-next", ["ON_DEMAND"], { name: "Qwen3 Coder Next" }),
    fm("meta.llama4-maverick-17b-instruct-v1:0", ["INFERENCE_PROFILE"]),
    fm("vendor.global-only-model", ["INFERENCE_PROFILE"]),
    fm("anthropic.claude-sonnet-5-5", ["INFERENCE_PROFILE"]),
    fm("stability.sd3-5-large-v1:0", ["ON_DEMAND"], { output: ["IMAGE"] }),
    fm("vendor.legacy-model", ["ON_DEMAND"], { status: "LEGACY" }),
    fm("vendor.no-stream-model", ["ON_DEMAND"], { streaming: false }),
    fm("vendor.brand-new-model", ["ON_DEMAND"], { name: "Brand New" }),
  ],
};

const PROFILES = {
  inferenceProfileSummaries: [
    profile("us.meta.llama4-maverick-17b-instruct-v1:0", "meta.llama4-maverick-17b-instruct-v1:0"),
    profile("global.vendor.global-only-model", "vendor.global-only-model"),
    profile("us.anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"),
    profile("global.anthropic.claude-sonnet-5-5", "anthropic.claude-sonnet-5-5"),
  ],
};

function fakeClient(opts: { useCase?: "ok" | "missing" | "denied"; fail?: boolean } = {}): BedrockDiscoveryClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async send(cmd: unknown) {
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      calls.push(name);
      if (opts.fail) throw new Error("boom");
      if (name === "ListFoundationModelsCommand") return FOUNDATION;
      if (name === "ListInferenceProfilesCommand") return PROFILES;
      if (name === "GetUseCaseForModelAccessCommand") {
        if (opts.useCase === "missing") {
          const e = new Error("You have not filled out the request form.");
          e.name = "ResourceNotFoundException";
          throw e;
        }
        if (opts.useCase === "denied") {
          const e = new Error("not authorized");
          e.name = "AccessDeniedException";
          throw e;
        }
        return { formData: "{}" };
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
}

describe("geoPrefixForRegion", () => {
  it("maps AWS regions to Bedrock cross-region profile prefixes", () => {
    expect(geoPrefixForRegion("us-east-1")).toBe("us.");
    expect(geoPrefixForRegion("eu-central-1")).toBe("eu.");
    expect(geoPrefixForRegion("ap-southeast-2")).toBe("apac.");
    expect(geoPrefixForRegion("weird")).toBe("us.");
  });
});

describe("parseBedrockDiscovery", () => {
  const parse = (anthropicAllowed: boolean) =>
    parseBedrockDiscovery({ foundationModels: FOUNDATION, inferenceProfiles: PROFILES, geoPrefix: "us.", anthropicAllowed }).map((m) => m.id);

  it("lists on-demand models by bare id and profile-only models by their geo profile", () => {
    const ids = parse(true);
    expect(ids).toContain("qwen.qwen3-coder-next");
    expect(ids).toContain("us.meta.llama4-maverick-17b-instruct-v1:0");
    expect(ids).not.toContain("meta.llama4-maverick-17b-instruct-v1:0");
  });

  it("omits models whose only profile is global", () => {
    const ids = parse(true);
    expect(ids).not.toContain("vendor.global-only-model");
    expect(ids.some((id) => id.startsWith("global."))).toBe(false);
  });

  it("omits anthropic ids unless anthropicAllowed", () => {
    expect(parse(false).some((id) => id.includes("anthropic."))).toBe(false);
    expect(parse(true)).toContain("us.anthropic.claude-sonnet-5-5");
  });

  it("omits non-text, non-streaming, and non-ACTIVE models", () => {
    const ids = parse(true);
    expect(ids).not.toContain("stability.sd3-5-large-v1:0");
    expect(ids).not.toContain("vendor.legacy-model");
    expect(ids).not.toContain("vendor.no-stream-model");
  });

  it("carries the Bedrock model name", () => {
    const entry = parseBedrockDiscovery({ foundationModels: FOUNDATION, inferenceProfiles: PROFILES, geoPrefix: "us.", anthropicAllowed: true })
      .find((m) => m.id === "qwen.qwen3-coder-next");
    expect(entry?.name).toBe("Qwen3 Coder Next");
  });
});

describe("discoverBedrockModels", () => {
  afterEach(() => resetBedrockDiscoveryCache());

  it("merges discovery with registry metadata and keeps unknown ids with bedrock names and no pricing", async () => {
    const { models, live } = await discoverBedrockModels({ client: fakeClient({ useCase: "ok" }), region: "us-east-1" });
    expect(live).toBe(true);
    const qwen = models.find((m) => m.id === "qwen.qwen3-coder-next");
    expect(qwen?.pricing?.input).toBeGreaterThan(0);
    const fresh = models.find((m) => m.id === "vendor.brand-new-model");
    expect(fresh).toEqual({ id: "vendor.brand-new-model", name: "Brand New" });
    expect(models.map((m) => m.id)).toEqual([...models.map((m) => m.id)].sort());
  });

  it("hides anthropic when GetUseCaseForModelAccess rejects with ResourceNotFoundException", async () => {
    const { models } = await discoverBedrockModels({ client: fakeClient({ useCase: "missing" }), region: "us-east-1" });
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(false);
  });

  it("hides anthropic when GetUseCaseForModelAccess fails for any other reason", async () => {
    const { models, live } = await discoverBedrockModels({ client: fakeClient({ useCase: "denied" }), region: "us-east-1" });
    expect(live).toBe(true);
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(false);
  });

  it("caches for an hour per region", async () => {
    let now = 1_000_000;
    const client = fakeClient({ useCase: "ok" });
    await discoverBedrockModels({ client, region: "us-east-1", now: () => now });
    const first = client.calls.length;
    await discoverBedrockModels({ client, region: "us-east-1", now: () => now + 3_599_000 });
    expect(client.calls.length).toBe(first);
    await discoverBedrockModels({ client, region: "us-west-2", now: () => now });
    expect(client.calls.length).toBeGreaterThan(first);
    const beforeExpiry = client.calls.length;
    now += 3_601_000;
    await discoverBedrockModels({ client, region: "us-east-1", now: () => now });
    expect(client.calls.length).toBeGreaterThan(beforeExpiry);
  });

  it("degrades to a filtered registry list with live:false when the client throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { models, live } = await discoverBedrockModels({ client: fakeClient({ fail: true }), region: "us-east-1" });
    expect(live).toBe(false);
    expect(models.length).toBeGreaterThan(0);
    expect(models.length).toBeLessThan(bedrockRegistry().size);
  });

  it("a failed discovery does not poison the hour-long positive cache", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 3_000_000;
    const failing = fakeClient({ fail: true });
    await discoverBedrockModels({ client: failing, region: "us-east-1", now: () => now });
    now += 200_000;
    const ok = fakeClient({ useCase: "ok" });
    const { live } = await discoverBedrockModels({ client: ok, region: "us-east-1", now: () => now });
    expect(live).toBe(true);
  });
});

describe("discoverBedrockModels resilience (review fixes)", () => {
  afterEach(() => { resetBedrockDiscoveryCache(); vi.restoreAllMocks(); });

  it("caches a failure for a short window instead of retrying on every call", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 5_000_000;
    const client = fakeClient({ fail: true });
    await discoverBedrockModels({ client, region: "us-east-1", now: () => now });
    const after1 = client.calls.length;
    await discoverBedrockModels({ client, region: "us-east-1", now: () => now + 30_000 });
    expect(client.calls.length).toBe(after1);
    now += 200_000;
    await discoverBedrockModels({ client, region: "us-east-1", now: () => now });
    expect(client.calls.length).toBeGreaterThan(after1);
  });

  it("warns once per failure window, naming the error and region", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient({ fail: true });
    await discoverBedrockModels({ client, region: "us-east-1" });
    await discoverBedrockModels({ client, region: "us-east-1" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/bedrock discovery.*us-east-1/i);
    expect(String(warn.mock.calls[0]?.[0]) + String(warn.mock.calls[0]?.[1] ?? "")).toMatch(/boom/);
  });

  it("shares one in-flight lookup across concurrent cache misses", async () => {
    const client = fakeClient({ useCase: "ok" });
    await Promise.all([
      discoverBedrockModels({ client, region: "us-east-1" }),
      discoverBedrockModels({ client, region: "us-east-1" }),
      discoverBedrockModels({ client, region: "us-east-1" }),
    ]);
    expect(client.calls.filter((c) => c === "ListFoundationModelsCommand").length).toBe(1);
  });

  it("a non-404 use-case failure hides anthropic only for a short window and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 9_000_000;
    const denied = fakeClient({ useCase: "denied" });
    const r1 = await discoverBedrockModels({ client: denied, region: "us-east-1", now: () => now });
    expect(r1.models.some((m) => m.id.includes("anthropic."))).toBe(false);
    expect(warn).toHaveBeenCalled();
    // Within the hour but past the short TTL, a later call re-queries.
    now += 200_000;
    const ok = fakeClient({ useCase: "ok" });
    const r2 = await discoverBedrockModels({ client: ok, region: "us-east-1", now: () => now });
    expect(ok.calls.length).toBeGreaterThan(0);
    expect(r2.models.some((m) => m.id.includes("anthropic."))).toBe(true);
  });

  it("a ResourceNotFoundException use-case answer is firm: cached for the full hour, no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let now = 7_000_000;
    const missing = fakeClient({ useCase: "missing" });
    await discoverBedrockModels({ client: missing, region: "us-east-1", now: () => now });
    expect(warn).not.toHaveBeenCalled();
    now += 200_000;
    const ok = fakeClient({ useCase: "ok" });
    await discoverBedrockModels({ client: ok, region: "us-east-1", now: () => now });
    expect(ok.calls.length).toBe(0);
  });

  it("the registry fallback is filtered to bare and geo-prefixed ids, never global or anthropic", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { models, live } = await discoverBedrockModels({ client: fakeClient({ fail: true }), region: "us-east-1" });
    expect(live).toBe(false);
    expect(models.length).toBeGreaterThan(10);
    expect(models.some((m) => m.id.startsWith("global."))).toBe(false);
    expect(models.some((m) => m.id.startsWith("eu."))).toBe(false);
    expect(models.some((m) => m.id.includes("anthropic."))).toBe(false);
    expect(models.some((m) => m.id === "qwen.qwen3-coder-next")).toBe(true);
    expect(models.some((m) => m.id === "us.meta.llama4-maverick-17b-instruct-v1:0")).toBe(true);
  });
});

describe("curated defaults", () => {
  it("every default id exists in the pi-ai amazon-bedrock registry", () => {
    const reg = bedrockRegistry();
    for (const id of BEDROCK_DEFAULT_MODEL_IDS) expect(reg.has(id), id).toBe(true);
  });
  it("curatedBedrockModels returns one registry-resolved entry per default, with pricing", () => {
    const out = curatedBedrockModels();
    expect(out.map((m) => m.id)).toEqual([...BEDROCK_DEFAULT_MODEL_IDS]);
    for (const m of out) expect(m.pricing?.input).toBeGreaterThan(0);
  });
  it("defaults include the best-value frontier open models", () => {
    // DeepSeek V3.2 ($0.62/$1.85), Mistral Large 3 ($0.50/$1.50) and GLM-5.3
    // (~$1.85/$5.81 on the US profile) are the cost/quality picks the team
    // settled on; the picker must offer them with no admin curation.
    for (const id of ["deepseek.v3.2", "mistral.mistral-large-3-675b-instruct", "us.zai.glm-5.3"]) {
      expect(BEDROCK_DEFAULT_MODEL_IDS, id).toContain(id);
    }
  });
  it("defaults contain no anthropic or global ids", () => {
    expect(BEDROCK_DEFAULT_MODEL_IDS.some((id) => id.includes("anthropic.") || id.startsWith("global."))).toBe(false);
  });
});

