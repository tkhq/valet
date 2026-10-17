// @vitest-environment jsdom
/**
 * A Presence detail page in the pane (spec Part A step 6): a breadcrumb
 * with ` › ` separators, the title, an optional subtitle, and the body.
 */
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, params, search, children, className }: {
    to: string; params?: Record<string, string>; search?: Record<string, string>; children: ReactNode; className?: string;
  }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    const query = new URLSearchParams(search ?? {}).toString();
    return <a href={query ? `${path}?${query}` : path} className={className}>{children}</a>;
  },
}));

import { PresenceDetailPage } from "./page-shell";

describe("PresenceDetailPage", () => {
  it("renders the breadcrumb, the title, the subtitle, and the body", () => {
    render(
      <PresenceDetailPage
        crumbs={[{ label: "Routines", to: "/presence/routines", search: { workspace: "t1" } }, { label: "Morning summary" }]}
        title="Morning summary"
        subtitle="Every day at 9:00"
      >
        <p>body</p>
      </PresenceDetailPage>,
    );
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Routines›Morning summary");
    expect(within(crumbs).getByRole("link", { name: "Routines" }).getAttribute("href")).toBe("/presence/routines?workspace=t1");
    expect(within(crumbs).getByText("Morning summary").getAttribute("aria-current")).toBe("page");
    expect(within(crumbs).getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Morning summary" })).toBeTruthy();
    expect(screen.getByText("Every day at 9:00")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("fills a crumb's params into its link", () => {
    render(
      <PresenceDetailPage crumbs={[{ label: "#incidents", to: "/presence/places/$subject", params: { subject: "slack:T1/C900" } }, { label: "M" }]} title="M">
        <p />
      </PresenceDetailPage>,
    );
    expect(screen.getByRole("link", { name: "#incidents" }).getAttribute("href")).toBe("/presence/places/slack:T1/C900");
  });
});
