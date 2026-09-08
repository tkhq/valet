// @vitest-environment jsdom
/**
 * Team workspace API keys follow the switcher. Create states the place.
 * There is no owner picker.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const createTeamKeyMutate = vi.fn();

vi.mock("~/lib/workspace-scope", () => ({
  PERSONAL: "user",
  useWorkspaceScope: () => ({
    key: "team_1",
    teamId: "team_1",
    available: ["user", "team_1"],
    setKey: () => {},
  }),
}));

vi.mock("~/api/settings", () => ({
  useTeams: () => ({
    data: {
      teams: [
        {
          id: "team_1",
          orgId: "org_1",
          name: "Platform",
          origin: "local",
          externalId: null,
          createdAt: 1,
          memberCount: 2,
          callerRole: "admin",
          defaultModel: null,
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
  useOrg: () => ({
    data: { callerRole: "admin", features: { organizations: true } },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("~/api/api-keys", () => ({
  useApiKeys: () => ({ data: [], isLoading: false, error: null }),
  useCreateApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRevokeApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useTeamApiKeys: () => ({ data: [], isLoading: false, error: null }),
  useCreateTeamApiKey: () => ({ mutate: createTeamKeyMutate, isPending: false, error: null }),
  useRevokeTeamApiKey: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

vi.mock("~/lib/use-copy", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}));

import { ApiKeysSection } from "./api-keys-section";

function Wrapper({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}

describe("ApiKeysSection — team workspace", () => {
  beforeEach(() => {
    createTeamKeyMutate.mockClear();
  });

  it("states the workspace and has no owner picker", () => {
    render(
      <Wrapper>
        <ApiKeysSection />
      </Wrapper>,
    );
    expect(screen.getByText(/belongs to/)).toBeTruthy();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText(/owner/i)).toBeNull();
    expect(screen.getByText(/No API keys in Platform yet/)).toBeTruthy();
  });

  it("creates against the active team, not a picked owner", () => {
    render(<ApiKeysSection />);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "CI" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createTeamKeyMutate).toHaveBeenCalledWith("CI", expect.objectContaining({ onSuccess: expect.any(Function) }));
  });
});
