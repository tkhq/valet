// @vitest-environment jsdom
/**
 * 1Password panel on `/integrations`. Mocks `~/api/onepassword`,
 * `~/api/integrations`, and `~/api/settings` the same way the old
 * Organization · 1Password suite mocked them — these tests only care
 * what the panel renders and which mutation it fires.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CredentialSummary,
  ListOpItemsResponse,
  ListOpVaultsResponse,
  OnePasswordSettingsResponse,
  OpItemDetailResponse,
} from "@valet/api/wire";
import { ApiError } from "~/api/client";

const putSettingsMutate = vi.fn();
const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const connectMutate = vi.fn();
const disconnectMutate = vi.fn();

let orgData: { callerRole: "admin" | "member" } = { callerRole: "admin" };
let settingsData: OnePasswordSettingsResponse | undefined = {
  allowPersonal: false,
  orgTokenConnected: false,
  personalTokenConnected: false,
};
let userCredentialsData: { credentials: CredentialSummary[] } = { credentials: [] };
let orgCredentialsData: { credentials: CredentialSummary[] } = { credentials: [] };
let vaultsData: ListOpVaultsResponse = { vaults: [{ id: "v1", title: "Vault One" }] };
let itemsData: ListOpItemsResponse = { items: [{ id: "i1", title: "Item One", vaultId: "v1" }] };
let itemDetailData: OpItemDetailResponse = {
  id: "i1",
  title: "Item One",
  fields: [{ id: "f1", title: "credential", fieldType: "CONCEALED" }],
};

vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
}));

vi.mock("~/api/onepassword", () => ({
  useOnePasswordSettings: () => ({ data: settingsData, isLoading: false, error: null }),
  usePutOnePasswordSettings: () => ({ mutate: putSettingsMutate, isPending: false, error: null }),
  useOpVaults: () => ({ data: vaultsData, isLoading: false, error: null }),
  useOpItems: (_scope: string, vaultId: string | undefined) => ({
    data: vaultId ? itemsData : undefined,
    isLoading: false,
    error: null,
  }),
  useOpItemDetail: (_scope: string, vaultId: string | undefined, itemId: string | undefined) => ({
    data: vaultId && itemId ? itemDetailData : undefined,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("~/api/integrations", () => ({
  useCredentials: (scope: "user" | "org" = "user", opts?: { enabled?: boolean }) => {
    if (scope === "org") {
      return {
        data: opts?.enabled === false ? undefined : orgCredentialsData,
        isLoading: false,
        error: null,
      };
    }
    return { data: userCredentialsData, isLoading: false, error: null };
  },
  useConnectCredential: () => ({
    mutate: connectMutate,
    mutateAsync: connectMutateAsync,
    isPending: false,
    error: null,
  }),
  useDisconnectCredential: () => ({ mutate: disconnectMutate, isPending: false }),
}));

import { OnePasswordPanel } from "./onepassword-panel";

describe("OnePasswordPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMutateAsync.mockResolvedValue({ ok: true });
    orgData = { callerRole: "admin" };
    settingsData = { allowPersonal: false, orgTokenConnected: false, personalTokenConnected: false };
    userCredentialsData = { credentials: [] };
    orgCredentialsData = { credentials: [] };
    vaultsData = { vaults: [{ id: "v1", title: "Vault One" }] };
    itemsData = { items: [{ id: "i1", title: "Item One", vaultId: "v1" }] };
    itemDetailData = {
      id: "i1",
      title: "Item One",
      fields: [{ id: "f1", title: "credential", fieldType: "CONCEALED" }],
    };
    vi.stubGlobal("confirm", vi.fn(() => true));
  });

  it("member with no tokens sees the empty copy, not the org token card or toggle", () => {
    orgData = { callerRole: "member" };
    render(<OnePasswordPanel />);
    expect(
      screen.getByText("An admin can connect an organization 1Password token on this page."),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Organization 1Password token")).toBeNull();
    expect(screen.queryByLabelText("Allow personal tokens")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add from 1Password" })).toBeNull();
  });

  it("admin sees the token field and the allow-personal toggle", () => {
    render(<OnePasswordPanel />);
    expect(screen.getByLabelText("Organization 1Password token")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Allow personal tokens" })).toBeTruthy();
  });

  it("shows a Connected badge when the org token is already set", () => {
    settingsData = { allowPersonal: false, orgTokenConnected: true, personalTokenConnected: false };
    render(<OnePasswordPanel />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rotate" })).toBeTruthy();
  });

  it("saving the org token fires the connect mutation with scope: org", async () => {
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.type(screen.getByLabelText("Organization 1Password token"), "op-token-123");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(connectMutateAsync).toHaveBeenCalledWith({
        service: "onepassword",
        body: { type: "service_account", apiKey: "op-token-123", scope: "org" },
      }),
    );
  });

  it("shows an inline error when saving the org token fails", async () => {
    connectMutateAsync.mockRejectedValueOnce(
      new ApiError(400, "PUT /credentials/onepassword → 400", { error: "1Password resolution failed" }),
    );
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.type(screen.getByLabelText("Organization 1Password token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("1Password resolution failed")).toBeTruthy();
  });

  it("toggling allow-personal fires the PUT mutation", () => {
    render(<OnePasswordPanel />);
    fireEvent.click(screen.getByRole("switch", { name: "Allow personal tokens" }));
    expect(putSettingsMutate).toHaveBeenCalledWith({ allowPersonal: true });
  });

  it("hides the personal token card when allowPersonal is false", () => {
    render(<OnePasswordPanel />);
    expect(screen.queryByLabelText("1Password personal token")).toBeNull();
  });

  it("shows the personal token card when allowPersonal is true", () => {
    settingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
    render(<OnePasswordPanel />);
    expect(screen.getByLabelText("1Password personal token")).toBeTruthy();
  });

  it("saving the personal token fires the connect mutation with no scope field", async () => {
    orgData = { callerRole: "member" };
    settingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.type(screen.getByLabelText("1Password personal token"), "op-personal-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(connectMutateAsync).toHaveBeenCalledWith({
        service: "onepassword",
        body: { type: "service_account", apiKey: "op-personal-token" },
      }),
    );
  });

  it("lists org-scoped reference credentials with the 1Password badge, excluding the reserved onepassword row", () => {
    orgCredentialsData = {
      credentials: [
        { service: "onepassword", type: "service_account", connectedAt: "2026-01-01T00:00:00Z" },
        {
          service: "linear",
          type: "api_key",
          connectedAt: "2026-01-02T00:00:00Z",
          onepasswordRef: "op://Vault One/Item One/credential",
        },
      ],
    };
    render(<OnePasswordPanel />);
    expect(screen.getByText("linear")).toBeTruthy();
    expect(screen.getByText("op://Vault One/Item One/credential")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke onepassword" })).toBeNull();
  });

  it("the tokenScope selector offers only Personal when the org token is not connected", async () => {
    settingsData = { allowPersonal: true, orgTokenConnected: false, personalTokenConnected: false };
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.click(screen.getByRole("button", { name: "Add from 1Password" }));
    const scopeSelect = screen.getByLabelText("1Password token") as HTMLSelectElement;
    const optionLabels = Array.from(scopeSelect.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(["Personal"]);
  });

  it("the tokenScope selector offers Organization once the org token is connected", async () => {
    settingsData = { allowPersonal: true, orgTokenConnected: true, personalTokenConnected: false };
    const user = userEvent.setup();
    render(<OnePasswordPanel />);
    await user.click(screen.getByRole("button", { name: "Add from 1Password" }));
    const scopeSelect = screen.getByLabelText("1Password token") as HTMLSelectElement;
    const optionLabels = Array.from(scopeSelect.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(["Personal", "Organization"]);
  });

  it("admin picker cascade composes the reference and creating fires the PUT with scope: org", async () => {
    settingsData = { allowPersonal: false, orgTokenConnected: true, personalTokenConnected: false };
    const user = userEvent.setup();
    render(<OnePasswordPanel />);

    await user.click(screen.getByRole("button", { name: "Add from 1Password" }));
    await user.type(screen.getByLabelText("Service name"), "linear");

    const vaultSelect = screen.getByLabelText("Vault") as HTMLSelectElement;
    const itemSelect = screen.getByLabelText("Item") as HTMLSelectElement;
    const fieldSelect = screen.getByLabelText("Field") as HTMLSelectElement;
    expect(itemSelect.disabled).toBe(true);
    expect(fieldSelect.disabled).toBe(true);

    await user.selectOptions(vaultSelect, "v1");
    expect(itemSelect.disabled).toBe(false);

    await user.selectOptions(itemSelect, "i1");
    expect(fieldSelect.disabled).toBe(false);

    await user.selectOptions(fieldSelect, "f1");
    expect(screen.getByText("op://Vault One/Item One/credential")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(connectMutate).toHaveBeenCalledWith(
      {
        service: "linear",
        body: {
          type: "api_key",
          onepassword: { reference: "op://Vault One/Item One/credential", tokenScope: "org" },
          scope: "org",
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("member creating a reference via the org token does not send scope: org", async () => {
    orgData = { callerRole: "member" };
    settingsData = { allowPersonal: false, orgTokenConnected: true, personalTokenConnected: false };
    const user = userEvent.setup();
    render(<OnePasswordPanel />);

    await user.click(screen.getByRole("button", { name: "Add from 1Password" }));
    await user.type(screen.getByLabelText("Service name"), "linear");
    await user.selectOptions(screen.getByLabelText("Vault"), "v1");
    await user.selectOptions(screen.getByLabelText("Item"), "i1");
    await user.selectOptions(screen.getByLabelText("Field"), "f1");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(connectMutate).toHaveBeenCalledWith(
      {
        service: "linear",
        body: {
          type: "api_key",
          onepassword: { reference: "op://Vault One/Item One/credential", tokenScope: "org" },
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });
});
