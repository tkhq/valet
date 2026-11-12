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
vi.mock("~/api/settings", () => ({
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

  it("says the store is off and shows no form", () => {
    data = { enabled: false, provider: null, canWrite: false, secrets: [] };
    render(<SecretsPage />);
    expect(screen.getByText(/VALET_SECRET_STORE/)).toBeTruthy();
    expect(screen.queryByLabelText("Secret value")).toBeNull();
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

  it("offers the caller's teams and the company, and hides the form where the caller cannot write", () => {
    data = { enabled: true, provider: "Turnkey", canWrite: false, secrets: [] };
    render(<SecretsPage />);
    expect(screen.getByRole("tab", { name: "Platform" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Not mine" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Company" }));
    expect(targets.at(-1)).toEqual({ scope: "company" });
    fireEvent.click(screen.getByRole("tab", { name: "Platform" }));
    expect(targets.at(-1)).toEqual({ scope: "team", teamId: "t1" });
    expect(screen.queryByLabelText("Secret value")).toBeNull();
  });
});
