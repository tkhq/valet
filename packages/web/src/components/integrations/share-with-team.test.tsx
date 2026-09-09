// @vitest-environment jsdom
/**
 * Two rules that are invisible from this file alone.
 *
 * 1. "Stop sharing", not "Disconnect": dropping a share cuts the team's link
 *    and leaves the caller connected. `settings/teams-panel.test.tsx`
 *    ("removing a team credential") pins the same verb for the same action;
 *    "Disconnect" is reserved for deleting a secret the team itself stores.
 * 2. Each button calls the non-throwing `mutate`. `main.tsx` sets no
 *    MutationCache `onError`, so a `void mutateAsync(...)` rejection reported
 *    one failed share twice: in the row, and at `window.onunhandledrejection`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CredentialSummary, TeamSummary } from "@valet/api/wire";
import { ApiError } from "~/api/client";

type DelegateVars = { service: string; body: { teamId: string } };
type RevokeVars = { service: string; teamId: string };

const delegateMutate = vi.fn();
const delegateMutateAsync = vi.fn();
const revokeMutate = vi.fn();
const revokeMutateAsync = vi.fn();
let teams: TeamSummary[] = [];
let teamCreds: CredentialSummary[] = [];
let delegateFailure: Error | null = null;
let revokeFailure: Error | null = null;

/**
 * Both call styles record the failure on `error`; only `mutateAsync` also
 * rejects. A separate spy per style tells a test which one the row picked.
 */
function useFakeMutation<V>(
  mutate: (vars: V) => void,
  mutateAsync: (vars: V) => void,
  failure: Error | null,
) {
  const [error, setError] = useState<Error | null>(null);
  return {
    mutate: (vars: V) => {
      mutate(vars);
      setError(failure);
    },
    mutateAsync: (vars: V) => {
      mutateAsync(vars);
      setError(failure);
      return failure === null ? Promise.resolve() : Promise.reject(failure);
    },
    isPending: false,
    error,
  };
}

vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u1" } }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));

vi.mock("~/api/integrations", () => ({
  useCredentials: () => ({ data: { credentials: teamCreds }, isLoading: false, error: null }),
  useDelegateCredential: () =>
    useFakeMutation<DelegateVars>(delegateMutate, delegateMutateAsync, delegateFailure),
  useRevokeDelegation: () =>
    useFakeMutation<RevokeVars>(revokeMutate, revokeMutateAsync, revokeFailure),
}));

import { ShareWithTeam } from "./share-with-team";

const TEAM: TeamSummary = {
  id: "team_1",
  orgId: "org_1",
  name: "Engineering",
  origin: "local",
  externalId: null,
  createdAt: 1,
  memberCount: 2,
  callerRole: "member",
  defaultModel: null,
  defaultReasoning: null,
};

/** Only an org admin is ever sent a team they are not on: the list route
 * gives a plain member `listTeamsForUser`, whose rows all carry a role. */
const NOT_MY_TEAM: TeamSummary = { ...TEAM, id: "team_2", name: "Platform", callerRole: null };

/** A share this caller already made, so the row offers Stop sharing. */
const SHARED_BY_ME: CredentialSummary[] = [
  { service: "linear", type: "oauth2", connectedAt: "2026-09-01T00:00:00Z", delegatedFrom: "u1" },
];

function openMenu() {
  render(<ShareWithTeam service="linear" title="Linear" />);
  fireEvent.click(screen.getByRole("button", { name: "Share Linear with a team" }));
}

describe("ShareWithTeam", () => {
  beforeEach(() => {
    teams = [TEAM];
    teamCreds = [];
    delegateFailure = null;
    revokeFailure = null;
    delegateMutate.mockReset();
    delegateMutateAsync.mockReset();
    revokeMutate.mockReset();
    revokeMutateAsync.mockReset();
  });

  it("shares the caller's credential with a team they belong to", async () => {
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Share Linear with Engineering" }));
    await waitFor(() =>
      expect(delegateMutate).toHaveBeenCalledWith({ service: "linear", body: { teamId: "team_1" } }),
    );
  });

  it("stops a share the caller already made, under the label the panel uses", async () => {
    teamCreds = SHARED_BY_ME;
    openMenu();

    // The row dropped the team's link before this change too, but called it
    // "Revoke" while the settings panel called the same action "Disconnect".
    // Neither word may come back.
    expect(screen.getByRole("button", { name: /^Stop sharing/ }).textContent).toBe("Stop sharing");
    expect(screen.queryByRole("button", { name: /Revoke/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stop sharing Linear with Engineering" }));
    await waitFor(() =>
      expect(revokeMutate).toHaveBeenCalledWith({ service: "linear", teamId: "team_1" }),
    );
  });

  it("leaves out a team the caller is not on, and says why", () => {
    // The delegate route answers 404 for a non-member, so this row could only
    // ever fail. An org admin is the only caller who is sent one.
    teams = [TEAM, NOT_MY_TEAM];
    openMenu();
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share Linear with Platform" })).toBeNull();
    expect(
      screen.getByText(
        "Teams you are not on are not listed. Add yourself to a team in Settings → Organization → Teams to share with it.",
      ),
    ).toBeTruthy();
  });

  it("says nothing about hidden teams to a member, who is sent none", () => {
    teams = [TEAM];
    openMenu();
    expect(screen.queryByText(/are not listed/)).toBeNull();
  });

  it("tells a member with no team who can add them", () => {
    teams = [];
    openMenu();
    expect(
      screen.getByText(
        "You are not on a team yet. Ask a team admin to add you, then share your Linear connection.",
      ),
    ).toBeTruthy();
  });

  it("names a failed share in the row and leaves no rejection behind", async () => {
    delegateFailure = new ApiError(409, "POST /api/credentials/linear/delegate → 409");
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Share Linear with Engineering" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "This team already has Linear. Ask a team admin to change it in Settings → Organization → Teams.",
        ),
      ).toBeTruthy(),
    );
    // `void mutateAsync(...)` would report this same 409 a second time, at
    // window.onunhandledrejection.
    expect(delegateMutateAsync).not.toHaveBeenCalled();
  });

  it("names a failed unshare in the row and leaves no rejection behind", async () => {
    teamCreds = SHARED_BY_ME;
    revokeFailure = new Error("Failed to fetch");
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing Linear with Engineering" }));
    await waitFor(() =>
      expect(
        screen.getByText("Failed to fetch. Check the server is running, then try again."),
      ).toBeTruthy(),
    );
    expect(revokeMutateAsync).not.toHaveBeenCalled();
  });

  it("tells an org admin on no team where to add themselves", () => {
    // Every team is filtered out, so the hidden-team note is the whole answer
    // and must not be replaced by the "not on a team yet" copy.
    teams = [NOT_MY_TEAM];
    openMenu();
    expect(screen.queryByText(/Ask a team admin to add you/)).toBeNull();
    expect(screen.getByText(/Add yourself to a team in Settings → Organization → Teams/)).toBeTruthy();
  });
});
