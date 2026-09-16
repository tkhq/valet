// @vitest-environment jsdom
/**
 * Team Integrations → share one of your own connections with this team.
 * The same write as `ShareWithTeam`, offered from the team's own page.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CredentialSummary } from "@valet/api/wire";

const delegateMutate = vi.fn();
let mine: CredentialSummary[] = [];
let teamCreds: CredentialSummary[] = [];

vi.mock("~/api/integrations", () => ({
  useCredentials: (scope: string) => ({
    data: { credentials: scope === "team" ? teamCreds : mine },
    isLoading: false,
    error: null,
  }),
  useDelegateCredential: () => ({
    mutate: delegateMutate,
    isPending: false,
    error: null,
    reset: vi.fn(),
  }),
}));

import { PullFromPersonal, blockedReason } from "./pull-from-personal";

const cred = (over: Partial<CredentialSummary> = {}): CredentialSummary => ({
  service: "linear",
  type: "api_key",
  connectedAt: "2026-09-01T00:00:00Z",
  ...over,
});

async function openPicker() {
  const user = userEvent.setup();
  render(<PullFromPersonal teamId="t1" teamName="Platform" />);
  await user.click(screen.getByRole("button", { name: "Share one of your connections with Platform" }));
  return user;
}

describe("PullFromPersonal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mine = [cred()];
    teamCreds = [];
  });

  it("shares the caller's own credential with the team being viewed", async () => {
    const user = await openPicker();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Share Linear with Platform" }));
    expect(delegateMutate).toHaveBeenCalledWith({ service: "linear", body: { teamId: "t1" } });
  });

  // The route accepts a bare team id and never sees this box, so it is a
  // statement the person makes to themselves. Gating the control on it is
  // the only thing that makes it mean anything.
  it("will not share until the authorization box is ticked", async () => {
    const user = await openPicker();
    const share = screen.getByRole("button", { name: "Share Linear with Platform" });
    expect((share as HTMLButtonElement).disabled).toBe(true);
    await user.click(share);
    expect(delegateMutate).not.toHaveBeenCalled();
  });

  it("says so when the team already has that service", async () => {
    teamCreds = [cred()];
    const user = await openPicker();
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByText("This team already has a connection for this service.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Share Linear with Platform" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("names its own connections empty state", async () => {
    mine = [];
    await openPicker();
    expect(screen.getByText(/You have no personal connections yet/)).toBeTruthy();
  });
});

// A team read follows only an org-scope reference, and the 1Password token
// itself is a key to whole vaults rather than one service's credential.
// Both are refused by the route; saying so in the picker saves the trip.
describe("blockedReason", () => {
  it("blocks the reserved 1Password token row and points at a team service account", () => {
    expect(blockedReason(cred({ service: "onepassword" }), new Set())).toMatch(
      /Connect a team service account instead/,
    );
  });

  it("blocks a personal-scope 1Password reference", () => {
    expect(
      blockedReason(cred({ onepasswordRef: "op://V/I/f", onepasswordTokenScope: "personal" }), new Set()),
    ).toMatch(/a team cannot use/);
  });

  it("allows an org-scope 1Password reference", () => {
    expect(
      blockedReason(cred({ onepasswordRef: "op://V/I/f", onepasswordTokenScope: "org" }), new Set()),
    ).toBeNull();
  });

  it("allows an ordinary stored credential", () => {
    expect(blockedReason(cred(), new Set())).toBeNull();
  });
});
