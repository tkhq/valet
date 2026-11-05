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
/** The cell under the column whose header text starts with `label`. */
function cellOf(row: HTMLElement, label: string): HTMLElement {
  const headers = screen.getAllByRole("columnheader").map((h) => h.textContent ?? "");
  const index = headers.findIndex((h) => h.trim().startsWith(label));
  if (index === -1) throw new Error(`no column ${label}; have ${headers.join(" | ")}`);
  return within(row).getAllByRole("cell")[index];
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

  it("shows prices, context and scores, and dashes where unknown", async () => {
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    await userEvent.setup().click(screen.getByRole("checkbox", { name: /show 1 hidden/i }));
    const deepseek = within(rowOf("DeepSeek V3.2"));
    expect(deepseek.getByText("$0.62")).toBeTruthy();
    expect(deepseek.getByText("$1.85")).toBeTruthy();
    expect(deepseek.getByText("$0.93")).toBeTruthy(); // blended (3*0.62+1.85)/4
    expect(deepseek.getByText("262k")).toBeTruthy();
    expect(deepseek.getByText("42")).toBeTruthy();
    expect(deepseek.getByText("70")).toBeTruthy(); // quality 42/60

    const unknown = rowOf("Brand New");
    for (const col of ["Input", "Output", "Blended", "Context", "Intelligence", "Valet eval", "Quality", "Value"]) {
      expect(cellOf(unknown, col).textContent, col).toBe("–");
    }
    // Provider and id share the model cell's second line; no separate Provider column.
    expect(screen.queryByRole("columnheader", { name: /^provider$/i })).toBeNull();
    expect(within(unknown).getByText(/Amazon Bedrock/)).toBeTruthy();
    expect(within(unknown).getByTitle("amazon-bedrock/vendor.brand-new-model")).toBeTruthy();
  });

  it("shows an older-version score with its version and no Quality, and labels a known unscored family", async () => {
    modelsData = { models: [...FOUR, ...OLD_AND_UNSCORED] };
    render(<ModelComparisonTable lookupForTests={(id) => LOOKUP_EXTRA[id]} scoringForTests={SCORING} />);
    await userEvent.setup().click(screen.getByRole("checkbox", { name: /show 3 hidden/i }));
    const glm5 = within(rowOf("GLM-5"));
    expect(glm5.getByText("50")).toBeTruthy();
    expect(glm5.getByText("v4.0")).toBeTruthy();
    // quality and value stay dashes: v4.0 is not the latest index version
    expect(cellOf(rowOf("GLM-5"), "Quality").textContent).toBe("–");
    expect(cellOf(rowOf("GLM-5"), "Value").textContent).toBe("–");
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
    expect(screen.getByRole("checkbox", { name: /approved only/i })).toBeTruthy();
    expect(rowOf("DeepSeek V3.2").getAttribute("aria-disabled")).toBeNull();
  });

  it("sorts by Value by default and re-sorts when a numeric header is clicked", async () => {
    const user = userEvent.setup();
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    // value: deepseek q70 → 4900/0.9275=5283 ; glm q53 → 2809/2.838=990 ; opus q97 → 9409/8=1176
    expect(rowNames()).toEqual(["DeepSeek V3.2", "Claude Opus 5.5", "GLM-5.3"]);
    const input = screen.getByRole("button", { name: /^input/i });
    await user.click(input);
    expect(rowNames()).toEqual(["DeepSeek V3.2", "GLM-5.3", "Claude Opus 5.5"]);
    await user.click(input);
    expect(rowNames()).toEqual(["Claude Opus 5.5", "GLM-5.3", "DeepSeek V3.2"]);
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
    // Nothing has a current score, so the default view would be empty; the table falls back to showing everything.
    expect(rowNames()).toEqual(["Alpha", "Zeta"]);
    expect(container.textContent).not.toContain("NaN");
    expect(container.textContent).not.toContain("$0");
  });

  it("shows the Valet eval pass rate with run details in the tooltip", async () => {
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
    // Measured mean cost per case sits in its own sortable column.
    expect(cellOf(rowOf("DeepSeek V3.2"), "Eval $/case").textContent).toBe("$0.1234");
    await userEvent.setup().click(screen.getByRole("checkbox", { name: /show 3 hidden/i }));
    expect(cellOf(rowOf("GLM-5.3"), "Eval $/case").textContent).toBe("–");
    expect(screen.getByRole("button", { name: /^eval \$\/case/i })).toBeTruthy();
    expect(cell.getAttribute("title")).toContain("15 cases × 3 runs");
    expect(cell.getAttribute("title")).toContain("2026-10-30");
    // Quality from the Valet part alone.
    expect(within(rowOf("DeepSeek V3.2")).getByText("87", { exact: true })).toBeTruthy();
  });

  it("marks reasoning models with a badge in the model cell instead of a column", () => {
    modelsData = { models: [mk("amazon-bedrock/deepseek.v3.2", { name: "DeepSeek V3.2", input: 0.62, output: 1.85, reasoning: true }), mk("amazon-bedrock/us.zai.glm-5.3", { name: "GLM-5.3", input: 1.848, output: 5.808, reasoning: false })] };
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.queryByRole("columnheader", { name: /reasoning/i })).toBeNull();
    expect(within(rowOf("DeepSeek V3.2")).getByText("reasoning")).toBeTruthy();
    expect(within(rowOf("GLM-5.3")).queryByText("reasoning")).toBeNull();
  });

  it("keeps the price unit in the caption and short column labels", () => {
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    expect(screen.getByText(/\$ per 1M tokens/)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /^blended/i })).toBeTruthy();
  });

  it("hides older-version and unscored models by default, with a toggle that reveals them", async () => {
    const user = userEvent.setup();
    modelsData = { models: [...FOUR, ...OLD_AND_UNSCORED] };
    render(<ModelComparisonTable lookupForTests={(id) => LOOKUP_EXTRA[id]} scoringForTests={SCORING} />);
    // Current v5.0 scores: DeepSeek, GLM-5.3, Opus. Hidden: Brand New (unknown), GLM-5 (v4.0), Mistral Large 3 (unscored).
    expect(rowNames()).toEqual(["DeepSeek V3.2", "Claude Opus 5.5", "GLM-5.3"]);
    const toggle = screen.getByRole("checkbox", { name: /show 3 hidden/i });
    await user.click(toggle);
    expect(rowNames()).toHaveLength(6);
    expect(screen.getByText("GLM-5")).toBeTruthy();
  });

  it("filters by provider chip and approved-only", async () => {
    const user = userEvent.setup();
    modelsData = { models: [...FOUR.slice(0, 3), { ...FOUR[3], approved: false }] };
    render(<ModelComparisonTable lookupForTests={lookup} scoringForTests={SCORING} />);
    await user.click(screen.getByRole("button", { name: "Anthropic" }));
    expect(rowNames()).toEqual(["Claude Opus 5.5"]);
    await user.click(screen.getByRole("button", { name: "All providers" }));
    await user.click(screen.getByRole("checkbox", { name: /approved only/i }));
    expect(rowNames()).toEqual(["DeepSeek V3.2", "GLM-5.3"]);
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
