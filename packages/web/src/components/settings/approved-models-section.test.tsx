// @vitest-environment jsdom
/**
 * ApprovedModelsSection (model-selector-overhaul, Task 13): the switch
 * clears (`approved: null`) or seeds (curated ids present in the catalog)
 * the org's approved-model list; the checkbox list below edits it directly
 * and blocks unchecking the last entry client-side (the API 400s an empty
 * list), surfacing the API's error text on any other failure.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelInfo } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const putMutate = vi.fn();

let modelsData: { models: ModelInfo[] } = { models: [] };
let approvedData: { approved: string[] | null } = { approved: null };

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useModels: () => ({ data: modelsData, isLoading: false, error: null }),
    useApprovedModels: () => ({ data: approvedData, isLoading: false, error: null }),
    usePutApprovedModels: () => ({ mutate: putMutate, isPending: false }),
  };
});

import { ApprovedModelsSection } from "./approved-models-section";

// "claude-haiku-4-5" and "claude-sonnet-4-5" are curated (MODEL_CATALOG);
// "custom_1/llama-3" is not.
const HAIKU: ModelInfo = {
  id: "claude-haiku-4-5",
  name: "Haiku 4.5",
  providerId: "anthropic",
  providerKind: "anthropic",
  providerName: "Anthropic",
  active: true,
  approved: true,
};

const SONNET: ModelInfo = {
  id: "claude-sonnet-4-5",
  name: "Sonnet 4.5",
  providerId: "anthropic",
  providerKind: "anthropic",
  providerName: "Anthropic",
  active: true,
  approved: true,
};

const LLAMA: ModelInfo = {
  id: "custom_1/llama-3",
  name: "Llama 3",
  providerId: "custom_1",
  providerKind: "openai_compatible",
  providerName: "My Router",
  active: true,
  approved: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  modelsData = { models: [HAIKU, SONNET, LLAMA] };
  approvedData = { approved: null };
});

describe("ApprovedModelsSection — switch", () => {
  it("renders off with no checkbox list when approved is null", () => {
    render(<ApprovedModelsSection />);

    expect(
      screen.getByRole("switch", { name: "Restrict members to approved models" }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.queryByText("Anthropic")).toBeNull();
  });

  it("turning the switch on seeds the curated ids present in the catalog", async () => {
    const user = userEvent.setup();
    render(<ApprovedModelsSection />);

    await user.click(screen.getByRole("switch", { name: "Restrict members to approved models" }));

    expect(putMutate).toHaveBeenCalledWith(
      { approved: [HAIKU.id, SONNET.id] },
      expect.anything(),
    );
  });

  it("turning the switch off clears the list", async () => {
    approvedData = { approved: [HAIKU.id] };
    const user = userEvent.setup();
    render(<ApprovedModelsSection />);

    await user.click(screen.getByRole("switch", { name: "Restrict members to approved models" }));

    expect(putMutate).toHaveBeenCalledWith({ approved: null }, expect.anything());
  });
});

describe("ApprovedModelsSection — checkbox list", () => {
  it("groups the catalog by provider and checks the approved ids", () => {
    approvedData = { approved: [HAIKU.id] };
    render(<ApprovedModelsSection />);

    expect(screen.getByText("Anthropic")).toBeTruthy();
    expect(screen.getByText("My Router")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Haiku 4.5" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Sonnet 4.5" }).getAttribute("aria-checked")).toBe("false");
  });

  it("checking an unapproved model adds it to the list", async () => {
    approvedData = { approved: [HAIKU.id] };
    const user = userEvent.setup();
    render(<ApprovedModelsSection />);

    await user.click(screen.getByRole("checkbox", { name: "Sonnet 4.5" }));

    expect(putMutate).toHaveBeenCalledWith(
      { approved: [HAIKU.id, SONNET.id] },
      expect.anything(),
    );
  });

  it("blocks unchecking the last approved model and shows a corrective message", async () => {
    approvedData = { approved: [HAIKU.id] };
    const user = userEvent.setup();
    render(<ApprovedModelsSection />);

    await user.click(screen.getByRole("checkbox", { name: "Haiku 4.5" }));

    expect(putMutate).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Keep at least one model approved, or turn off the restriction."),
    ).toBeTruthy();
  });

  it("surfaces the API's error text on failure", async () => {
    approvedData = { approved: [HAIKU.id] };
    putMutate.mockImplementation((_body, opts) => {
      opts.onError(
        new ApiError(400, "PUT /api/org/approved-models → 400", {
          error: "approved list cannot be empty",
        }),
      );
    });
    const user = userEvent.setup();
    render(<ApprovedModelsSection />);

    await user.click(screen.getByRole("checkbox", { name: "Sonnet 4.5" }));

    expect(await screen.findByText("approved list cannot be empty")).toBeTruthy();
  });
});
