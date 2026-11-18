// @vitest-environment jsdom
/**
 * Settings · Secrets. The query hooks are mocked, so these tests check what
 * the page shows for each store state and scope, and what it sends on save.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SecretsListResponse } from "@valet/api/wire";
import type { SecretTarget } from "~/api/secrets";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

let data: SecretsListResponse | undefined;
const targets: SecretTarget[] = [];
const saveMutate = vi.fn();
vi.mock("~/api/secrets", () => ({
  useSecrets: (target: SecretTarget) => {
    targets.push(target);
    return { data, isLoading: false, error: null };
  },
  useSaveSecret: () => ({ mutate: saveMutate, isPending: false, error: null }),
  useDeleteSecret: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
let orgRole: "admin" | "member" = "member";
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { orgRole } }),
  useTeams: () => ({
    data: {
      teams: [
        { id: "t1", name: "Platform", callerRole: "member" },
        { id: "t2", name: "Not mine", callerRole: null },
      ],
    },
  }),
}));

import { SecretsPage } from "./settings.secrets";

describe("SecretsPage", () => {
  beforeEach(() => {
    saveMutate.mockReset();
    targets.length = 0;
  });

  it("says the store is off and shows no form, naming the server setting only to an admin", () => {
    data = { enabled: false, provider: null, canWrite: false, useAvailable: false, secrets: [] };
    orgRole = "member";
    const view = render(<SecretsPage />);
    expect(screen.getByText("Secrets are not set up on this Valet. Ask an admin to turn them on.")).toBeTruthy();
    expect(screen.queryByText(/VALET_SECRET_STORE/)).toBeNull();
    expect(screen.queryByLabelText("Secret value")).toBeNull();
    view.unmount();
    orgRole = "admin";
    render(<SecretsPage />);
    expect(screen.getByText(/VALET_SECRET_STORE/)).toBeTruthy();
  });

  it("lists names with their references and names the provider", () => {
    data = {
      enabled: true,
      provider: "Turnkey",
      canWrite: true,
      useAvailable: false,
      secrets: [{ name: "granola/api-key", reference: "secret://personal/granola/api-key", createdAt: 0 }],
    };
    render(<SecretsPage />);
    expect(screen.getByText("granola/api-key")).toBeTruthy();
    expect(screen.getByText("secret://personal/granola/api-key")).toBeTruthy();
    expect(screen.getByText(/encrypted in your browser and stored in Turnkey/)).toBeTruthy();
  });

  it("sends the trimmed name and the exact value on submit", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: true, useAvailable: false, secrets: [] };
    render(<SecretsPage />);
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "  k  " } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: " v\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith({ name: "k", value: " v\n" }, expect.anything());
  });

  it("saves a use-only secret only with a host, with the picked header", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: true, useAvailable: true, secrets: [] };
    render(<SecretsPage />);
    expect(screen.getByText(/Commands in a session can read this value/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "HETZNER" } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use only with one host" }));
    // The host is required and the header picker shows before any host.
    expect(screen.getByLabelText("Header the secret goes in")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "https://api.hetzner.cloud/v1" } });
    expect(screen.getByText(/The agent never gets this value/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Header the secret goes in"), { target: { value: "apiKey" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith(
      { name: "HETZNER", value: "tok", use: { hosts: ["api.hetzner.cloud"], header: "x-api-key", format: "{secret}" } },
      expect.anything(),
    );
  });

  it("pre-fills the host and header from a known key format", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: true, useAvailable: true, secrets: [] };
    render(<SecretsPage />);
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "sk-ant-" + "a".repeat(40) } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use only with one host" }));
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("api.anthropic.com");
    expect((screen.getByLabelText("Header the secret goes in") as HTMLSelectElement).value).toBe("apiKey");
  });

  it("shows where a use-only secret goes and keeps its rule on replace", () => {
    const use = { hosts: ["api.hetzner.cloud"], header: "authorization", format: "Bearer {secret}" };
    data = {
      enabled: true,
      provider: "Turnkey",
      canWrite: true,
      useAvailable: true,
      secrets: [
        { name: "H", reference: "secret://personal/H", createdAt: 0, use, uses: { count: 2, lastUsedAt: Date.UTC(2026, 10, 18, 12) } },
        { name: "N", reference: "secret://personal/N", createdAt: 0, use, uses: { count: 0, lastUsedAt: null } },
      ],
    };
    render(<SecretsPage />);
    expect(screen.getAllByText("Only for api.hetzner.cloud, in the authorization header as Bearer")).toHaveLength(2);
    expect(screen.getByText(/^Used 2 times, last /)).toBeTruthy();
    expect(screen.getByText("Not used yet")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Replace" })[0]!);
    fireEvent.change(screen.getByLabelText("New value for H"), { target: { value: "v2" } });
    const saves = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saves[saves.length - 1]!);
    expect(saveMutate).toHaveBeenCalledWith({ name: "H", value: "v2", replace: true, use }, expect.anything());
  });

  it("replaces a saved value from its row", () => {
    data = {
      enabled: true,
      provider: "Turnkey",
      canWrite: true,
      useAvailable: false,
      secrets: [{ name: "K", reference: "secret://personal/K", createdAt: 0 }],
    };
    render(<SecretsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("New value for K"), { target: { value: "v2" } });
    const saves = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saves[saves.length - 1]!);
    expect(saveMutate).toHaveBeenCalledWith({ name: "K", value: "v2", replace: true }, expect.anything());
  });

  it("offers the caller's teams and the organization, and hides the form where the caller cannot write", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: false, useAvailable: false, secrets: [] };
    render(<SecretsPage />);
    expect(screen.getByRole("tab", { name: "Platform" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Not mine" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Organization" }));
    expect(targets.at(-1)).toEqual({ scope: "company" });
    fireEvent.click(screen.getByRole("tab", { name: "Platform" }));
    expect(targets.at(-1)).toEqual({ scope: "team", teamId: "t1" });
    expect(screen.queryByLabelText("Secret value")).toBeNull();
  });
});
