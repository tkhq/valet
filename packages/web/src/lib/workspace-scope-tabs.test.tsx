// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkspaceScopeProvider, useWorkspaceScope } from "./workspace-scope";

let workspace: string | undefined;
vi.mock("@tanstack/react-router", () => ({ useSearch: () => ({ workspace }) }));
vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: { teams: [{ id: "a", name: "Platform" }, { id: "b", name: "Design" }] } }),
  useOrg: () => ({ data: { features: { organizations: true } } }),
}));
vi.mock("~/components/session/assistant-rail", () => ({ eligibleTeams: (teams: unknown) => teams }));

function tabStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

beforeEach(() => { workspace = undefined; localStorage.clear(); });

it("keeps two tabs' choices independent when either tab reloads", () => {
  const first = tabStorage();
  const second = tabStorage();
  const storage = vi.spyOn(window, "sessionStorage", "get").mockReturnValue(first);
  let tab = renderHook(useWorkspaceScope, { wrapper: WorkspaceScopeProvider });
  act(() => tab.result.current.setKey("a"));
  tab.unmount();

  storage.mockReturnValue(second);
  tab = renderHook(useWorkspaceScope, { wrapper: WorkspaceScopeProvider });
  expect(tab.result.current.key).toBe("user");
  act(() => tab.result.current.setKey("b"));
  tab.unmount();

  storage.mockReturnValue(first);
  tab = renderHook(useWorkspaceScope, { wrapper: WorkspaceScopeProvider });
  expect(tab.result.current.key).toBe("a");
  expect(document.title).toBe("Platform · Valet");
  tab.unmount();

  storage.mockReturnValue(second);
  tab = renderHook(useWorkspaceScope, { wrapper: WorkspaceScopeProvider });
  expect(tab.result.current.key).toBe("b");
  expect(document.title).toBe("Design · Valet");
  tab.unmount();
  storage.mockRestore();
});

it("lets explicit workspace links update only the current tab's stored scope", () => {
  const storage = tabStorage();
  storage.setItem("valet:workspace", "a");
  const getter = vi.spyOn(window, "sessionStorage", "get").mockReturnValue(storage);
  workspace = "b";
  const tab = renderHook(useWorkspaceScope, { wrapper: WorkspaceScopeProvider });
  expect(tab.result.current.key).toBe("b");
  workspace = undefined;
  tab.rerender();
  expect(tab.result.current.key).toBe("b");
  expect(storage.getItem("valet:workspace")).toBe("b");
  tab.unmount();
  getter.mockRestore();
});
