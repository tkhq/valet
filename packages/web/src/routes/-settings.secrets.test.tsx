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
}));

import { SecretsPage } from "./settings.secrets";
import { OrganizationSecretsPage } from "./settings.organization.secrets";
import { TeamSecretsTab } from "./settings.teams.$teamId.secrets";

describe("SecretsPage", () => {
  beforeEach(() => {
    saveMutate.mockReset();
    targets.length = 0;
  });

  it("says the store is off and shows no form, naming the server setting only to an admin", () => {
    data = { enabled: false, provider: null, canWrite: false, secrets: [] };
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
      secrets: [{ name: "granola/api-key", reference: "secret://personal/granola/api-key", createdAt: 0 }],
    };
    render(<SecretsPage />);
    expect(screen.getByText("granola/api-key")).toBeTruthy();
    expect(screen.getByText("secret://personal/granola/api-key")).toBeTruthy();
    expect(screen.getByText(/encrypted in your browser and stored in Turnkey/)).toBeTruthy();
  });

  it("sends the trimmed name and the exact value on submit", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: true, secrets: [] };
    render(<SecretsPage />);
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "  k  " } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: " v\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith({ name: "k", value: " v\n" }, expect.anything());
  });

  it("replaces a saved value from its row", () => {
    data = {
      enabled: true,
      provider: "Turnkey",
      canWrite: true,
      secrets: [{ name: "K", reference: "secret://personal/K", createdAt: 0 }],
    };
    render(<SecretsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("New value for K"), { target: { value: "v2" } });
    const saves = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saves[saves.length - 1]!);
    expect(saveMutate).toHaveBeenCalledWith({ name: "K", value: "v2", replace: true }, expect.anything());
  });

  it("keeps the personal page personal, with no scope tabs", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: true, secrets: [] };
    render(<SecretsPage />);
    expect(targets.at(-1)).toEqual({ scope: "personal" });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("Only sessions you own personally can use these.")).toBeTruthy();
  });

  it("shows a team's secrets on its tab, read-only when the API refuses writes", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: false, secrets: [{ name: "K", reference: "secret://team/t1/K", createdAt: 0 }] };
    render(<TeamSecretsTab teamId="t1" />);
    expect(targets.at(-1)).toEqual({ scope: "team", teamId: "t1" });
    expect(screen.getByText(/Team members can change them/)).toBeTruthy();
    expect(screen.getByText("K")).toBeTruthy();
    expect(screen.queryByLabelText("Secret value")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("lets a team member save on the team tab", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: true, secrets: [] };
    render(<TeamSecretsTab teamId="t1" />);
    expect(screen.getByLabelText("Secret value")).toBeTruthy();
  });

  it("shows the organization's secrets on the organization page", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: true, secrets: [] };
    render(<OrganizationSecretsPage />);
    expect(targets.at(-1)).toEqual({ scope: "company" });
    expect(screen.getByText(/Organization admins can change them/)).toBeTruthy();
  });
});
