// @vitest-environment jsdom
/**
 * ModelTiersSection (model-selector-overhaul, Task 13): one row-group per
 * `SIZE_TIERS` entry showing the tier's ordered target list, using the
 * up/down/remove + `AddModelTypeahead` row pattern. Every edit issues a
 * single-tier `PatchModelTiersRequest`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GetModelTiersResponse, ModelInfo } from "@valet/api/wire";

const patchMutate = vi.fn();

let modelsData: { models: ModelInfo[] } = { models: [] };
let tiersData: GetModelTiersResponse = { xs: [], s: [], m: [], l: [], xl: [] };

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useModels: () => ({ data: modelsData, isLoading: false, error: null }),
    useModelTiers: () => ({ data: tiersData, isLoading: false, error: null }),
    usePatchModelTiers: () => ({ mutate: patchMutate, isPending: false }),
  };
});

import { ModelTiersSection } from "./model-tiers-section";

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

const OPUS: ModelInfo = {
  id: "claude-opus-4-7",
  name: "Opus 4.7",
  providerId: "anthropic",
  providerKind: "anthropic",
  providerName: "Anthropic",
  active: true,
  approved: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  modelsData = { models: [HAIKU, SONNET, OPUS] };
  tiersData = {
    xs: [HAIKU.id],
    s: [SONNET.id, OPUS.id],
    m: [],
    l: [],
    xl: [],
  };
});

describe("ModelTiersSection", () => {
  it("renders one row-group per tier with the resolved first target beside the label", () => {
    render(<ModelTiersSection />);

    expect(screen.getByText("Extra Small")).toBeTruthy();
    expect(screen.getByText("Small")).toBeTruthy();
    expect(screen.getByText("Medium")).toBeTruthy();
    // First target's catalog name shown beside the tier label (and again as
    // that tier's first row).
    expect(screen.getAllByText("Haiku 4.5")).toHaveLength(2);
    expect(screen.getAllByText("Sonnet 4.5")).toHaveLength(2);
    // Empty tiers say so instead of showing a stray name.
    expect(screen.getAllByText("No targets set for this tier.")).toHaveLength(3);
  });

  it("removing a target patches only that tier with the remainder", async () => {
    const user = userEvent.setup();
    render(<ModelTiersSection />);

    await user.click(screen.getByRole("button", { name: "Remove Sonnet 4.5 from Small" }));

    expect(patchMutate).toHaveBeenCalledWith({ s: [OPUS.id] }, expect.anything());
  });

  it("moving a target down reorders within its tier only", async () => {
    const user = userEvent.setup();
    render(<ModelTiersSection />);

    await user.click(screen.getByRole("button", { name: "Move Sonnet 4.5 down in Small" }));

    expect(patchMutate).toHaveBeenCalledWith({ s: [OPUS.id, SONNET.id] }, expect.anything());
  });

  it("adding an unlisted model via the typeahead appends it to that tier", async () => {
    const user = userEvent.setup();
    render(<ModelTiersSection />);

    const searchInputs = screen.getAllByLabelText("Search models to add");
    // First group-with-content row-group is xs (only Haiku listed); Sonnet
    // and Opus are unlisted there. Scope the result click to this
    // typeahead's own wrapper — the move/remove button labels elsewhere on
    // the page also contain "Opus 4.7" as a substring.
    await user.click(searchInputs[0]);
    const typeahead = searchInputs[0].closest(".space-y-1") as HTMLElement;
    await user.click(within(typeahead).getByRole("button", { name: /Opus 4\.7/ }));

    expect(patchMutate).toHaveBeenCalledWith({ xs: [HAIKU.id, OPUS.id] }, expect.anything());
  });

  it("the typeahead excludes unapproved models — offering one would 400 on save", async () => {
    modelsData = { models: [HAIKU, SONNET, { ...OPUS, approved: false }] };
    const user = userEvent.setup();
    render(<ModelTiersSection />);

    const searchInputs = screen.getAllByLabelText("Search models to add");
    await user.click(searchInputs[0]);
    const typeahead = searchInputs[0].closest(".space-y-1") as HTMLElement;
    expect(within(typeahead).queryByText(/Opus 4\.7/)).toBeNull();
    expect(within(typeahead).getByText(/Sonnet 4\.5/)).toBeTruthy();
  });

  describe("default tier for new threads", () => {
    function openDefaultTierMenu() {
      fireEvent.keyDown(screen.getByRole("button", { name: /^Default tier for new threads/ }), { key: "Enter" });
    }

    it("shows no organization default when the org has none", () => {
      render(<ModelTiersSection />);
      expect(screen.getByRole("button", { name: "Default tier for new threads: No organization default" })).toBeTruthy();
    });

    it("shows the stored default tier", () => {
      tiersData = { ...tiersData, defaultTier: "xs", defaultTierResolvable: true };
      render(<ModelTiersSection />);
      expect(screen.getByRole("button", { name: "Default tier for new threads: Extra Small · Haiku 4.5" })).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("picking a tier patches only defaultTier", () => {
      render(<ModelTiersSection />);
      openDefaultTierMenu();
      fireEvent.click(screen.getByText("Extra Small · Haiku 4.5"));
      expect(patchMutate).toHaveBeenCalledWith({ defaultTier: "xs" }, expect.anything());
    });

    it("picking no organization default clears it with null", () => {
      tiersData = { ...tiersData, defaultTier: "xs", defaultTierResolvable: true };
      render(<ModelTiersSection />);
      openDefaultTierMenu();
      fireEvent.click(screen.getByText("No organization default"));
      expect(patchMutate).toHaveBeenCalledWith({ defaultTier: null }, expect.anything());
    });

    it("warns when new sessions skip the stored default tier", () => {
      tiersData = { ...tiersData, defaultTier: "xs", defaultTierResolvable: false };
      render(<ModelTiersSection />);
      expect(screen.getByRole("button", { name: "Default tier for new threads: Extra Small · Haiku 4.5" })).toBeTruthy();
      expect(screen.getByRole("alert").textContent).toBe(
        "No provider with a key serves this tier, so new threads use Small. Put a target whose provider has a key first in the tier, or choose another default.",
      );
    });
  });
});
