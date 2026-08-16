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
import type { ModelInfo } from "@valet/api/wire";

let modelsData: { models: ModelInfo[] } = { models: [] };
let isLoading = false;

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useModels: () => ({ data: modelsData, isLoading, error: null }),
  };
});

import { ModelCombobox } from "./model-combobox";

beforeEach(() => {
  isLoading = false;
  modelsData = {
    models: [
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        providerId: "anthropic",
        providerKind: "anthropic",
        providerName: "Anthropic",
        active: true,
      },
      {
        id: "custom_1/llama-3",
        name: "Llama 3",
        providerId: "custom_1",
        providerKind: "openai_compatible",
        providerName: "My Router",
        active: true,
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
