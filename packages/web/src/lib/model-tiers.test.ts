import { describe, expect, it } from "vitest";
import {
  isSizeTier,
  resolveTierModel,
  selectionLabel,
  SIZE_TIERS,
  TIER_LABELS,
  tierLabel,
  tierSubtitle,
} from "./model-tiers";
import type { GetModelTiersResponse, ModelInfo } from "@valet/api/wire";

describe("SIZE_TIERS / TIER_LABELS", () => {
  it("lists the five size tiers in size order", () => {
    expect(SIZE_TIERS).toEqual(["xs", "s", "m", "l", "xl"]);
  });

  it("has a label for every tier", () => {
    for (const tier of SIZE_TIERS) {
      expect(TIER_LABELS[tier]).toBeTruthy();
    }
  });
});

describe("isSizeTier", () => {
  it("narrows a known tier id", () => {
    expect(isSizeTier("m")).toBe(true);
  });

  it("rejects an unknown id", () => {
    expect(isSizeTier("xxl")).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isSizeTier(null)).toBe(false);
    expect(isSizeTier(undefined)).toBe(false);
  });
});

describe("tierLabel", () => {
  it("looks up the label for a known tier", () => {
    expect(tierLabel("xs")).toBe("Extra Small");
    expect(tierLabel("s")).toBe("Small");
    expect(tierLabel("m")).toBe("Medium");
    expect(tierLabel("l")).toBe("Large");
    expect(tierLabel("xl")).toBe("X-Large");
  });

  it("returns the id unchanged when it isn't a known tier", () => {
    expect(tierLabel("custom_1/llama-3")).toBe("custom_1/llama-3");
  });
});

describe("tierSubtitle", () => {
  const models: ModelInfo[] = [
    {
      id: "anthropic/claude-opus-4-7",
      name: "Claude Opus 4.7",
      providerId: "anthropic",
      providerKind: "anthropic",
      providerName: "Anthropic",
      active: true,
      approved: true,
    },
  ];

  it("resolves the tier's first target's catalog name", () => {
    const tierMap: GetModelTiersResponse = {
      xs: [],
      s: [],
      m: [],
      l: [],
      xl: ["anthropic/claude-opus-4-7"],
    };
    // The org catalog name overlays with the curated label when the target
    // matches a known Anthropic tier (same rule model rows use).
    expect(tierSubtitle("xl", tierMap, models)).toBe("Claude Opus 4.7");
  });

  it("falls back to the raw spec string when the target is not in the catalog", () => {
    const tierMap: GetModelTiersResponse = { xs: [], s: [], m: [], l: [], xl: ["ghost/retired"] };
    expect(tierSubtitle("xl", tierMap, [])).toBe("ghost/retired");
  });

  it("returns undefined when the tier has no assigned targets", () => {
    const tierMap: GetModelTiersResponse = { xs: [], s: [], m: [], l: [], xl: [] };
    expect(tierSubtitle("xl", tierMap, models)).toBeUndefined();
  });

  it("returns undefined when the tier map has not loaded", () => {
    expect(tierSubtitle("xl", undefined, models)).toBeUndefined();
  });
});

describe("resolved tier selections", () => {
  const models: ModelInfo[] = [
    {
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      providerId: "openai",
      providerKind: "openai",
      providerName: "OpenAI",
      active: false,
      approved: true,
    },
    {
      id: "openai/gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      providerId: "openai",
      providerKind: "openai",
      providerName: "OpenAI",
      active: true,
      approved: true,
    },
  ];
  const tierMap: GetModelTiersResponse = {
    xs: [],
    s: [],
    m: [],
    l: ["openai/gpt-5.6-luna", "openai/gpt-5.6-sol"],
    xl: [],
  };

  it("uses the first active configured target", () => {
    expect(resolveTierModel("l", tierMap, models)?.name).toBe("GPT-5.6 Sol");
  });

  it("shows a concrete model name for a selected tier", () => {
    expect(selectionLabel("l", tierMap, models)).toBe("GPT-5.6 Sol");
  });

  it("shows the catalog name for a selected concrete model", () => {
    expect(selectionLabel("openai/gpt-5.6-sol", tierMap, models)).toBe("GPT-5.6 Sol");
  });

  it("falls back to the tier label when no target resolves", () => {
    expect(selectionLabel("l", tierMap, [])).toBe("Large");
  });
});
