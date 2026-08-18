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
let ssoTeamGroups: string[] = [];
/** `origin: "idp"` team rows the group list unions in by `externalId`. */
let mirroredTeamPaths: string[] = [];

const mutateAsync = vi.fn().mockResolvedValue({});
let patchError: Error | null = null;

vi.mock("~/api/settings", () => ({
  useOrg: () => ({
    data: { features: { organizations: true, ssoTeamSync }, ssoTeamGroups, callerRole },
    isLoading: false,
    error: null,
  }),
  usePatchOrg: () => ({ mutateAsync, isPending: false, error: patchError }),
  useTeams: () => ({
    data: {
      teams: mirroredTeamPaths.map((path, i) => ({
        id: `team_${i}`,
        orgId: "org_1",
        name: path.slice(1),
        origin: "idp",
        externalId: path,
        createdAt: 1,
        memberCount: 1,
        callerRole: null,
      })),
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("~/api/auth-config", () => ({
  useAuthConfig: () => ({ data: { stub: false, social: [], sso }, isLoading: false, error: null }),
}));

import { TeamSyncSection } from "./team-sync-section";

beforeEach(() => {
  callerRole = "admin";
  ssoTeamSync = false;
  sso = { name: "Keycloak" };
  ssoTeamGroups = [];
  mirroredTeamPaths = [];
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

  it("turns one group's sync off, keeping the others", async () => {
    ssoTeamSync = true;
    ssoTeamGroups = ["/platform", "/research"];
    render(<TeamSyncSection />);

    fireEvent.click(screen.getByRole("switch", { name: "Sync /platform" }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ ssoTeamGroups: ["/research"] }),
    );
  });

  it("offers a dormant mirror's group as an off switch, and turns it back on", async () => {
    // The team exists (origin idp) but its group left the allowlist. The
    // list is the union, so the group still has a row — off — and turning
    // it on adds the path back.
    ssoTeamSync = true;
    ssoTeamGroups = ["/platform"];
    mirroredTeamPaths = ["/platform", "/legacy"];
    render(<TeamSyncSection />);

    const dormant = screen.getByRole("switch", { name: "Sync /legacy" });
    expect(dormant.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(dormant);
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ ssoTeamGroups: ["/platform", "/legacy"] }),
    );
  });

  it("adds a new group path from the input", async () => {
    ssoTeamSync = true;
    ssoTeamGroups = ["/platform"];
    render(<TeamSyncSection />);

    fireEvent.change(screen.getByLabelText("Group path"), { target: { value: "/research" } });
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ ssoTeamGroups: ["/platform", "/research"] }),
    );
  });

  it("says so when the added group is already listed, and writes nothing", () => {
    ssoTeamSync = true;
    ssoTeamGroups = ["/platform"];
    render(<TeamSyncSection />);

    fireEvent.change(screen.getByLabelText("Group path"), { target: { value: "/platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/already listed/)).toBeTruthy();
  });

  it("rejects a bad path in place, naming the shape, and writes nothing", () => {
    ssoTeamSync = true;
    render(<TeamSyncSection />);

    fireEvent.change(screen.getByLabelText("Group path"), { target: { value: "platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/top-level group path/)).toBeTruthy();
  });

  it("keeps a failed PATCH from escaping as an unhandled rejection", async () => {
    // react-query stores the failure and the row renders `patchOrg.error`;
    // the promise itself must still be handled, or every failed flip prints
    // an unhandled-rejection error at runtime.
    mutateAsync.mockRejectedValueOnce(new Error("boom"));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      ssoTeamSync = true;
      render(<TeamSyncSection />);
      fireEvent.click(screen.getByRole("switch", { name: "Team sync" }));
      await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
      // Two macrotask turns: Node reports an orphaned rejection only after
      // the microtask queue that produced it has drained.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
