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
import type { GetModelTiersResponse, GetOrgReasoningResponse, MeResponse, ModelInfo } from "@valet/api/wire";

let modelsData: { models: ModelInfo[] } | undefined;
let isLoading = false;
let meData: MeResponse | undefined;
let tierMapData: GetModelTiersResponse | undefined;
let orgReasoningData: GetOrgReasoningResponse | undefined;
let approvedModelsData: { approved: string[] | null } | undefined;

function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: "user_1",
    email: "member@example.com",
    name: "Member",
    avatarUrl: null,
    role: "member",
    orgId: "org_1",
    orgRole: "member",
    defaultModel: null,
    defaultReasoning: null,
    newThreadBehavior: "keep_current",
    ...overrides,
  };
}

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useModels: () => ({ data: modelsData, isLoading, error: null }),
    useMe: () => ({ data: meData, isLoading: false, error: null }),
    useModelTiers: () => ({ data: tierMapData, isLoading: false, error: null }),
    useApprovedModels: () => ({ data: approvedModelsData, isLoading: false, error: null }),
    useOrgReasoning: () => ({ data: orgReasoningData, isLoading: false, error: null }),
  };
});

import { ModelPicker, visibleModels } from "./model-picker";

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
        approved: true,
      },
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        providerId: "anthropic",
        providerKind: "anthropic",
        providerName: "Anthropic",
        active: true,
        approved: true,
      },
    ],
  };
  meData = makeMe();
  tierMapData = { xs: [], s: [], m: [], l: [], xl: [] };
  orgReasoningData = {};
  approvedModelsData = { approved: null };
});

describe("visibleModels", () => {
  const approved: ModelInfo = {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    providerId: "anthropic",
    providerKind: "anthropic",
    providerName: "Anthropic",
    active: true,
    approved: true,
  };
  const unapproved: ModelInfo = {
    id: "custom_1/llama-3",
    name: "Llama 3",
    providerId: "custom_1",
    providerKind: "openai_compatible",
    providerName: "My Router",
    active: true,
    approved: false,
  };

  it("returns every model for an admin, regardless of approval", () => {
    expect(visibleModels([approved, unapproved], true)).toEqual([approved, unapproved]);
  });

  it("returns only approved models for a member", () => {
    expect(visibleModels([approved, unapproved], false)).toEqual([approved]);
  });
});

