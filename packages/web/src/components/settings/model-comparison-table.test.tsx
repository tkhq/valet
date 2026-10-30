// @vitest-environment jsdom
/**
 * Model comparison table (docs/specs/2026-10-30-model-comparison-page-design.md):
 * joins the member-visible model list with the benchmark snapshot and shows
 * prices, context, scores and the derived Quality and Value. Mocks
 * `~/api/settings` like the other settings tests; the benchmark lookup is
 * injected so these tests do not depend on the real snapshot's numbers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelInfo } from "@valet/api/wire";
import { MODEL_BENCHMARKS_SNAPSHOT, type ModelBenchmark } from "@valet/shared";

let modelsData: { models: ModelInfo[] } = { models: [] };
let modelsState: { isLoading: boolean; error: unknown } = { isLoading: false, error: null };

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return { ...actual, useModels: () => ({ data: modelsData, ...modelsState }) };
});

import { ModelComparisonTable } from "./model-comparison-table";

function mk(id: string, o: Partial<ModelInfo> & { input?: number; output?: number } = {}): ModelInfo {
  const { input, output, ...rest } = o;
  return {
    id,
    name: rest.name ?? id.slice(id.indexOf("/") + 1),
    providerId: "p",
    providerKind: id.startsWith("anthropic/") ? "anthropic" : "amazon-bedrock",
    providerName: id.startsWith("anthropic/") ? "Anthropic" : "Amazon Bedrock",
    active: true,
    approved: true,
    pricing: input === undefined ? undefined : { input, output: output ?? 0 },
    ...rest,
  };
}
const bm = (family: string, extra: Partial<ModelBenchmark> = {}): ModelBenchmark => ({ family, name: family, ids: [], ...extra });
const SCORING = { ceilings: new Map([["v5.0", 60]]), latestVersion: "v5.0" };
const LOOKUP: Record<string, ModelBenchmark> = {
  "amazon-bedrock/deepseek.v3.2": bm("deepseek-v3.2", { intelligenceIndex: 42, indexVersion: "v5.0" }),
  "amazon-bedrock/us.zai.glm-5.3": bm("glm-5.3", { intelligenceIndex: 32, indexVersion: "v5.0" }),
  "anthropic/claude-opus-5-5": bm("claude-opus-5.5", { intelligenceIndex: 58, indexVersion: "v5.0" }),
};
const lookup = (id: string) => LOOKUP[id];

const OLD_AND_UNSCORED = [
  mk("amazon-bedrock/zai.glm-5", { name: "GLM-5", input: 1, output: 3.2 }),
  mk("amazon-bedrock/mistral.mistral-large-3-675b-instruct", { name: "Mistral Large 3", input: 0.5, output: 1.5 }),
];
const LOOKUP_EXTRA: Record<string, ModelBenchmark> = {
  ...LOOKUP,
  "amazon-bedrock/zai.glm-5": bm("glm-5", { intelligenceIndex: 50, indexVersion: "v4.0", observed: "2026-02-11" }),
  "amazon-bedrock/mistral.mistral-large-3-675b-instruct": bm("mistral-large-3"),
};

const FOUR = [
  mk("amazon-bedrock/deepseek.v3.2", { name: "DeepSeek V3.2", input: 0.62, output: 1.85, contextWindow: 262144 }),
  mk("amazon-bedrock/us.zai.glm-5.3", { name: "GLM-5.3", input: 1.848, output: 5.808, contextWindow: 1_000_000 }),
  mk("amazon-bedrock/vendor.brand-new-model", { name: "Brand New" }),
  mk("anthropic/claude-opus-5-5", { name: "Claude Opus 5.5", input: 4, output: 20, contextWindow: 1_000_000 }),
];

function rowOf(name: string) {
  return screen.getByText(name).closest("tr")!;
}
function rowNames(): string[] {
  return screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].querySelector("[data-model-name]")?.textContent ?? "");
}

beforeEach(() => {
  modelsData = { models: FOUR };
  modelsState = { isLoading: false, error: null };
});

describe("ModelComparisonTable", () => {
  it("states the snapshot date and source with a link", () => {
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    const header = screen.getByText(new RegExp(MODEL_BENCHMARKS_SNAPSHOT.asOf));
    expect(header.textContent).toContain(MODEL_BENCHMARKS_SNAPSHOT.source.version);
    expect(screen.getByRole("link", { name: MODEL_BENCHMARKS_SNAPSHOT.source.label }).getAttribute("href")).toBe(MODEL_BENCHMARKS_SNAPSHOT.source.url);
  });

  it("shows prices, context and scores, and dashes where unknown", () => {
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    const deepseek = within(rowOf("DeepSeek V3.2"));
    expect(deepseek.getByText("$0.62")).toBeTruthy();
    expect(deepseek.getByText("$1.85")).toBeTruthy();
    expect(deepseek.getByText("$0.93")).toBeTruthy(); // blended (3*0.62+1.85)/4
    expect(deepseek.getByText("262k")).toBeTruthy();
    expect(deepseek.getByText("42")).toBeTruthy();
    expect(deepseek.getByText("70")).toBeTruthy(); // quality 42/60

    const unknown = within(rowOf("Brand New"));
    const cells = unknown.getAllByRole("cell").map((c) => c.textContent);
    // name, provider, input, output, blended, context, reasoning, intelligence, valet eval, quality, value
    expect(cells.slice(2, 6)).toEqual(["–", "–", "–", "–"]);
    expect(cells.slice(7)).toEqual(["–", "–", "–", "–"]);
  });

  it("shows an older-version score with its version and no Quality, and labels a known unscored family", () => {
    modelsData = { models: [...FOUR, ...OLD_AND_UNSCORED] };
    render(<ModelComparisonTable lookupForTests={(id) => LOOKUP_EXTRA[id]} scoringForTests={SCORING} />);
    const glm5 = within(rowOf("GLM-5"));
    expect(glm5.getByText("50")).toBeTruthy();
    expect(glm5.getByText("v4.0")).toBeTruthy();
    const glm5Cells = glm5.getAllByRole("cell").map((c) => c.textContent);
    // quality and value stay dashes: v4.0 is not the latest index version
    expect(glm5Cells.slice(-2)).toEqual(["–", "–"]);
    // a current-version score shows no version marker
    expect(within(rowOf("DeepSeek V3.2")).queryByText("v5.0")).toBeNull();
    expect(within(rowOf("Mistral Large 3")).getByText("not yet benchmarked")).toBeTruthy();
    expect(within(rowOf("Brand New")).queryByText("not yet benchmarked")).toBeNull();
  });

  it("marks which sources fed Quality", () => {
    render(
      <ModelComparisonTable
        lookupForTests={(id) =>
          id === "amazon-bedrock/deepseek.v3.2"
            ? bm("d", { intelligenceIndex: 42, indexVersion: "v5.0", valetEval: { suite: "s", modelSpec: "m", cases: 1, runsPerCase: 1, passRate: 90, ranAt: "2026-10-30" } })
            : LOOKUP[id]
        }
        scoringForTests={SCORING}
      />,
    );
    expect(within(rowOf("DeepSeek V3.2")).getByText("AA + Valet")).toBeTruthy();
    expect(within(rowOf("GLM-5.3")).getByText("AA", { exact: true })).toBeTruthy();
  });

  it("explains that only the newest index version feeds Quality and that Value is relative to the catalog", () => {
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.getByRole("columnheader", { name: /quality/i }).getAttribute("title")).toContain("v5.0");
    expect(screen.getByRole("columnheader", { name: /value/i }).getAttribute("title")).toContain("best model in your catalog is 100");
  });

  it("hides the Coding column when no row has a coding score and shows it when one does", () => {
    const { unmount } = render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.queryByRole("columnheader", { name: /coding/i })).toBeNull();
    unmount();
    render(
      <ModelComparisonTable
        lookupForTests={(id) => (id === "amazon-bedrock/deepseek.v3.2" ? bm("d", { intelligenceIndex: 42, indexVersion: "v5.0", codingIndex: 39 }) : undefined)}
        scoringForTests={SCORING}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /coding/i })).toBeTruthy();
    expect(within(rowOf("DeepSeek V3.2")).getByText("39")).toBeTruthy();
  });

  it("shows the Approved column only when some model is unapproved, and dims that row", () => {
    const { unmount } = render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.queryByRole("columnheader", { name: /approved/i })).toBeNull();
    unmount();
    modelsData = { models: [...FOUR.slice(0, 3), { ...FOUR[3], approved: false }] };
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.getByRole("columnheader", { name: /approved/i })).toBeTruthy();
    expect(rowOf("Claude Opus 5.5").getAttribute("aria-disabled")).toBe("true");
    expect(rowOf("DeepSeek V3.2").getAttribute("aria-disabled")).toBeNull();
  });

  it("sorts by Value by default and re-sorts when a numeric header is clicked", async () => {
    const user = userEvent.setup();
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    // value: deepseek q70 → 4900/0.9275=5283 ; glm q53 → 2809/2.838=990 ; opus q97 → 9409/8=1176
    expect(rowNames()).toEqual(["DeepSeek V3.2", "Claude Opus 5.5", "GLM-5.3", "Brand New"]);
    const input = screen.getByRole("button", { name: /input \$\/M/i });
    await user.click(input);
    expect(rowNames()).toEqual(["DeepSeek V3.2", "GLM-5.3", "Claude Opus 5.5", "Brand New"]);
    await user.click(input);
    expect(rowNames()).toEqual(["Claude Opus 5.5", "GLM-5.3", "DeepSeek V3.2", "Brand New"]);
  });

  it("filters by provider case-insensitively and reports an empty match", async () => {
    const user = userEvent.setup();
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    const filter = screen.getByRole("textbox", { name: "Filter models" });
    await user.type(filter, "bedrock");
    expect(screen.queryByText("Claude Opus 5.5")).toBeNull();
    expect(screen.getByText("DeepSeek V3.2")).toBeTruthy();
    await user.clear(filter);
    await user.type(filter, "zzz");
    expect(screen.getByText("No matching models.")).toBeTruthy();
  });

  it("renders an all-unknown catalog as dashes sorted by name, with no NaN", () => {
    modelsData = { models: [mk("amazon-bedrock/zeta", { name: "Zeta" }), mk("amazon-bedrock/alpha", { name: "Alpha" })] };
    const { container } = render(<ModelComparisonTable lookupForTests={() => undefined} scoringForTests={SCORING} />);
    expect(rowNames()).toEqual(["Alpha", "Zeta"]);
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).not.toContain("$0");
  });

  it("shows the Valet eval pass rate with run details in the tooltip", () => {
    render(
      <ModelComparisonTable
        lookupForTests={(id) =>
          id === "amazon-bedrock/deepseek.v3.2"
            ? bm("d", { valetEval: { suite: "evals/cases/hard", modelSpec: "amazon-bedrock/deepseek.v3.2", reasoning: "high", cases: 15, runsPerCase: 3, passRate: 87, meanCostUsd: 0.1234, ranAt: "2026-10-30" } })
            : undefined
        }
        scoringForTests={SCORING}
      />,
    );
    const cell = within(rowOf("DeepSeek V3.2")).getByText("87%");
    expect(cell.getAttribute("title")).toContain("evals/cases/hard");
    expect(cell.getAttribute("title")).toContain("15 cases × 3 runs");
    expect(cell.getAttribute("title")).toContain("2026-10-30");
    // Quality from the Valet part alone.
    expect(within(rowOf("DeepSeek V3.2")).getByText("87", { exact: true })).toBeTruthy();
  });

  it("shows a spinner while loading and an error line on failure", () => {
    modelsState = { isLoading: true, error: null };
    const { unmount } = render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.getByText(/loading models/i)).toBeTruthy();
    unmount();
    modelsState = { isLoading: false, error: new Error("boom") };
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.getByText("Failed to load models.")).toBeTruthy();
  });
});
