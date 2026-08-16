// @vitest-environment jsdom
/**
 * Organization · Models (split-settings design, Task 7): known-provider key
 * save never echoes the submitted key, custom-provider "Fetch models"
 * merges probed ids into checkboxes, and reordering preferences posts the
 * new array. Mocks `~/api/settings` the same way `-settings.organization
 * .test.tsx` mocks it for General/Members/Teams — these tests only care
 * what each section renders and which mutation it fires.
 */
import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "~/components/primitives";
import type { LlmProviderSummary, ModelInfo } from "@valet/api/wire";

function renderWithTooltip(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const createLlmProviderMutate = vi.fn();
const createLlmProviderMutateAsync = vi.fn();
const patchLlmProviderMutate = vi.fn();
const patchLlmProviderMutateAsync = vi.fn(async (vars: unknown) => {
  patchLlmProviderMutate(vars);
  return {};
});
const deleteLlmProviderMutate = vi.fn();
const putLlmProviderKeyMutate = vi.fn();
const putLlmProviderKeyMutateAsync = vi.fn();
const deleteLlmProviderKeyMutate = vi.fn();
const probeLlmProviderMutate = vi.fn();
const testLlmProviderMutate = vi.fn();
const putLlmProviderPreferencesMutate = vi.fn();

let providersData: { providers: LlmProviderSummary[] } = { providers: [] };
let preferencesData: { preferences: string[] } = { preferences: [] };
let modelsData: { models: ModelInfo[] } = { models: [] };

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
  ...actual,
  useLlmProviders: () => ({ data: providersData, isLoading: false, error: null }),
  useCreateLlmProvider: () => ({
    mutate: createLlmProviderMutate,
    mutateAsync: createLlmProviderMutateAsync,
    isPending: false,
    error: null,
  }),
  usePatchLlmProvider: () => ({
    mutate: patchLlmProviderMutate,
    mutateAsync: patchLlmProviderMutateAsync,
    isPending: false,
    error: null,
  }),
  useDeleteLlmProvider: () => ({ mutate: deleteLlmProviderMutate, isPending: false, error: null }),
  usePutLlmProviderKey: () => ({
    mutate: putLlmProviderKeyMutate,
    mutateAsync: putLlmProviderKeyMutateAsync,
    isPending: false,
    error: null,
  }),
  useDeleteLlmProviderKey: () => ({
    mutate: deleteLlmProviderKeyMutate,
    isPending: false,
    error: null,
  }),
  useProbeLlmProvider: () => ({ mutate: probeLlmProviderMutate, isPending: false, error: null }),
  useTestLlmProvider: () => ({ mutate: testLlmProviderMutate, isPending: false, error: null }),
  useLlmProviderPreferences: () => ({ data: preferencesData, isLoading: false, error: null }),
  usePutLlmProviderPreferences: () => ({
    mutate: putLlmProviderPreferencesMutate,
    isPending: false,
    error: null,
  }),
  useModels: () => ({ data: modelsData, isLoading: false, error: null }),
  useOpenrouterRegistry: () => ({
    data: { models: [{ id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" }], live: true },
    isLoading: false,
    error: null,
  }),
  };
});

import { LlmProvidersSection } from "~/components/settings/llm-providers-section";
import { ModelPreferencesSection } from "~/components/settings/model-preferences-section";

beforeEach(() => {
  vi.clearAllMocks();
  providersData = { providers: [] };
  preferencesData = { preferences: [] };
  modelsData = { models: [] };
});

describe("LlmProvidersSection — known provider cards", () => {
  it("saving a key never echoes it back into the input", async () => {
    const user = userEvent.setup();
    providersData = {
      providers: [
        {
          id: "row_anthropic",
          kind: "anthropic",
          name: "Anthropic",
          enabled: true,
          models: [],
          hasKey: false,
          envFallback: false,
          createdAt: 0,
        },
      ],
    };
    putLlmProviderKeyMutateAsync.mockResolvedValue({ hasKey: true, keyLast4: "abcd" });
    renderWithTooltip(<LlmProvidersSection />);

    const keyInput = screen.getByLabelText("API key", { selector: "#anthropic-key" }) as HTMLInputElement;
    await user.type(keyInput, "sk-secret-value-abcd");
    await user.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => expect(putLlmProviderKeyMutateAsync).toHaveBeenCalled());
    expect(keyInput.value).toBe("");
    expect(document.body.textContent).not.toContain("sk-secret-value-abcd");
  });

  it("creates the row implicitly on first key save when none exists", async () => {
    const user = userEvent.setup();
    createLlmProviderMutateAsync.mockResolvedValue({ id: "row_1" });
    putLlmProviderKeyMutateAsync.mockResolvedValue({ hasKey: true, keyLast4: "abcd" });
    renderWithTooltip(<LlmProvidersSection />);

    const keyInput = screen.getByLabelText("API key", { selector: "#openai-key" });
    await user.type(keyInput, "sk-abcd");
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    await user.click(saveButtons[1]);

    await waitFor(() =>
      expect(createLlmProviderMutateAsync).toHaveBeenCalledWith({ kind: "openai", name: "OpenAI" }),
    );
    await waitFor(() =>
      expect(putLlmProviderKeyMutateAsync).toHaveBeenCalledWith({
        id: "row_1",
        body: { apiKey: "sk-abcd" },
      }),
    );
  });

  it("shows a write-only placeholder with the last 4 chars when hasKey", () => {
    providersData = {
      providers: [
        {
          id: "row_1",
          kind: "anthropic",
          name: "Anthropic",
          enabled: true,
          models: [],
          hasKey: true,
          keyLast4: "wxyz",
          envFallback: false,
          createdAt: 0,
        },
      ],
    };
    renderWithTooltip(<LlmProvidersSection />);
    const keyInput = screen.getByLabelText("API key", { selector: "#anthropic-key" }) as HTMLInputElement;
    expect(keyInput.placeholder).toBe("••••wxyz");
    expect(keyInput.value).toBe("");
  });

  it("shows the deployment-key badge when envFallback is true and no key is stored", () => {
    providersData = {
      providers: [
        {
          id: "row_1",
          kind: "anthropic",
          name: "Anthropic",
          enabled: true,
          models: [],
          hasKey: false,
          envFallback: true,
          createdAt: 0,
        },
      ],
    };
    renderWithTooltip(<LlmProvidersSection />);
    expect(screen.getByText("using deployment key")).toBeTruthy();
  });

  it("Escape dismisses the OpenRouter model picker", async () => {
    const user = userEvent.setup();
    providersData = {
      providers: [
        {
          id: "row_or",
          kind: "openrouter",
          name: "OpenRouter",
          enabled: true,
          models: [{ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6" }],
          hasKey: true,
          keyLast4: "abcd",
          envFallback: false,
          createdAt: 0,
        },
      ],
    };
    renderWithTooltip(<LlmProvidersSection />);

    await user.click(screen.getByRole("button", { name: "Add models" }));
    const filter = screen.getByRole("textbox", { name: "Filter OpenRouter models" });
    await user.type(filter, "kimi");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Filter OpenRouter models" })).toBeNull();
  });

  it("toggling enabled fires PATCH", async () => {
    const user = userEvent.setup();
    providersData = {
      providers: [
        {
          id: "row_1",
          kind: "anthropic",
          name: "Anthropic",
          enabled: true,
          models: [],
          hasKey: true,
          keyLast4: "abcd",
          envFallback: false,
          createdAt: 0,
        },
      ],
    };
    renderWithTooltip(<LlmProvidersSection />);
    await user.click(screen.getByRole("switch", { name: "Enable Anthropic" }));
    expect(patchLlmProviderMutate).toHaveBeenCalledWith({
      id: "row_1",
      body: { enabled: false },
    });
  });

  it("removing the key fires DELETE", async () => {
    const user = userEvent.setup();
    providersData = {
      providers: [
        {
          id: "row_1",
          kind: "anthropic",
          name: "Anthropic",
          enabled: true,
          models: [],
          hasKey: true,
          keyLast4: "abcd",
          envFallback: false,
          createdAt: 0,
        },
      ],
    };
    renderWithTooltip(<LlmProvidersSection />);
    await user.click(screen.getByRole("button", { name: "Remove key" }));
    expect(deleteLlmProviderKeyMutate).toHaveBeenCalledWith("row_1");
  });
});

describe("LlmProvidersSection — custom provider", () => {
  const customProvider: LlmProviderSummary = {
    id: "custom_1",
    kind: "openai_compatible",
    name: "My Router",
    baseUrl: "https://router.example.com/v1",
    enabled: true,
    models: [{ id: "llama-3", name: "Llama 3" }],
    hasKey: true,
    keyLast4: "wxyz",
    envFallback: false,
    createdAt: 0,
  };

  it("fetching models merges probed ids into checkboxes", async () => {
    const user = userEvent.setup();
    providersData = { providers: [customProvider] };
    probeLlmProviderMutate.mockImplementation((_id, opts) => {
      opts.onSuccess({ models: [{ id: "llama-3" }, { id: "mixtral" }] });
    });
    renderWithTooltip(<LlmProvidersSection />);

    await user.click(screen.getByRole("button", { name: "Fetch models" }));

    expect(probeLlmProviderMutate).toHaveBeenCalledWith(
      "custom_1",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByRole("checkbox", { name: "llama-3" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "mixtral" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "llama-3" }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("checkbox", { name: "mixtral" }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("test shows the verbatim error text on failure", async () => {
    const user = userEvent.setup();
    providersData = { providers: [customProvider] };
    testLlmProviderMutate.mockImplementation((_vars, opts) => {
      opts.onSuccess({ ok: false, error: "502 Bad Gateway: upstream refused" });
    });
    renderWithTooltip(<LlmProvidersSection />);

    await user.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("502 Bad Gateway: upstream refused")).toBeTruthy();
  });

  it("deleting a provider confirms then fires the delete mutation", async () => {
    const user = userEvent.setup();
    providersData = { providers: [customProvider] };
    renderWithTooltip(<LlmProvidersSection />);

    await user.click(screen.getByRole("button", { name: "Delete My Router" }));
    expect(screen.getByText("Delete My Router?")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete provider" }));

    expect(deleteLlmProviderMutate).toHaveBeenCalledWith(
      "custom_1",
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("surfaces the 409 default-provider-in-use error verbatim", async () => {
    const user = userEvent.setup();
    providersData = { providers: [customProvider] };
    deleteLlmProviderMutate.mockImplementation((_id, opts) => {
      opts.onError(new Error("provider is the org default model's provider"));
    });
    renderWithTooltip(<LlmProvidersSection />);

    await user.click(screen.getByRole("button", { name: "Delete My Router" }));
    await user.click(screen.getByRole("button", { name: "Delete provider" }));

    expect(await screen.findByText("provider is the org default model's provider")).toBeTruthy();
  });
});

describe("ModelPreferencesSection", () => {
  beforeEach(() => {
    modelsData = {
      models: [
        {
          id: "anthropic/claude-1",
          name: "Claude One",
          providerId: "anthropic",
          providerKind: "anthropic",
          providerName: "Anthropic",
          active: true,
        },
        {
          id: "openai/gpt-1",
          name: "GPT One",
          providerId: "openai",
          providerKind: "openai",
          providerName: "OpenAI",
          active: true,
        },
      ],
    };
    preferencesData = { preferences: ["anthropic/claude-1", "openai/gpt-1"] };
  });

  it("badges the first row as default", () => {
    render(<ModelPreferencesSection />);
    const rows = screen.getAllByText(/Claude One|GPT One/);
    expect(within(rows[0].closest("div")!.parentElement!).getByText("Default")).toBeTruthy();
  });

  it("moving a row down posts the reordered preferences array", async () => {
    const user = userEvent.setup();
    render(<ModelPreferencesSection />);
    await user.click(screen.getByRole("button", { name: "Move Claude One down" }));
    expect(putLlmProviderPreferencesMutate).toHaveBeenCalledWith(
      { preferences: ["openai/gpt-1", "anthropic/claude-1"] },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("removing a row posts the array without it", async () => {
    const user = userEvent.setup();
    render(<ModelPreferencesSection />);
    await user.click(screen.getByRole("button", { name: "Remove Claude One" }));
    expect(putLlmProviderPreferencesMutate).toHaveBeenCalledWith(
      { preferences: ["openai/gpt-1"] },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("adds an unlisted model via the search typeahead", async () => {
    const user = userEvent.setup();
    preferencesData = { preferences: ["anthropic/claude-1"] };
    render(<ModelPreferencesSection />);
    // Closed until focused — no flat catalog dump on the page.
    expect(screen.queryByText("GPT One")).toBeNull();

    const search = screen.getByRole("textbox", { name: "Search models to add" });
    await user.type(search, "gpt");
    await user.click(screen.getByText("GPT One"));
    expect(putLlmProviderPreferencesMutate).toHaveBeenCalledWith(
      { preferences: ["anthropic/claude-1", "openai/gpt-1"] },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("typeahead filters by query and reports no matches", async () => {
    const user = userEvent.setup();
    preferencesData = { preferences: [] };
    render(<ModelPreferencesSection />);
    const search = screen.getByRole("textbox", { name: "Search models to add" });
    await user.type(search, "claude");
    expect(screen.getByText("Claude One")).toBeTruthy();
    expect(screen.queryByText("GPT One")).toBeNull();

    await user.clear(search);
    await user.type(search, "zzz-no-such-model");
    expect(screen.getByText("No matching models.")).toBeTruthy();
  });

  it("surfaces an error message when the save mutation rejects", async () => {
    const user = userEvent.setup();
    putLlmProviderPreferencesMutate.mockImplementation((_vars, opts) => {
      opts.onError(new Error("invalid model ids: openai/gpt-1"));
    });
    render(<ModelPreferencesSection />);

    await user.click(screen.getByRole("button", { name: "Remove Claude One" }));

    expect(await screen.findByText("invalid model ids: openai/gpt-1")).toBeTruthy();
  });
});
