// @vitest-environment jsdom
/** Home is the conversation on every screen. A phone switches between Chat,
 * Tasks, and Make; a wider screen keeps the conversation in view. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const search = vi.fn((): { view?: string } => ({}));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  // `options` mirrors the real route, so a test reads `validateSearch` the same way.
  createFileRoute: () => (config: object) => ({ ...config, options: config, useSearch: () => search(), fullPath: "/" }),
  useNavigate: () => navigate,
}));
const mobile = vi.fn(() => false);
vi.mock("~/hooks/use-mobile-layout", () => ({ useMobileLayout: () => mobile() }));
vi.mock("~/components/home/home-screen", () => ({
  HomeScreen: ({ view, wide, onViewChange }: { view: string; wide: boolean; onViewChange: (view: string) => void }) => (
    <button type="button" data-testid="home-screen" data-view={view} data-wide={String(wide)} onClick={() => onViewChange("make")} />
  ),
}));
vi.mock("~/lib/page-title", () => ({ usePageTitle: () => undefined }));

import { Home, Route } from "./index";

describe("Home", () => {
  it("shows the conversation on a wider screen instead of a dashboard", () => {
    mobile.mockReturnValue(false);
    render(<Home />);
    const home = screen.getByTestId("home-screen");
    expect(home.dataset.wide).toBe("true");
    expect(home.dataset.view).toBe("chat");
  });

  it("keeps the same conversation when the viewport changes", () => {
    mobile.mockReturnValue(true);
    const { rerender } = render(<Home />);
    expect(screen.getByTestId("home-screen").dataset.wide).toBe("false");
    mobile.mockReturnValue(false);
    rerender(<Home />);
    expect(screen.getByTestId("home-screen").dataset.wide).toBe("true");
  });

  it("opens the tab the URL names and writes the chosen tab back", () => {
    mobile.mockReturnValue(false);
    search.mockReturnValueOnce({ view: "tasks" });
    render(<Home />);
    const home = screen.getByTestId("home-screen");
    expect(home.dataset.view).toBe("tasks");
    home.click();
    const options = navigate.mock.lastCall?.[0] as { search: (prev: Record<string, unknown>) => Record<string, unknown>; replace: boolean };
    expect(options.replace).toBe(true);
    // The space in the URL survives a tab change.
    expect(options.search({ workspace: "t1" })).toEqual({ workspace: "t1", view: "make" });
  });

  it("reads only view=tasks and view=make from the URL", () => {
    const validate = (Route.options as { validateSearch: (raw: Record<string, unknown>) => unknown }).validateSearch;
    expect(validate({ view: "tasks" })).toEqual({ view: "tasks" });
    expect(validate({ view: "make" })).toEqual({ view: "make" });
    expect(validate({ view: "chat" })).toEqual({});
    expect(validate({})).toEqual({});
  });
});
