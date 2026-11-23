// @vitest-environment jsdom
/**
 * Organization · 1Password renders the panel itself. The page used to
 * redirect to `/integrations`; the panel moved back onto the settings rail,
 * beside GitHub and Slack, so the URL serves content again.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/components/integrations/onepassword-panel", () => ({
  OnePasswordPanel: () => <div>onepassword-panel</div>,
}));

import { OrganizationOnePasswordPage } from "./settings.organization.onepassword";
import { isMemberVisiblePath } from "./settings.organization";

describe("OrganizationOnePasswordPage", () => {
  it("renders the 1Password panel rather than redirecting away", () => {
    render(<OrganizationOnePasswordPage />);
    expect(screen.getByText("onepassword-panel")).toBeTruthy();
  });

  // A member's own token is on Integrations, and the org token is an
  // admin's to set, so the page holds nothing a member can act on.
  it("is for org admins only", () => {
    expect(isMemberVisiblePath("/settings/organization/onepassword")).toBe(false);
    expect(isMemberVisiblePath("/settings/organization/onepassword/")).toBe(false);
    expect(isMemberVisiblePath("/settings/organization/teams")).toBe(true);
  });
});
