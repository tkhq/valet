/**
 * Appearance theme (Settings page): persistence + `data-theme` attribute
 * logic, injectable storage/root so this runs without jsdom (see the
 * "no @vitest-environment jsdom pragma needed" note in theme.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { applyStoredTheme, readStoredTheme, setTheme, themeAttributeValue } from "./theme";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
    }),
  };
}

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    setAttribute: vi.fn((name: string, value: string) => {
      attrs.set(name, value);
    }),
    removeAttribute: vi.fn((name: string) => {
      attrs.delete(name);
    }),
    attrs,
  };
}

describe("readStoredTheme", () => {
  it("defaults to system when unset", () => {
    expect(readStoredTheme(fakeStorage())).toBe("system");
  });

  it("returns light/dark when stored", () => {
    expect(readStoredTheme(fakeStorage({ "valet-theme": "light" }))).toBe("light");
    expect(readStoredTheme(fakeStorage({ "valet-theme": "dark" }))).toBe("dark");
  });

  it("falls back to system for garbage values", () => {
    expect(readStoredTheme(fakeStorage({ "valet-theme": "purple" }))).toBe("system");
  });
});

describe("themeAttributeValue", () => {
  it("system → null (no override)", () => {
    expect(themeAttributeValue("system")).toBeNull();
  });
  it("light/dark → themselves", () => {
    expect(themeAttributeValue("light")).toBe("light");
    expect(themeAttributeValue("dark")).toBe("dark");
  });
});

describe("setTheme", () => {
  it("persists the choice and sets data-theme for an explicit choice", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    setTheme("dark", { root, storage });
    expect(storage.setItem).toHaveBeenCalledWith("valet-theme", "dark");
    expect(root.attrs.get("data-theme")).toBe("dark");
  });

  it("removes data-theme for system", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    root.attrs.set("data-theme", "dark");
    setTheme("system", { root, storage });
    expect(storage.setItem).toHaveBeenCalledWith("valet-theme", "system");
    expect(root.removeAttribute).toHaveBeenCalledWith("data-theme");
    expect(root.attrs.has("data-theme")).toBe(false);
  });
});

describe("applyStoredTheme", () => {
  it("applies whatever is already persisted, without rewriting storage", () => {
    const storage = fakeStorage({ "valet-theme": "light" });
    const root = fakeRoot();
    applyStoredTheme({ root, storage });
    expect(root.attrs.get("data-theme")).toBe("light");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("removes any stale data-theme when stored choice is system", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    root.attrs.set("data-theme", "dark");
    applyStoredTheme({ root, storage });
    expect(root.attrs.has("data-theme")).toBe(false);
  });
});
