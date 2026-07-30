// @vitest-environment jsdom
/**
 * Settings shell (split-settings design, Task 5; RBAC design, Task 7): the
 * rail's gate-aware Organization group (now permission-driven per entry —
 * RBAC design, not a blanket admin check), the `/settings` →
 * `/settings/profile` redirect, and the org-route guards' spec-verbatim
 * empty states. `Link`/`redirect` need router context — mocked the same way
 * `-workflows.index.test.tsx` mocks `@tanstack/react-router`, since these
 * tests only care what the shell renders/requests, not that the router
 * itself resolves it.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const useOrgMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useRouterState: () => "/settings/profile",
  createFileRoute: () => (config: unknown) => config,
  redirect: (opts: { to: string }) => ({ isRedirect: true as const, ...opts }),
}));

vi.mock("~/api/settings", () => ({
  useOrg: () => useOrgMock(),
}));

import { SettingsRail } from "~/components/settings/settings-rail";
import { OrgRouteGuard, OrgPermissionGuard } from "./settings.organization";
import { redirectToProfile } from "./settings.index";

type OrgPermission = "org:manage" | "members:manage" | "providers:manage" | "infra:manage" | "credentials:org";

const YOU_LABELS = ["Profile", "Assistant", "Appearance", "Notifications"];
const ALL_ORG_LABELS = ["General", "Members", "Teams", "Models", "GitHub", "Sandbox images"];
const ADMIN_PERMISSIONS: OrgPermission[] = [
  "org:manage",
  "members:manage",
  "providers:manage",
  "infra:manage",
  "credentials:org",
];
const OPERATOR_PERMISSIONS: OrgPermission[] = ["providers:manage", "infra:manage", "credentials:org"];

function mockOrg(
  data: { organizations: boolean; callerRole: "admin" | "operator" | "member"; permissions: OrgPermission[] } | undefined,
  isLoading = false,
) {
  useOrgMock.mockReturnValue({
    data: data && {
      id: "org_1",
      name: "Acme",
      createdAt: 0,
      features: { organizations: data.organizations },
      callerRole: data.callerRole,
      permissions: data.permissions,
    },
    isLoading,
  });
}

describe("SettingsRail", () => {
  it("always renders the four You items", () => {
    mockOrg({ organizations: false, callerRole: "member", permissions: [] });
    render(<SettingsRail />);
    for (const label of YOU_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("hides the Organization group when the gate is off, but surfaces Models under You (single-user-mode fallback)", () => {
    mockOrg({ organizations: false, callerRole: "admin", permissions: ADMIN_PERMISSIONS });
    render(<SettingsRail />);
    // Every ORG label except Models is gone entirely.
    for (const label of ALL_ORG_LABELS) {
      if (label === "Models") continue;
      expect(screen.queryByText(label)).toBeNull();
    }
    // Models moves to the You group and points at /settings/models
    // (the single-user-mode page that reuses the org-admin API).
    const modelsLink = screen.getByText("Models").closest("a");
    expect(modelsLink?.getAttribute("to") ?? modelsLink?.getAttribute("href")).toBe("/settings/models");
  });

  it("hides the Organization group when the caller has no org permissions (and does NOT surface Models under You)", () => {
    mockOrg({ organizations: true, callerRole: "member", permissions: [] });
    render(<SettingsRail />);
    // MODELS_ITEM only appears in single-user mode — an org-mode member
    // with no permissions has no /settings/models access.
    for (const label of ALL_ORG_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows every entry when the gate is on and the caller is admin", () => {
    mockOrg({ organizations: true, callerRole: "admin", permissions: ADMIN_PERMISSIONS });
    render(<SettingsRail />);
    for (const label of ALL_ORG_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows only the operator's permitted entries (Models/GitHub/Sandbox images), not Members/Invites/General", () => {
    mockOrg({ organizations: true, callerRole: "operator", permissions: OPERATOR_PERMISSIONS });
    render(<SettingsRail />);
    expect(screen.getByText("Models")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Sandbox images")).toBeTruthy();
    expect(screen.queryByText("General")).toBeNull();
    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.queryByText("Teams")).toBeNull();
  });

  it("renders nothing for the Organization group before the org query resolves", () => {
    mockOrg(undefined, true);
    render(<SettingsRail />);
    for (const label of ALL_ORG_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows a You·Models item in single-user mode (org gate off)", () => {
    mockOrg({ organizations: false, callerRole: "admin", permissions: ADMIN_PERMISSIONS });
    render(<SettingsRail />);
    expect(screen.getByText("Models")).toBeTruthy();
  });

  it("does NOT duplicate Models under You when the Organization group is visible", () => {
    mockOrg({ organizations: true, callerRole: "admin", permissions: ADMIN_PERMISSIONS });
    render(<SettingsRail />);
    // Exactly one "Models" — the Organization group's.
    expect(screen.getAllByText("Models")).toHaveLength(1);
  });

  it("shows no Models item before the org query resolves (no flash)", () => {
    mockOrg(undefined, true);
    render(<SettingsRail />);
    expect(screen.queryByText("Models")).toBeNull();
  });
});

describe("/settings index redirect", () => {
  it("redirects to /settings/profile", () => {
    expect(() => redirectToProfile()).toThrow();
    try {
      redirectToProfile();
    } catch (thrown) {
      expect(thrown).toEqual({ isRedirect: true, to: "/settings/profile" });
    }
  });
});

describe("OrgRouteGuard", () => {
  it("renders nothing while the org query is loading", () => {
    mockOrg(undefined, true);
    const { container } = render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("shows the gate-off empty state verbatim", () => {
    mockOrg({ organizations: false, callerRole: "admin", permissions: ADMIN_PERMISSIONS });
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByText("Organizations aren't enabled")).toBeTruthy();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("shows the no-permissions empty state verbatim when the gate is on but the caller has no org permissions", () => {
    mockOrg({ organizations: true, callerRole: "member", permissions: [] });
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(
      screen.getByText("Organization settings are managed by your org admins"),
    ).toBeTruthy();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("renders children when the gate is on and the caller holds any org permission", () => {
    mockOrg({ organizations: true, callerRole: "operator", permissions: OPERATOR_PERMISSIONS });
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByTestId("org-content")).toBeTruthy();
  });
});

describe("OrgPermissionGuard", () => {
  it("renders nothing while the org query is loading", () => {
    mockOrg(undefined, true);
    const { container } = render(
      <OrgPermissionGuard permission="org:manage">
        <div data-testid="org-content" />
      </OrgPermissionGuard>,
    );
    expect(container.textContent).toBe("");
  });

  it("shows the gate-off empty state verbatim", () => {
    mockOrg({ organizations: false, callerRole: "admin", permissions: ADMIN_PERMISSIONS });
    render(
      <OrgPermissionGuard permission="org:manage">
        <div data-testid="org-content" />
      </OrgPermissionGuard>,
    );
    expect(screen.getByText("Organizations aren't enabled")).toBeTruthy();
  });

  it("blocks an operator (no org:manage) from General, showing the standard empty state", () => {
    mockOrg({ organizations: true, callerRole: "operator", permissions: OPERATOR_PERMISSIONS });
    render(
      <OrgPermissionGuard permission="org:manage">
        <div data-testid="org-content" />
      </OrgPermissionGuard>,
    );
    expect(
      screen.getByText("Organization settings are managed by your org admins"),
    ).toBeTruthy();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("admits the operator to a providers:manage-gated page", () => {
    mockOrg({ organizations: true, callerRole: "operator", permissions: OPERATOR_PERMISSIONS });
    render(
      <OrgPermissionGuard permission="providers:manage">
        <div data-testid="org-content" />
      </OrgPermissionGuard>,
    );
    expect(screen.getByTestId("org-content")).toBeTruthy();
  });

  it("admits the admin to every permission-gated page", () => {
    mockOrg({ organizations: true, callerRole: "admin", permissions: ADMIN_PERMISSIONS });
    render(
      <OrgPermissionGuard permission="members:manage">
        <div data-testid="org-content" />
      </OrgPermissionGuard>,
    );
    expect(screen.getByTestId("org-content")).toBeTruthy();
  });
});
