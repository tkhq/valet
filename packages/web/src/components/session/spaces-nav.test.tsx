// @vitest-environment jsdom
/** The app-wide sidebar lists Spaces, Linear style: each space opens to its
 * pages, and every page row names its space in the URL. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter, useBlocker } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamSummary } from "@valet/api/wire";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";
import { SpacesNav, spaceInitial, spacePageFor, spaceTint } from "./spaces-nav";

let teams: TeamSummary[] = [];
let plugins: Array<{ name: string; enabledForCaller: boolean }> = [];
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useOrg: () => ({ data: { features: { organizations: true }, plugins }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams }, isLoading: false, error: null }),
}));

const team = (id: string, name: string): TeamSummary =>
  ({ id, name, orgId: "org", createdAt: 1, memberCount: 2, callerRole: "member", origin: "local", externalId: null, defaultModel: null });

function mount(path: string) {
  const root = createRootRoute({ component: () => <WorkspaceScopeProvider><SpacesNav /><Outlet /></WorkspaceScopeProvider> });
  const routes = ["/", "/chat", "/workflows", "/presence", "/artifacts", "/overview", "/memory", "/skills", "/integrations", "/usage", "/security"].map(p => createRoute({ getParentRoute: () => root, path: p, component: () => null }));
  // An editor with unsaved edits that refuses to be left.
  const editor = createRoute({ getParentRoute: () => root, path: "/workflows/$id", component: function Editor() { useBlocker({ shouldBlockFn: () => true }); return null; } });
  const router = createRouter({ routeTree: root.addChildren([...routes, editor]), history: createMemoryHistory({ initialEntries: [path] }) });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("SpacesNav", () => {
  beforeEach(() => {
    teams = [];
    plugins = [];
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("lists a solo caller's Personal space with its pages", async () => {
    mount("/workflows");
    const pages = await screen.findByRole("list", { name: "Personal pages" });
    expect(within(pages).getAllByRole("link").map((link) => link.textContent)).toEqual(["Threads", "Workflows", "Presence", "Artifacts"]);
    expect(within(pages).getByRole("link", { name: "Workflows" }).getAttribute("aria-current")).toBe("page");
  });

  it("opens the active space and closes the others", async () => {
    teams = [team("t1", "Platform"), team("t2", "People")];
    mount("/presence?workspace=t1");
    const pages = await screen.findByRole("list", { name: "Platform pages" });
    expect(within(pages).getByRole("link", { name: "Presence" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("list", { name: "Personal pages" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show People pages" })).toBeTruthy();
  });

  it("opens another space's page in one click once expanded, naming the space in the URL", async () => {
    teams = [team("t1", "Platform")];
    const router = mount("/workflows");
    await userEvent.click(await screen.findByRole("button", { name: "Show Platform pages" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Workflows" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "t1" }));
    expect(router.state.location.pathname).toBe("/workflows");
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("t1");
  });

  it("opens a space and its Threads from the space name on Home, and remembers it open", async () => {
    teams = [team("t1", "Platform")];
    const router = mount("/");
    await userEvent.click(await screen.findByRole("link", { name: "Platform" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    expect(router.state.location.search).toEqual({ workspace: "t1" });
    expect(await screen.findByRole("list", { name: "Platform pages" })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("valet:spaces-expanded") ?? "{}")).toEqual({ t1: true });
  });

  it("keeps a space closed after the person collapses it", async () => {
    teams = [team("t1", "Platform")];
    mount("/chat");
    await userEvent.click(await screen.findByRole("button", { name: "Collapse Personal" }));
    expect(screen.queryByRole("list", { name: "Personal pages" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("valet:spaces-expanded") ?? "{}")).toEqual({ user: false });
  });

  it("leaves the space unchanged when unsaved edits block leaving", async () => {
    teams = [team("t1", "Platform")];
    window.sessionStorage.setItem("valet:workspace", "t1");
    const router = mount("/workflows/wf-1");
    await userEvent.click(await screen.findByRole("button", { name: "Show Personal pages" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Workflows" }));
    expect(router.state.location.pathname).toBe("/workflows/wf-1");
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("t1");
    expect(screen.getByRole("list", { name: "Platform pages" })).toBeTruthy();
  });

  it("draws no divider of its own, so the sidebar's only divider is its top row's", async () => {
    teams = [team("t1", "Platform")];
    mount("/chat");
    const spaces = await screen.findByRole("region", { name: "Spaces" });
    for (const node of [spaces, ...spaces.querySelectorAll("*")]) expect(node.className.toString()).not.toMatch(/\bborder-(t|b)\b/);
  });

  it("fills the open page's row, but leaves Threads to the open thread", async () => {
    mount("/workflows");
    const pages = await screen.findByRole("list", { name: "Personal pages" });
    const fill = (name: string) => within(pages).getByRole("link", { name }).className.split(/\s+/);
    expect(fill("Workflows")).toContain("bg-ink-wash-strong");
    expect(fill("Threads")).not.toContain("bg-ink-wash-strong");
    // No saturated block anywhere in the Spaces list.
    const spaces = screen.getByRole("region", { name: "Spaces" });
    for (const node of [spaces, ...spaces.querySelectorAll("*")]) expect(node.className.toString()).not.toMatch(/moss/);
  });

  it("names Threads as the current page without a fill while a thread is open", async () => {
    mount("/chat");
    const threads = within(await screen.findByRole("list", { name: "Personal pages" })).getByRole("link", { name: "Threads" });
    expect(threads.getAttribute("aria-current")).toBe("page");
    expect(threads.className.split(/\s+/)).not.toContain("bg-ink-wash-strong");
  });

  it("marks each team with its initial and keeps the person icon for Personal", async () => {
    teams = [team("t1", "Acme Platform"), team("t2", "Acme Design")];
    mount("/chat");
    const marks = (await screen.findAllByRole("link", { name: /Acme/ })).map((link) => link.querySelector("[data-space-mark]")?.textContent);
    expect(marks).toEqual(["P", "D"]);
    expect(screen.getByRole("link", { name: "Personal" }).querySelector("[data-space-mark]")).toBeNull();
  });

  it("shows a space's chevron on hover or focus only, where the screen can hover", async () => {
    teams = [team("t1", "Platform")];
    mount("/chat");
    for (const name of ["Collapse Personal", "Show Platform pages"]) {
      const classes = (await screen.findByRole("button", { name })).className.split(/\s+/);
      expect(classes).toContain("[@media(hover:hover)]:opacity-0");
      expect(classes).toContain("group-hover:opacity-100");
      expect(classes).toContain("group-focus-within:opacity-100");
    }
  });

  it("picks a team initial past a shared first word", () => {
    expect(spaceInitial("Platform", ["Platform"])).toBe("P");
    expect(spaceInitial("Acme Eng Team", ["Acme Eng Team", "Acme Sales Team", "Acme Ops"])).toBe("E");
    expect(spaceInitial("Acme Ops", ["Acme Eng Team", "Acme Sales Team", "Acme Ops"])).toBe("O");
    // A name that is only the shared word keeps it.
    expect(spaceInitial("Acme", ["Acme", "Acme Design"])).toBe("A");
    expect(spaceInitial("  ", ["  "])).toBe("?");
    expect(spaceTint("t1")).toBe(spaceTint("t1"));
  });

  it("keeps the page when switching space from a space page", async () => {
    teams = [team("t1", "Engineering"), team("t2", "Sales")];
    const router = mount("/integrations?workspace=t1");
    await userEvent.click(await screen.findByRole("link", { name: "Sales" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "t2" }));
    expect(router.state.location.pathname).toBe("/integrations");
    expect(window.sessionStorage.getItem("valet:workspace")).toBe("t2");
  });

  it("opens the list page of the same kind from a detail page", async () => {
    teams = [team("t1", "Engineering"), team("t2", "Sales")];
    const router = mount("/workflows/wf-1?workspace=t1");
    expect((await screen.findByRole("link", { name: "Sales" })).getAttribute("href")).toBe("/workflows?workspace=t2");
    expect(router.state.location.pathname).toBe("/workflows/wf-1");
  });

  it("opens Threads when switching space from a thread", async () => {
    teams = [team("t1", "Engineering"), team("t2", "Sales")];
    const router = mount("/chat?workspace=t1");
    await userEvent.click(await screen.findByRole("link", { name: "Sales" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ workspace: "t2" }));
    expect(router.state.location.pathname).toBe("/chat");
  });

  it("keeps a space's other pages behind its More row, closed until opened, and remembers it", async () => {
    mount("/chat");
    await screen.findByRole("list", { name: "Personal pages" });
    expect(screen.queryByRole("list", { name: "More Personal pages" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show more Personal pages" }));
    const more = screen.getByRole("list", { name: "More Personal pages" });
    expect(within(more).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Overview", "/overview?workspace=user"], ["Memory", "/memory?workspace=user"], ["Skills", "/skills?workspace=user"],
      ["Integrations", "/integrations?workspace=user"], ["Usage", "/usage?workspace=user"],
    ]);
    expect(JSON.parse(window.localStorage.getItem("valet:spaces-more-expanded") ?? "{}")).toEqual({ user: true });
  });

  it("opens More and selects the row on one of its pages", async () => {
    teams = [team("t1", "Platform")];
    mount("/memory?workspace=t1");
    const more = await screen.findByRole("list", { name: "More Platform pages" });
    const memory = within(more).getByRole("link", { name: "Memory" });
    expect(memory.getAttribute("aria-current")).toBe("page");
    expect(memory.className.split(/\s+/)).toContain("bg-ink-wash-strong");
    expect(screen.getByRole("button", { name: "Hide more Platform pages" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("lists Security under More only with the plugin", async () => {
    plugins = [{ name: "security", enabledForCaller: true }];
    mount("/security");
    const more = await screen.findByRole("list", { name: "More Personal pages" });
    expect(within(more).getByRole("link", { name: "Security" }).getAttribute("aria-current")).toBe("page");
  });

  it("lists every page in a closed space's menu", async () => {
    teams = [team("t1", "Platform")];
    mount("/chat");
    await userEvent.click(await screen.findByRole("button", { name: "Show Platform pages" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    expect(items).toEqual(["Threads", "Workflows", "Presence", "Artifacts", "Overview", "Memory", "Skills", "Integrations", "Usage"]);
  });

  it("maps paths to the space page they belong to", () => {
    expect(spacePageFor("/")).toBe("/chat");
    expect(spacePageFor("/chat")).toBe("/chat");
    expect(spacePageFor("/workflows/runs/r1")).toBe("/workflows");
    expect(spacePageFor("/presence/activity")).toBe("/presence");
    expect(spacePageFor("/artifacts")).toBe("/artifacts");
    expect(spacePageFor("/memory/graph")).toBe("/memory");
    expect(spacePageFor("/integrations")).toBe("/integrations");
    expect(spacePageFor("/changelog")).toBeUndefined();
    expect(spacePageFor("/settings/model-comparison")).toBeUndefined();
  });
});
