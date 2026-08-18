// @vitest-environment jsdom
/**
 * TeamSyncSection — the Settings control over `features.ssoTeamSync`
 * (`PATCH /api/org`). The section renders only where the write can land:
 * for an org admin, on a deployment with an OIDC provider. Turning the
 * sync ON confirms first, because the next sign-in of each member undoes
 * manual membership edits on mirrored teams. Turning it OFF applies
 * directly — it deletes nothing and unlocks the mirrored teams.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let callerRole: "admin" | "member" = "admin";
let ssoTeamSync = false;
let sso: { name: string } | null = { name: "Keycloak" };

const mutateAsync = vi.fn().mockResolvedValue({});
let patchError: Error | null = null;

vi.mock("~/api/settings", () => ({
  useOrg: () => ({
    data: { features: { organizations: true, ssoTeamSync }, callerRole },
    isLoading: false,
    error: null,
  }),
  usePatchOrg: () => ({ mutateAsync, isPending: false, error: patchError }),
}));

vi.mock("~/api/auth-config", () => ({
  useAuthConfig: () => ({ data: { stub: false, social: [], sso }, isLoading: false, error: null }),
}));

import { TeamSyncSection } from "./team-sync-section";

beforeEach(() => {
  callerRole = "admin";
  ssoTeamSync = false;
  sso = { name: "Keycloak" };
  patchError = null;
  mutateAsync.mockClear();
});

describe("TeamSyncSection visibility", () => {
  it("renders the switch for an org admin on an SSO deployment", () => {
    render(<TeamSyncSection />);
    const toggle = screen.getByRole("switch", { name: "Team sync" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders nothing for a plain member", () => {
    callerRole = "member";
    const { container } = render(<TeamSyncSection />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when no OIDC provider is configured", () => {
    sso = null;
    const { container } = render(<TeamSyncSection />);
    expect(container.innerHTML).toBe("");
  });
});

describe("TeamSyncSection writes", () => {
  it("confirms before turning the sync on, then PATCHes true", async () => {
    render(<TeamSyncSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Team sync" }));

    // Nothing is written until the reader confirms.
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText("Turn on team sync?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ features: { ssoTeamSync: true } }),
    );
  });

  it("cancelling the confirm writes nothing", () => {
    render(<TeamSyncSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Team sync" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("turns the sync off directly, with no confirm", async () => {
    ssoTeamSync = true;
    render(<TeamSyncSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Team sync" }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ features: { ssoTeamSync: false } }),
    );
    expect(screen.queryByText("Turn on team sync?")).toBeNull();
  });

  it("shows the PATCH error", () => {
    patchError = new Error("features.ssoTeamSync must be a boolean");
    render(<TeamSyncSection />);
    expect(screen.getByText("features.ssoTeamSync must be a boolean")).toBeTruthy();
  });
});
