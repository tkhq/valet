// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { BackLink, PageHeader } from "./page";

describe("PageHeader", () => {
  it("renders the title as the page heading, with its clause, actions, and description", () => {
    render(
      <PageHeader
        title="Skills"
        clause={<span>Team A</span>}
        actions={<button type="button">New skill</button>}
        description="Instructions for a task."
      />,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Skills" });
    expect(heading.className).toContain("font-display");
    expect(heading.className).toContain("text-2xl");
    expect(screen.getByText("Team A")).toBeTruthy();
    expect(screen.getByRole("button", { name: "New skill" })).toBeTruthy();
    expect(screen.getByText("Instructions for a task.").className).toContain("text-muted");
  });

  it("renders the back link above the title", () => {
    render(<PageHeader title="Run" back={<a href="/workflows">← Workflows</a>} />);
    const back = screen.getByRole("link", { name: "← Workflows" });
    const heading = screen.getByRole("heading", { name: "Run" });
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("BackLink", () => {
  it("links to the route with its params and prefixes the label with an arrow", () => {
    const rootRoute = createRootRoute();
    const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/workflows/runs/$runId" });
    const router = createRouter({
      routeTree: rootRoute.addChildren([runRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <RouterContextProvider router={router}>
        <BackLink to="/workflows/runs/$runId" params={{ runId: "run_1" }}>Workflow run</BackLink>
      </RouterContextProvider>,
    );
    const link = screen.getByRole("link", { name: "← Workflow run" });
    expect(link.getAttribute("href")).toBe("/workflows/runs/run_1");
    expect(link.className).toContain("text-muted");
  });
});
