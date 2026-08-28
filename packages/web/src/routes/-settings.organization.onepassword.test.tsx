// @vitest-environment jsdom
/**
 * Old Organization · 1Password URL now redirects to `/integrations`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  Navigate: ({ to }: { to: string }) => <div>redirect:{to}</div>,
}));

import { OrganizationOnePasswordRedirect } from "./settings.organization.onepassword";

describe("OrganizationOnePasswordRedirect", () => {
  it("sends the old org settings URL to /integrations", () => {
    render(<OrganizationOnePasswordRedirect />);
    expect(screen.getByText("redirect:/integrations")).toBeTruthy();
  });
});
