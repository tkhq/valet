// @vitest-environment jsdom
/**
 * LastRunModel: a run records the provider's own model id, so the pin
 * decides which catalog model that id names. Two providers can expose the
 * same id, and only an unambiguous, approved match gets a pin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ModelInfo } from "@valet/api/wire";

let catalog: ModelInfo[] = [];
vi.mock("~/api/settings", () => ({
  useModels: () => ({ data: { models: catalog }, isLoading: false, error: null }),
}));

import { LastRunModel } from "./last-run-model";

function customModel(providerId: string, approved: boolean): ModelInfo {
  return {
    id: `${providerId}/default`, name: "Default", providerId, providerKind: "openai_compatible",
    providerName: providerId, active: true, approved,
  };
}

describe("LastRunModel", () => {
  beforeEach(() => { catalog = []; });

  it("offers no pin when two providers expose the recorded id, even if only one is approved", () => {
    catalog = [customModel("custom-a", false), customModel("custom-b", true)];
    render(<LastRunModel models={["default"]} value="l" onPin={vi.fn()} />);
    expect(screen.getByText(/Last run used default\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin this model" })).toBeNull();
  });

  it("pins the catalog id when one approved provider exposes the recorded id", () => {
    catalog = [customModel("custom-b", true)];
    const onPin = vi.fn();
    render(<LastRunModel models={["default"]} value="l" onPin={onPin} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin this model" }));
    expect(onPin).toHaveBeenCalledWith("custom-b/default");
  });

  it("offers no pin when the only match is not approved", () => {
    catalog = [customModel("custom-a", false)];
    render(<LastRunModel models={["default"]} value="l" onPin={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Pin this model" })).toBeNull();
  });
});
