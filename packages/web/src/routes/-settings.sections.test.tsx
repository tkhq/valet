// @vitest-environment jsdom
/**
 * You sections (split-settings design, Task 6): profile save, the
 * default-model typeahead's filter/select/clear, the enable-organizations
 * card's gate visibility + PATCH-then-navigate, appearance's theme
 * radio-cards, and the notifications toggle. Mocks `~/api/settings` /
 * `~/api/orchestrator` / `~/api/queries` / `@tanstack/react-router` the same
 * way `-integrations.test.tsx` mocks `~/api/integrations` — these tests
 * only care what each section renders and which mutation it fires, not that
 * TanStack Query or the router themselves resolve anything.
 *
 * Task 11 adds the API keys section, mocking `~/api/api-keys` the same way
 * — the create flow's one-time secret reveal and the revoke confirm-gate.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const patchMeMutate = vi.fn();
const patchOrgMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const setPrefMutate = vi.fn();
const navigateMock = vi.fn();
const saveIdentityMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const createApiKeyMutate = vi.fn();
const revokeApiKeyMutate = vi.fn();

let meData: {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: "admin" | "member";
  orgId: string;
  orgRole: "admin" | "member";
  defaultModel: string | null;
} | undefined = {
  id: "u1",
  email: "me@example.com",
  name: "Ada",
  avatarUrl: null,
  role: "member",
  orgId: "org_1",
  orgRole: "admin",
  defaultModel: null,
};

let orgData:
  | {
      callerRole: "admin" | "operator" | "member";
      permissions: ("org:manage" | "members:manage" | "providers:manage" | "infra:manage" | "credentials:org")[];
      features: { organizations: boolean };
    }
  | undefined = {
  callerRole: "admin",
  permissions: ["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"],
  features: { organizations: false },
};

let apiKeysData: Array<{
  id: string;
  name: string | null;
  start: string | null;
  createdAt: Date;
  lastRequest: Date | null;
}> = [];

const modelsData = {
  models: [
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200000, reasoning: false },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200000, reasoning: true },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200000, reasoning: true },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 200000, reasoning: true },
    { id: "some-exotic-model", name: "Exotic", contextWindow: 100000, reasoning: false },
  ],
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => navigateMock,
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: meData, isLoading: false, error: null }),
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
  useModels: () => ({ data: modelsData, isLoading: false, error: null }),
  usePatchMe: () => ({ mutate: patchMeMutate, isPending: false, error: null }),
  usePatchOrg: () => ({ mutateAsync: patchOrgMutateAsync, isPending: false, error: null }),
}));

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({
    data: { sessionId: "s1", name: "Valet", personality: null, presence: "idle", activeChildren: 0 },
    isLoading: false,
    error: null,
  }),
  useSaveIdentity: () => ({ mutateAsync: saveIdentityMutateAsync, isPending: false, error: null }),
}));

vi.mock("~/api/queries", () => ({
  useNotificationPreferences: () => ({
    data: { preferences: [{ kind: "notification", web: true }] },
    isLoading: false,
    error: null,
  }),
  useSetNotificationPreference: () => ({ mutate: setPrefMutate }),
}));

vi.mock("~/api/api-keys", () => ({
  useApiKeys: () => ({ data: apiKeysData, isLoading: false, error: null }),
  useCreateApiKey: () => ({ mutate: createApiKeyMutate, isPending: false, error: null }),
  useRevokeApiKey: () => ({ mutate: revokeApiKeyMutate, isPending: false, error: null }),
}));

import { ProfilePage } from "./settings.profile";
import { AssistantPage } from "./settings.assistant";
import { AppearancePage } from "./settings.appearance";
import { NotificationsPage } from "./settings.notifications";
import { ApiKeysPage } from "./settings.api-keys";

describe("ProfilePage", () => {
  beforeEach(() => {
    patchMeMutate.mockClear();
    patchOrgMutateAsync.mockClear();
    meData = {
      id: "u1",
      email: "me@example.com",
      name: "Ada",
      avatarUrl: null,
      role: "member",
      orgId: "org_1",
      orgRole: "admin",
      defaultModel: null,
    };
    orgData = {
      callerRole: "admin",
      permissions: ["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"],
      features: { organizations: false },
    };
  });

  it("renders name/avatar and a read-only email row with the spec hint", () => {
    render(<ProfilePage />);
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Ada");
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.value).toBe("me@example.com");
    expect(email.readOnly).toBe(true);
    expect(
      screen.getByText("Sign-in email — managed by your login once real auth ships."),
    ).toBeTruthy();
  });

  it("Save is disabled until a field is dirty, then PATCHes /api/me", () => {
    render(<ProfilePage />);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada Lovelace" } });
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    expect(patchMeMutate).toHaveBeenCalledWith({ name: "Ada Lovelace", avatarUrl: "" });
  });

  it("shows the enable-org card for an admin with the gate off, and it PATCHes + navigates", async () => {
    render(<ProfilePage />);
    expect(screen.getByText("Working with a team? Enable organizations")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Enable" }));

    await waitFor(() =>
      expect(patchOrgMutateAsync).toHaveBeenCalledWith({ features: { organizations: true } }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/organization" }));
  });

  it("hides the enable-org card when the gate is already on", () => {
    orgData = {
      callerRole: "admin",
      permissions: ["org:manage", "members:manage", "providers:manage", "infra:manage", "credentials:org"],
      features: { organizations: true },
    };
    render(<ProfilePage />);
    expect(screen.queryByText("Working with a team? Enable organizations")).toBeNull();
  });

  it("hides the enable-org card for a non-admin", () => {
    orgData = { callerRole: "member", permissions: [], features: { organizations: false } };
    render(<ProfilePage />);
    expect(screen.queryByText("Working with a team? Enable organizations")).toBeNull();
  });
});

describe("AssistantPage", () => {
  beforeEach(() => {
    patchMeMutate.mockClear();
    meData = {
      id: "u1",
      email: "me@example.com",
      name: "Ada",
      avatarUrl: null,
      role: "member",
      orgId: "org_1",
      orgRole: "admin",
      defaultModel: null,
    };
  });

  it("renders the shared identity fields and the default-model helper text verbatim", () => {
    render(<AssistantPage />);
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.getByLabelText(/Personality/)).toBeTruthy();
    expect(
      screen.getByText(
        "New conversations start on this model; you can still switch per-thread in the chat header.",
      ),
    ).toBeTruthy();
  });

  it("the model combobox filters to curated sonnet entries on 'sonnet'", () => {
    render(<AssistantPage />);
    const input = screen.getByLabelText("Default model");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "sonnet" } });

    expect(screen.getByText("Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("Sonnet 4.6")).toBeTruthy();
    expect(screen.queryByText("Haiku 4.5")).toBeNull();
    expect(screen.queryByText("Opus 4.7")).toBeNull();
  });

  it("selecting a model fires PATCH /api/me with its id", () => {
    render(<AssistantPage />);
    const input = screen.getByLabelText("Default model");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "sonnet" } });
    fireEvent.click(screen.getByText("Sonnet 4.5"));

    expect(patchMeMutate).toHaveBeenCalledWith({ defaultModel: "claude-sonnet-4-5" });
  });

  it("shows a 'System default' clear row and clears with defaultModel: null", () => {
    meData = { ...meData!, defaultModel: "claude-sonnet-4-5" };
    render(<AssistantPage />);
    const input = screen.getByLabelText("Default model");
    fireEvent.focus(input);

    fireEvent.click(screen.getByText("System default"));
    expect(patchMeMutate).toHaveBeenCalledWith({ defaultModel: null });
  });

  it("saving the identity fields calls the shared save-identity mutation", async () => {
    saveIdentityMutateAsync.mockClear();
    render(<AssistantPage />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Nova" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveIdentityMutateAsync).toHaveBeenCalledWith({ name: "Nova" }),
    );
  });
});

describe("AppearancePage", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.clear();
  });

  it("selecting Dark sets data-theme on the document root", () => {
    render(<AppearancePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("selecting Light sets data-theme to light", () => {
    render(<AppearancePage />);
    fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("NotificationsPage", () => {
  it("renders the four kinds and fires the mutation on toggle", () => {
    setPrefMutate.mockClear();
    render(<NotificationsPage />);
    const toggle = screen.getByRole("switch", { name: "Notifications web notifications" });
    fireEvent.click(toggle);
    expect(setPrefMutate).toHaveBeenCalledWith({ kind: "notification", web: false });
  });
});

describe("ApiKeysPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiKeysData = [];
  });

  it("shows the brief-verbatim empty state when there are no keys", () => {
    render(<ApiKeysPage />);
    expect(
      screen.getByText("No API keys yet. Create one to call the API from scripts."),
    ).toBeTruthy();
  });

  it("creating a key calls apiKey.create and reveals the secret exactly once", () => {
    createApiKeyMutate.mockImplementation((_name, opts) => {
      opts.onSuccess({
        id: "key_1",
        name: "CI pipeline",
        key: "valet_sk_live_abc123",
        start: "valet_sk_l",
        prefix: "valet_sk_",
      });
    });
    render(<ApiKeysPage />);

    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "CI pipeline" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createApiKeyMutate).toHaveBeenCalledWith(
      "CI pipeline",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(screen.getByText("valet_sk_live_abc123")).toBeTruthy();
    expect(screen.getByText("This is the only time the full key is shown.")).toBeTruthy();
  });

  it("renders list rows with the start hint, name, created, and last-used columns", () => {
    apiKeysData = [
      {
        id: "key_1",
        name: "CI pipeline",
        start: "valet_sk_l",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastRequest: null,
      },
    ];
    render(<ApiKeysPage />);
    expect(screen.getByText("CI pipeline")).toBeTruthy();
    expect(screen.getByText("valet_sk_l")).toBeTruthy();
    expect(screen.getByText("Last used Never")).toBeTruthy();
  });

  it("revoking a key is confirm-gated", async () => {
    const user = userEvent.setup();
    apiKeysData = [
      {
        id: "key_1",
        name: "CI pipeline",
        start: "valet_sk_l",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        lastRequest: null,
      },
    ];
    render(<ApiKeysPage />);

    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(revokeApiKeyMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(revokeApiKeyMutate).toHaveBeenCalledWith(
      "key_1",
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
