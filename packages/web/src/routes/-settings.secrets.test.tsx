// @vitest-environment jsdom
/**
 * Settings · Secrets. The query hooks are mocked, so these tests check what
 * the page shows for each store state and what it sends on save.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { SecretsListResponse } from "@valet/api/wire";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

let data: SecretsListResponse | undefined;
const saveMutate = vi.fn();
vi.mock("~/api/secrets", () => ({
  useSecrets: () => ({ data, isLoading: false, error: null }),
  useSaveSecret: () => ({ mutate: saveMutate, isPending: false, error: null }),
  useDeleteSecret: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

import { PersonalSecretsPage } from "./settings.secrets";

describe("PersonalSecretsPage", () => {
  beforeEach(() => {
    saveMutate.mockReset();
  });

  it("says the store is off and shows no form", () => {
    data = { enabled: false, provider: null, secrets: [] };
    render(<PersonalSecretsPage />);
    expect(screen.getByText(/VALET_SECRET_STORE/)).toBeTruthy();
    expect(screen.queryByLabelText("Secret value")).toBeNull();
  });

  it("lists names with their references and names the provider", () => {
    data = {
      enabled: true,
      provider: "Turnkey",
      secrets: [{ name: "granola/api-key", reference: "secret://personal/granola/api-key", createdAt: 0 }],
    };
    render(<PersonalSecretsPage />);
    expect(screen.getByText("granola/api-key")).toBeTruthy();
    expect(screen.getByText("secret://personal/granola/api-key")).toBeTruthy();
    expect(screen.getByText(/stored in Turnkey/)).toBeTruthy();
  });

  it("sends the trimmed name and the exact value on submit", () => {
    data = { enabled: true, provider: "Turnkey", secrets: [] };
    render(<PersonalSecretsPage />);
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "  k  " } });
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: " v\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saveMutate).toHaveBeenCalledWith({ name: "k", value: " v\n" }, expect.anything());
  });
});