describe("ModelPicker — catalog-driven", () => {
  it("lists catalog entries in response order, curated label overlaid for the matching one", async () => {
    const user = userEvent.setup();
    renderPicker({ currentId: "anthropic/claude-sonnet-4-5" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));

    // Model rows carry a stable data attribute — order = ModelInfo response
    // order (non-curated Llama 3 first, then curated Sonnet 4.5). Provider
    // name renders as a sticky group header above the row, not inline. The
    // Size group renders first (data-row-kind="tier"), so model rows are
    // queried by their own kind rather than by absolute index.
    const rows = document.querySelectorAll<HTMLElement>('[data-row-kind="model"]');
    expect(rows[0].textContent).toContain("Llama 3");
    expect(rows[1].textContent).toContain("Sonnet 4.5");
    // The provider group headers surface the provider names.
    expect(document.body.textContent).toContain("My Router");
    expect(document.body.textContent).toContain("Anthropic");
  });

  it("selecting a custom-provider entry submits the catalog id verbatim", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    // Row clicks use onMouseDown (avoids stealing focus from the sticky
    // search input); simulate that directly rather than user.click.
    const row = document.querySelector<HTMLElement>('[data-row-kind="model"]');
    if (!row) throw new Error("expected a model row to render");
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(onSelect).toHaveBeenCalledWith("custom_1/llama-3");
  });

  it("labels a bare persisted currentId via the curated fallback without crashing", () => {
    renderPicker({ currentId: "claude-haiku-4-5" });
    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain("Haiku 4.5");
  });

  it("labels a currentId that has fallen out of the catalog with the raw id, not a crash", () => {
    renderPicker({ currentId: "custom_1/retired-model" });
    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain(
      "custom_1/retired-model",
    );
  });

  it("shows a loading state while the catalog query is in flight", async () => {
    isLoading = true;
    modelsData = undefined;
    const user = userEvent.setup();
    renderPicker({ currentId: "anthropic/claude-sonnet-4-5" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(screen.getByText("Loading models…")).toBeTruthy();
  });
});

describe("ModelPicker — Size tier group", () => {
  it("shows the runtime model while keeping configured tier behavior", async () => {
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
          thinkingLevels: ["low"],
        },
        {
          id: "anthropic/claude-opus-4-7",
          name: "Claude Opus 4.7",
          providerId: "anthropic",
          providerKind: "anthropic",
          providerName: "Anthropic",
          active: true,
          approved: true,
          thinkingLevels: ["low", "medium", "high"],
        },
      ],
    };
    tierMapData = {
      xs: [],
      s: [],
      m: [],
      l: ["anthropic/claude-sonnet-4-5"],
      xl: [],
    };
    orgReasoningData = { max: "high" };
    const user = userEvent.setup();
    renderPicker({
      currentId: "l",
      displayId: "anthropic/claude-opus-4-7",
      onSelectReasoning: vi.fn(),
    });

    const trigger = screen.getByRole("button", { name: /Choose model:.*Opus 4\.7/ });
    expect(trigger.textContent).toContain("Opus 4.7");

    await user.click(trigger);
    const largeRow = screen.getByText("Large").closest("button");
    expect(largeRow?.textContent).toContain("current");
    expect((screen.getByRole("button", { name: "Medium reasoning" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows an unknown runtime model as its raw id", () => {
    renderPicker({ currentId: "l", displayId: "custom_1/runtime-model" });

    const trigger = screen.getByRole("button", {
      name: "Choose model: custom_1/runtime-model",
    });
    expect(trigger.textContent).toContain("custom_1/runtime-model");
  });

  it("renders a tier row per SIZE_TIERS entry before the provider groups, with a resolved subtitle", async () => {
    tierMapData = { xs: [], s: [], m: [], l: [], xl: ["anthropic/claude-sonnet-4-5"] };
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));

    const tierRows = document.querySelectorAll<HTMLElement>('[data-row-kind="tier"]');
    expect(tierRows).toHaveLength(5);
    expect(tierRows[0].textContent).toContain("Extra Small");
    expect(tierRows[4].textContent).toContain("X-Large");
    expect(tierRows[4].textContent).toContain("Sonnet 4.5");
    // Tier rows precede every model row in keyboard-nav order.
    const allRows = document.querySelectorAll<HTMLElement>("[data-model-index]");
    expect(allRows[0].dataset.rowKind).toBe("tier");
    expect(allRows[5].dataset.rowKind).toBe("model");
  });

  it("selecting a tier row submits the bare tier token and shows it as current", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderPicker({ onSelect, currentId: "l" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    const tierRows = document.querySelectorAll<HTMLElement>('[data-row-kind="tier"]');
    const largeRow = Array.from(tierRows).find((r) => r.textContent?.includes("Large") && !r.textContent.includes("X-Large"));
    if (!largeRow) throw new Error("expected a Large tier row");
    expect(largeRow.textContent).toContain("current");
    largeRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith("l");
  });

  it("hides the Size group when the search query matches no tier label or token", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    await user.type(screen.getByLabelText("Search models"), "llama");

    expect(document.querySelectorAll('[data-row-kind="tier"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-row-kind="model"]')).toHaveLength(1);
  });

  it("shows the resolved model name and thinking for a tier currentId", () => {
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
    renderPicker({ currentId: "l", currentReasoning: "medium" });
    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain(
      "GPT-5.6 Sol · Medium",
    );
  });
});

