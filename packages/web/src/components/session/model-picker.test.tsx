// @vitest-environment jsdom
/**
 * ModelPicker consumes the org catalog (`GET /api/models`, Task 8) instead
 * of the static `MODEL_CATALOG` — response order is preserved, curated
 * labels overlay matching entries (bare or `anthropic/`-namespaced), custom
 * (openai_compatible) entries are selectable, and a `currentId` that has
 * fallen out of the catalog still labels instead of crashing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "~/components/primitives";
import type { ModelInfo } from "@valet/api/wire";

let modelsData: { models: ModelInfo[] } | undefined;
let isLoading = false;

vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: modelsData, isLoading, error: null }),
}));

import { ModelPicker } from "./model-picker";

function renderPicker(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  return render(
    <TooltipProvider>
      <ModelPicker onSelect={vi.fn()} {...props} />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  isLoading = false;
  modelsData = {
    models: [
      {
        id: "custom_1/llama-3",
        name: "Llama 3",
        providerId: "custom_1",
        providerKind: "openai_compatible",
        providerName: "My Router",
        active: true,
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        providerId: "anthropic",
        providerKind: "anthropic",
        providerName: "Anthropic",
        active: true,
      },
    ],
  };
});

describe("ModelPicker — catalog-driven", () => {
  it("lists catalog entries in response order, curated label overlaid for the matching one", async () => {
    const user = userEvent.setup();
    renderPicker({ currentId: "anthropic/claude-sonnet-4-5" });

    await user.click(screen.getByRole("button", { name: "Choose model" }));

    const items = screen.getAllByRole("menuitem");
    // Response order is preserved: the non-curated custom entry comes first,
    // even though it has no curated label — a curated-first re-sort would
    // put the Sonnet entry here instead.
    expect(items[0].textContent).toContain("Llama 3");
    expect(items[0].textContent).toContain("My Router");
    // Second is the curated Sonnet entry (curated label, not raw name).
    expect(items[1].textContent).toContain("Sonnet 4.5");
  });

  it("selecting a custom-provider entry submits the catalog id verbatim", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    await user.click(screen.getByRole("button", { name: "Choose model" }));
    await user.click(screen.getByText("Llama 3"));

    expect(onSelect).toHaveBeenCalledWith("custom_1/llama-3");
  });

  it("labels a bare persisted currentId via the curated fallback without crashing", () => {
    renderPicker({ currentId: "claude-haiku-4-5" });
    expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain("Haiku 4.5");
  });

  it("labels a currentId that has fallen out of the catalog with the raw id, not a crash", () => {
    renderPicker({ currentId: "custom_1/retired-model" });
    expect(screen.getByRole("button", { name: "Choose model" }).textContent).toContain(
      "custom_1/retired-model",
    );
  });

  it("shows a loading state while the catalog query is in flight", async () => {
    isLoading = true;
    modelsData = undefined;
    const user = userEvent.setup();
    renderPicker({ currentId: "anthropic/claude-sonnet-4-5" });

    await user.click(screen.getByRole("button", { name: "Choose model" }));
    expect(screen.getByText("Loading models…")).toBeTruthy();
  });
});
