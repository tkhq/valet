// @vitest-environment jsdom
/**
 * A Presence detail page in the pane (spec Part A step 6): a breadcrumb
 * with ` › ` separators, the title, an optional subtitle, and the body.
 */
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { PRESENCE_CRUMB, PresenceDetailPage } from "./page-shell";

/**
 * Renders the page under a real memory router, so each crumb's href is the
 * one the router builds, with its params encoded, not a mock's string.
 */
async function renderInRouter(ui: ReactNode) {
  const root = createRootRoute({ component: () => ui });
  const routes = ["/presence", "/presence/places/$subject"].map((path) => createRoute({ getParentRoute: () => root, path }));
  const router = createRouter({ routeTree: root.addChildren(routes), history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(<RouterProvider router={router} />);
  await screen.findByRole("navigation", { name: "Breadcrumb" });
}

describe("PresenceDetailPage", () => {
  it("renders the breadcrumb, the title, the subtitle, and the body", async () => {
    await renderInRouter(
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

  it("fills a crumb's params into its link, encoded", async () => {
    await renderInRouter(
      <PresenceDetailPage crumbs={[{ label: "#incidents", to: "/presence/places/$subject", params: { subject: "slack:T1/C900" } }, { label: "M" }]} title="M">
        <p />
      </PresenceDetailPage>,
    );
    expect(screen.getByRole("link", { name: "#incidents" }).getAttribute("href")).toBe("/presence/places/slack%3AT1%2FC900");
  });

  it("lands a crumb's link on its hash", async () => {
    await renderInRouter(
      <PresenceDetailPage crumbs={[PRESENCE_CRUMB, { label: "On a schedule", to: "/presence", hash: "schedule" }, { label: "M" }]} title="M">
        <p />
      </PresenceDetailPage>,
    );
    expect(screen.getByRole("link", { name: "Presence" }).getAttribute("href")).toBe("/presence");
    expect(screen.getByRole("link", { name: "On a schedule" }).getAttribute("href")).toBe("/presence#schedule");
  });
});