describe("ModelPicker — approved-models filter", () => {
  beforeEach(() => {
    modelsData = {
      models: [
        {
          id: "custom_1/llama-3",
          name: "Llama 3",
          providerId: "custom_1",
          providerKind: "openai_compatible",
          providerName: "My Router",
          active: true,
          approved: false,
        },
        {
          id: "anthropic/claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerId: "anthropic",
          providerKind: "anthropic",
          providerName: "Anthropic",
          active: true,
          approved: true,
        },
      ],
    };
  });

  it("hides unapproved models from a member", async () => {
    meData = makeMe({ orgRole: "member" });
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(document.body.textContent).not.toContain("Llama 3");
  });

  it("hides unapproved models from an admin too, in the baseline (approval is the only gate now)", async () => {
    meData = makeMe({ orgRole: "admin" });
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(document.body.textContent).not.toContain("Llama 3");
  });

  it("an admin's 'show more' reveals unapproved models when unrestricted", async () => {
    meData = makeMe({ orgRole: "admin" });
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(document.body.textContent).not.toContain("Llama 3");
    await user.click(screen.getByText(/show \d+ more/));
    expect(document.body.textContent).toContain("Llama 3");
  });

  it("a member's 'show more' never reveals unapproved models, search included", async () => {
    meData = makeMe({ orgRole: "member" });
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    // Nothing more to reveal for this fixture: the one approved entry
    // (Sonnet 4.5) is already shown, so the affordance itself must not
    // render — a member's reveal scope is the same as the baseline.
    expect(screen.queryByText(/show \d+ more/)).toBeNull();
    expect(document.body.textContent).not.toContain("Llama 3");

    await user.type(screen.getByLabelText("Search models"), "llama");
    expect(document.body.textContent).not.toContain("Llama 3");
  });

  it("never hides the currently pinned model from a member, even if it lost approval", async () => {
    meData = makeMe({ orgRole: "member" });
    const user = userEvent.setup();
    renderPicker({ currentId: "custom_1/llama-3" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(document.body.textContent).toContain("Llama 3");
  });

  it.each(["member", "admin"] as const)(
    "shows only approved options and no catalog reveal for a restricted %s",
    async (orgRole) => {
      approvedModelsData = { approved: ["anthropic/claude-sonnet-4-5"] };
      meData = makeMe({ orgRole });
      const user = userEvent.setup();
      renderPicker();

      await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
      expect(document.querySelectorAll('[data-row-kind="model"]')).toHaveLength(1);
      expect(document.body.textContent).toContain("Sonnet 4.5");
      expect(document.body.textContent).not.toContain("Llama 3");
      expect(screen.queryByText(/show \d+ more/)).toBeNull();
    },
  );

  it("keeps an unapproved current model display-only when restricted", async () => {
    approvedModelsData = { approved: ["anthropic/claude-sonnet-4-5"] };
    const user = userEvent.setup();
    renderPicker({ currentId: "custom_1/llama-3" });
    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain("Llama 3");

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    const optionText = Array.from(
      document.querySelectorAll<HTMLElement>('[data-row-kind="model"]'),
    ).map((row) => row.textContent);
    expect(optionText.join(" ")).not.toContain("Llama 3");
  });

  it("fails closed while the approved-model policy is unresolved", async () => {
    approvedModelsData = undefined;
    meData = makeMe({ orgRole: "admin" });
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(document.querySelectorAll('[data-row-kind="model"]')).toHaveLength(0);
    expect(screen.queryByText(/show \d+ more/)).toBeNull();

    await user.type(screen.getByLabelText("Search models"), "llama");
    expect(document.body.textContent).not.toContain("Llama 3");
  });
});

describe("ModelPicker — reasoning row", () => {
  beforeEach(() => {
    orgReasoningData = { max: "high" };
  });

  it("does not render when onSelectReasoning is not provided", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(screen.queryByRole("button", { name: "Default reasoning" })).toBeNull();
  });

  it("renders Default plus levels up to the org max, and calls onSelectReasoning", async () => {
    const user = userEvent.setup();
    const onSelectReasoning = vi.fn();
    renderPicker({ onSelectReasoning, currentId: "anthropic/claude-sonnet-4-5" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(screen.getByRole("button", { name: "Default reasoning" })).toBeTruthy();
    const highButton = screen.getByRole("button", { name: "High reasoning" });
    highButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onSelectReasoning).toHaveBeenCalledWith("high");
    // "xhigh"/"max" are above the org cap ("high") and must not render.
    expect(screen.queryByRole("button", { name: "X-High reasoning" })).toBeNull();

    const defaultButton = screen.getByRole("button", { name: "Default reasoning" });
    defaultButton.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onSelectReasoning).toHaveBeenCalledWith(null);
  });

  it("disables a level absent from the current model's thinkingLevels", async () => {
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
          thinkingLevels: ["low", "medium"],
        },
      ],
    };
    const user = userEvent.setup();
    renderPicker({ onSelectReasoning: vi.fn(), currentId: "anthropic/claude-sonnet-4-5" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect((screen.getByRole("button", { name: "Medium reasoning" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole("button", { name: "High reasoning" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("disables nothing when thinkingLevels is undefined (unknown support, not no support)", async () => {
    const user = userEvent.setup();
    renderPicker({ onSelectReasoning: vi.fn(), currentId: "anthropic/claude-sonnet-4-5" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect((screen.getByRole("button", { name: "High reasoning" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("gates on the tier's first target's thinkingLevels when currentId is a tier", async () => {
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
          thinkingLevels: ["low"],
        },
      ],
    };
    tierMapData = { xs: [], s: [], m: [], l: ["anthropic/claude-sonnet-4-5"], xl: [] };
    const user = userEvent.setup();
    renderPicker({ onSelectReasoning: vi.fn(), currentId: "l" });

    await user.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect((screen.getByRole("button", { name: "Low reasoning" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((screen.getByRole("button", { name: "Medium reasoning" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("appends the reasoning level to the trigger label", () => {
    renderPicker({ currentId: "anthropic/claude-sonnet-4-5", currentReasoning: "high" });
    expect(screen.getByRole("button", { name: /^Choose model:/ }).textContent).toContain("· High");
  });
});
