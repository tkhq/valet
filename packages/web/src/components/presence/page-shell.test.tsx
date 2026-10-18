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
  Link: ({ to, params, search, hash, children, className }: {
    to: string; params?: Record<string, string>; search?: Record<string, string>; hash?: string; children: ReactNode; className?: string;
  }) => {
    const path = Object.entries(params ?? {}).reduce((p, [key, value]) => p.replace(`$${key}`, value), to);
    const query = new URLSearchParams(search ?? {}).toString();
    return <a href={`${query ? `${path}?${query}` : path}${hash ? `#${hash}` : ""}`} className={className}>{children}</a>;
  },
}));

import { PRESENCE_CRUMB, PresenceDetailPage } from "./page-shell";

describe("PresenceDetailPage", () => {
  it("renders the breadcrumb, the title, the subtitle, and the body", () => {
    render(
      <PresenceDetailPage
        crumbs={[{ label: "Presence", to: "/presence", search: { workspace: "t1" } }, { label: "Morning summary" }]}
        title="Morning summary"
        subtitle="Every day at 9:00"
      >
        <p>body</p>
      </PresenceDetailPage>,
    );
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("Presence›Morning summary");
    expect(within(crumbs).getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence?workspace=t1");
    expect(within(crumbs).getByText("Morning summary").getAttribute("aria-current")).toBe("page");
    expect(within(crumbs).getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Morning summary" })).toBeTruthy();
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

  it("lands a crumb's link on its hash", () => {
    render(
      <PresenceDetailPage crumbs={[PRESENCE_CRUMB, { label: "On a schedule", to: "/presence", hash: "schedule" }, { label: "M" }]} title="M">
        <p />
      </PresenceDetailPage>,
    );
    expect(screen.getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
    expect(screen.getByRole("link", { name: "On a schedule" }).getAttribute("href")).toBe("/presence#schedule");
  });
});
