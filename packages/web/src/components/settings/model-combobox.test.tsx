// @vitest-environment jsdom
/**
 * ModelCombobox consumes the org catalog (`GET /api/models`, Task 8):
 * curated `MODEL_CATALOG` entries are labeled by tier when the catalog id
 * matches (bare or `anthropic/`-namespaced), custom-provider entries are
 * selectable and labeled from the catalog `name`, selection always submits
 * the catalog's own id, and a persisted value that has dropped out of the
 * catalog is labeled without the "not in registry" warning when it still
 * matches a curated entry.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GetModelTiersResponse, ModelInfo } from "@valet/api/wire";

let modelsData: { models: ModelInfo[] } = { models: [] };
let isLoading = false;
let tierMapData: GetModelTiersResponse | undefined;

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useModels: () => ({ data: modelsData, isLoading, error: null }),
    useModelTiers: () => ({ data: tierMapData, isLoading: false, error: null }),
  };
});

import { ModelCombobox } from "./model-combobox";

beforeEach(() => {
  isLoading = false;
  tierMapData = { xs: [], s: [], m: [], l: [], xl: [] };
  modelsData = {
    models: [
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        providerId: "anthropic",
        providerKind: "anthropic",
        providerName: "Anthropic",
        active: true,
        approved: true,
      },
      {
        id: "custom_1/llama-3",
        name: "Llama 3",
        providerId: "custom_1",
        providerKind: "openai_compatible",
        providerName: "My Router",
        active: true,
        approved: true,
      },
    ],
  };
});

describe("ModelCombobox — catalog-driven", () => {
  it("shows the curated tier label + badge for a matching catalog entry", async () => {
    const user = userEvent.setup();
    render(<ModelCombobox value={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("balanced")).toBeTruthy();
  });

  it("lists a custom-provider entry by catalog name", async () => {
    const user = userEvent.setup();
    render(<ModelCombobox value={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    expect(screen.getByText("Llama 3")).toBeTruthy();
  });

  it("selecting the curated entry submits the catalog's namespaced id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ModelCombobox value={null} onSelect={onSelect} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByText("Sonnet 4.5"));
    expect(onSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-5");
  });

  it("selecting a custom-provider entry submits its catalog id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ModelCombobox value={null} onSelect={onSelect} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByText("Llama 3"));
    expect(onSelect).toHaveBeenCalledWith("custom_1/llama-3");
  });

  it("labels a legacy bare persisted value via the curated fallback and shows no warning", () => {
    render(<ModelCombobox value="claude-haiku-4-5" onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByDisplayValue("Haiku 4.5")).toBeTruthy();
    expect(screen.queryByText(/isn't in the current model registry/)).toBeNull();
  });

  it("warns when the persisted value matches nothing in the catalog or curated list", () => {
    render(<ModelCombobox value="ghost-provider/ghost-model" onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByText(/isn't in the current model registry/)).toBeTruthy();
  });
});

describe("ModelCombobox — Size tier group", () => {
  it("renders a tier row per SIZE_TIERS entry before the model rows, with a resolved subtitle", async () => {
    tierMapData = { xs: [], s: [], m: [], l: [], xl: ["anthropic/claude-sonnet-4-5"] };
    const user = userEvent.setup();
    render(<ModelCombobox value={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));

    const options = screen.getAllByRole("option");
    // Five tier rows first, then the model rows.
    expect(options[0].textContent).toContain("Extra Small");
    expect(options[4].textContent).toContain("X-Large");
    expect(options[4].textContent).toContain("Sonnet 4.5");
    expect(options[5].textContent).toContain("Sonnet 4.5");
  });

  it("filters the Size group by tier label and token", async () => {
    const user = userEvent.setup();
    render(<ModelCombobox value={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "large");

    const options = screen.getAllByRole("option");
    const tierRows = options.filter((o) => o.textContent?.match(/Small|Medium|Large/));
    // "large" matches both "Large" and "X-Large".
    expect(tierRows).toHaveLength(2);
  });

  it("hides the Size group when the query matches no tier label or token", async () => {
    const user = userEvent.setup();
    render(<ModelCombobox value={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "llama");

    expect(screen.queryByText("Extra Small")).toBeNull();
    expect(screen.getByText("Llama 3")).toBeTruthy();
  });

  it("selecting a tier row submits the bare tier token", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ModelCombobox value={null} onSelect={onSelect} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByText("Large"));

    expect(onSelect).toHaveBeenCalledWith("l");
  });

  it("displays the resolved model name when value is a tier token", () => {
    modelsData = {
      models: [
        {
          id: "openai/gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          providerId: "openai",
          providerKind: "openai",
          providerName: "OpenAI",
          active: true,
          approved: true,
        },
      ],
    };
    tierMapData = { xs: [], s: [], m: [], l: ["openai/gpt-5.6-sol"], xl: [] };
    render(<ModelCombobox value="l" onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByDisplayValue("GPT-5.6 Sol")).toBeTruthy();
    expect(screen.queryByText(/isn't in the current model registry/)).toBeNull();
  });
});

describe("ModelCombobox — approved-models filter", () => {
  beforeEach(() => {
    modelsData = {
      models: [
        {
          id: "anthropic/claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerId: "anthropic",
          providerKind: "anthropic",
          providerName: "Anthropic",
          active: true,
          approved: true,
        },
        {
          id: "custom_1/llama-3",
          name: "Llama 3",
          providerId: "custom_1",
          providerKind: "openai_compatible",
          providerName: "My Router",
          active: true,
          approved: false,
        },
      ],
    };
  });

  it("hides an unapproved model from the option list — no admin reveal on this surface", async () => {
    const user = userEvent.setup();
    render(<ModelCombobox value={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    expect(screen.queryByText("Llama 3")).toBeNull();
    expect(screen.getByText("Sonnet 4.5")).toBeTruthy();
  });

  it("an unapproved model does not surface even via search", async () => {
    const user = userEvent.setup();
    render(<ModelCombobox value={null} onSelect={vi.fn()} onClear={vi.fn()} />);
    await user.click(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "llama");
    expect(screen.queryByText("Llama 3")).toBeNull();
  });

  it("keeps the currently selected value labeled even after it loses approval", () => {
    render(<ModelCombobox value="custom_1/llama-3" onSelect={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByDisplayValue("Llama 3")).toBeTruthy();
    expect(screen.queryByText(/isn't in the current model registry/)).toBeNull();
  });
});
