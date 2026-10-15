// @vitest-environment jsdom
/**
 * LastRunModel: a run records the provider's own model id and not the
 * provider, so the form shows the id and offers no one-click pin. Each
 * catalog below holds the single match that an id-to-catalog guess pinned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ModelInfo } from "@valet/api/wire";

let catalog: ModelInfo[] = [];
vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: catalog }, isLoading: false, error: null }),
  useModelTiers: () => ({ data: { xs: [], s: [], m: [], l: [], xl: [] }, isLoading: false, error: null }),
}));

import { LastRunModel } from "./last-run-model";
import { LlmForm } from "./llm-form";

describe("LastRunModel", () => {
  beforeEach(() => { catalog = []; });

  it("offers no pin for a step already on the bare id that the last run used", () => {
    catalog = [{
      id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5", providerId: "anthropic", providerKind: "anthropic",
      providerName: "Anthropic", active: true, approved: true,
    }];
    const onChange = vi.fn();
    render(
      <LlmForm
        node={{ id: "llm-1", type: "llm", model: "claude-sonnet-4-5", prompt: "hello" }}
        lastRunModels={["claude-sonnet-4-5"]}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/Last run used claude-sonnet-4-5\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin this model" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers no pin for a provider-local id when the active catalog has one match", () => {
    // The run called custom-a/default. That provider is now inactive, so the
    // active catalog shows only custom-b's model with the same id.
    catalog = [{
      id: "custom-b/default", name: "Default", providerId: "custom-b", providerKind: "openai_compatible",
      providerName: "custom-b", active: true, approved: true,
    }];
    render(<LastRunModel models={["default"]} />);
    expect(screen.getByText(/Last run used default\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin this model" })).toBeNull();
  });
});
