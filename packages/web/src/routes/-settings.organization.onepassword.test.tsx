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

  // The panel's own non-admin branch renders the member's personal token
  // row, and `GET /api/onepassword/settings` answers any member. With the
  // page behind the admin guard that branch was unreachable, so a member
  // could neither connect nor revoke their own token.
  it("is reachable by a plain member", () => {
    expect(isMemberVisiblePath("/settings/organization/onepassword")).toBe(true);
    expect(isMemberVisiblePath("/settings/organization/onepassword/")).toBe(true);
    expect(isMemberVisiblePath("/settings/organization/members")).toBe(false);
  });
});
