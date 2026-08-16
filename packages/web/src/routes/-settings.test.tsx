// @vitest-environment jsdom
/**
 * Settings shell (split-settings design, Task 5): the rail's gate-aware
 * Organization group, the `/settings` → `/settings/profile` redirect, and
 * the org-route guard's two spec-verbatim empty states. `Link`/`redirect`
 * need router context — mocked the same way `-workflows.index.test.tsx`
 * mocks `@tanstack/react-router`, since these tests only care what the
 * shell renders/requests, not that the router itself resolves it.
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

// importOriginal: see -new-session-dialog.test.tsx (packages/web root) for
// why a bare replacement here is unsafe under vitest.config.ts's isolate:false.
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => useOrgMock(),
  };
});

import { SettingsRail } from "~/components/settings/settings-rail";
import { OrgRouteGuard } from "./settings.organization";
import { redirectToProfile } from "./settings.index";

const YOU_LABELS = ["Profile", "Assistant", "Appearance", "Notifications"];
const ORG_LABELS = ["General", "Members", "Teams"];

function mockOrg(data: { organizations: boolean; callerRole: "admin" | "member" } | undefined, isLoading = false) {
  useOrgMock.mockReturnValue({
    data: data && {
      id: "org_1",
      name: "Acme",
      createdAt: 0,
      features: { organizations: data.organizations },
      callerRole: data.callerRole,
    },
    isLoading,
  });
}

describe("SettingsRail", () => {
  it("always renders the four You items", () => {
    mockOrg({ organizations: false, callerRole: "member" });
    render(<SettingsRail />);
    for (const label of YOU_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("hides the Organization group when the gate is off", () => {
    mockOrg({ organizations: false, callerRole: "admin" });
    render(<SettingsRail />);
    for (const label of ORG_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("hides the Organization group when the caller is not an admin", () => {
    mockOrg({ organizations: true, callerRole: "member" });
    render(<SettingsRail />);
    for (const label of ORG_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows the Organization group when the gate is on and the caller is admin", () => {
    mockOrg({ organizations: true, callerRole: "admin" });
    render(<SettingsRail />);
    for (const label of ORG_LABELS) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("renders nothing for the Organization group before the org query resolves", () => {
    mockOrg(undefined, true);
    render(<SettingsRail />);
    for (const label of ORG_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows a You·Models item in single-user mode (org gate off)", () => {
    mockOrg({ organizations: false, callerRole: "admin" });
    render(<SettingsRail />);
    expect(screen.getByText("Models")).toBeTruthy();
  });

  it("does NOT duplicate Models under You when the Organization group is visible", () => {
    mockOrg({ organizations: true, callerRole: "admin" });
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
    mockOrg({ organizations: false, callerRole: "admin" });
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByText("Organizations aren't enabled")).toBeTruthy();
    expect(screen.queryByTestId("org-content")).toBeNull();
  });

  it("shows the member empty state verbatim when the gate is on but the caller isn't admin", () => {
    mockOrg({ organizations: true, callerRole: "member" });
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

  it("renders children when the gate is on and the caller is admin", () => {
    mockOrg({ organizations: true, callerRole: "admin" });
    render(
      <OrgRouteGuard>
        <div data-testid="org-content" />
      </OrgRouteGuard>,
    );
    expect(screen.getByTestId("org-content")).toBeTruthy();
  });
});
