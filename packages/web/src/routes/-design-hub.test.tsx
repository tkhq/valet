// @vitest-environment jsdom
/**
 * Design hub creation flow (Valet Design spec §Web Surfaces): a template
 * card click only SELECTS — Create is the single creation path and it
 * requires a prompt. Card-click-creates shipped once and minted briefless
 * sessions before the user finished typing the prompt.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    // The runtime shape only needs `.options` — the test reads the route's
    // component through the real Route type's `options` field.
    createFileRoute: () => (options: unknown) => ({ options }),
    useNavigate: () => navigate,
    Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  };
});

const mutateAsync = vi.fn().mockResolvedValue({ id: "sess-design" });
vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useCreateSession: () => ({ mutateAsync, isPending: false, error: null }),
  };
});

vi.mock("~/api/design", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/design")>();
  return {
    ...actual,
    useDesignSessions: () => ({ data: { sessions: [] }, isLoading: false, error: null }),
  };
});

vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => undefined }));
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return {
    ...actual,
    useWorkspaceScope: () => ({ teamId: undefined }),
  };
});
vi.mock("~/components/workspace-clause", () => ({ WorkspaceClause: () => null }));

import { Route } from "./design.index";

function Page() {
  const Component = Route.options.component;
  if (!Component) throw new Error("design.index route has no component");
  return <Component />;
}

afterEach(() => {
  mutateAsync.mockClear();
  navigate.mockClear();
});

describe("design hub creation flow", () => {
  it("a template card click selects the template and does NOT create", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const slides = screen.getByRole("radio", { name: /Slides/ });
    await user.click(slides);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(slides.getAttribute("aria-checked")).toBe("true");
  });

  it("Create is disabled until a prompt is typed", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Create" });
    expect(button.disabled).toBe(true);
    await user.type(screen.getByLabelText("What should we create?"), "A launch deck");
    expect(button.disabled).toBe(false);
  });

  it("Create submits the selected template with the prompt", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("radio", { name: /Slides/ }));
    await user.type(screen.getByLabelText("What should we create?"), "A launch deck");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      kind: "design",
      template: "slides",
      initialPrompt: "A launch deck",
    });
  });
});
