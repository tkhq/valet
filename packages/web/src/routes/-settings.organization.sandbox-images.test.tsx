// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { OrganizationSandboxSettingsPage } from "./settings.organization.sandbox-images";

const state = vi.hoisted(() => ({
  search: {} as { source?: string },
  sectionProps: vi.fn(),
  data: { allowAnonymousImageBakes: false, callerRole: "admin" },
  mutate: vi.fn(),
}));
vi.mock("~/api/settings", () => ({
  useOrg: () => ({ data: state.data }),
  usePatchOrgSettings: () => ({ mutate: state.mutate, isPending: false, error: null }),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: object) => ({ ...opts, useSearch: () => state.search }),
}));
vi.mock("~/components/settings/sources-section", () => ({
  SourcesSection: (props: object) => { state.sectionProps(props); return null; },
}));

beforeEach(() => {
  state.data = { allowAnonymousImageBakes: false, callerRole: "admin" };
  state.mutate.mockReset();
  state.sectionProps.mockReset();
  state.search = {};
});

describe("anonymous image bake setting", () => {
  it("lets an admin enable it and reflects changed settings", () => {
    const view = render(<OrganizationSandboxSettingsPage />);
    const toggle = screen.getByRole("switch", { name: "Allow anonymous image bakes" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(state.mutate).toHaveBeenCalledWith({ allowAnonymousImageBakes: true });
    state.data.allowAnonymousImageBakes = true;
    view.rerender(<OrganizationSandboxSettingsPage />);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(state.mutate).toHaveBeenLastCalledWith({ allowAnonymousImageBakes: false });
  });

  it("disables the switch for members", () => {
    state.data.callerRole = "member";
    render(<OrganizationSandboxSettingsPage />);
    expect(screen.getByRole("switch", { name: "Allow anonymous image bakes" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("source deep link", () => {
  it("passes the source search param to the sources section", () => {
    state.search = { source: "s1" };
    render(<OrganizationSandboxSettingsPage />);
    expect(state.sectionProps).toHaveBeenCalledWith({ initiallyExpandedId: "s1" });
  });
});
