// @vitest-environment jsdom
/**
 * Notification settings: the Platform row is for org admins only.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let callerRole: "admin" | "member" = "admin";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: object) => ({ ...config }),
}));

vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return {
    ...actual,
    useOrg: () => ({ data: { id: "org_1", name: "Acme", createdAt: 0, callerRole, features: { organizations: true } }, isLoading: false, error: null }),
  };
});

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useNotificationPreferences: () => ({ data: { preferences: [] }, isLoading: false, error: null }),
    useSetNotificationPreference: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

import { NotificationsPage } from "./settings.notifications";

describe("NotificationsPage platform row", () => {
  it("shows the Platform row to org admins", () => {
    callerRole = "admin";
    render(<NotificationsPage />);
    expect(screen.getByLabelText("Platform web notifications")).toBeTruthy();
    expect(screen.getByLabelText("Notifications web notifications")).toBeTruthy();
  });

  it("hides the Platform row from non-admins", () => {
    callerRole = "member";
    render(<NotificationsPage />);
    expect(screen.queryByLabelText("Platform web notifications")).toBeNull();
    expect(screen.getByLabelText("Notifications web notifications")).toBeTruthy();
  });
});
