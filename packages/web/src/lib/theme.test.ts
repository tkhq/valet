/**
 * Appearance (Settings page): persistence + attribute logic for both
 * choices — the light/dark polarity on `data-theme` and the palette on
 * `data-palette`. Injectable storage/root so this runs without jsdom (see
 * the "no @vitest-environment jsdom pragma needed" note in theme.ts).
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyStoredPalette,
  applyStoredTheme,
  paletteAttributeValue,
  readStoredPalette,
  readStoredTheme,
  setPalette,
  setTheme,
  themeAttributeValue,
} from "./theme";

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

describe("readStoredPalette", () => {
  it("defaults to the brand palette when unset", () => {
    expect(readStoredPalette(fakeStorage())).toBe("default");
  });

  it("returns a stored palette name", () => {
    expect(readStoredPalette(fakeStorage({ "valet-palette": "ember" }))).toBe("ember");
    expect(readStoredPalette(fakeStorage({ "valet-palette": "tide" }))).toBe("tide");
    expect(readStoredPalette(fakeStorage({ "valet-palette": "orchid" }))).toBe("orchid");
  });

  it("falls back to the default for a palette that no longer exists", () => {
    expect(readStoredPalette(fakeStorage({ "valet-palette": "sunset" }))).toBe("default");
  });
});

describe("paletteAttributeValue", () => {
  it("default → null, so an untouched install carries no attribute", () => {
    expect(paletteAttributeValue("default")).toBeNull();
  });
  it("named palettes → themselves", () => {
    expect(paletteAttributeValue("ember")).toBe("ember");
  });
});

describe("setPalette", () => {
  it("persists the palette and sets data-palette", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    setPalette("tide", { root, storage });
    expect(storage.setItem).toHaveBeenCalledWith("valet-palette", "tide");
    expect(root.attrs.get("data-palette")).toBe("tide");
  });

  it("removes data-palette for the default", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    root.attrs.set("data-palette", "orchid");
    setPalette("default", { root, storage });
    expect(storage.setItem).toHaveBeenCalledWith("valet-palette", "default");
    expect(root.attrs.has("data-palette")).toBe(false);
  });

  it("leaves the light/dark choice alone", () => {
    const storage = fakeStorage();
    const root = fakeRoot();
    root.attrs.set("data-theme", "dark");
    setPalette("ember", { root, storage });
    expect(root.attrs.get("data-theme")).toBe("dark");
    expect(storage.setItem).not.toHaveBeenCalledWith("valet-theme", expect.anything());
  });
});

describe("applyStoredPalette", () => {
  it("applies the persisted palette at boot, without rewriting storage", () => {
    const storage = fakeStorage({ "valet-palette": "orchid" });
    const root = fakeRoot();
    applyStoredPalette({ root, storage });
    expect(root.attrs.get("data-palette")).toBe("orchid");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("clears an attribute the index.html fast path stamped from a stale value", () => {
    // The inline boot script matches the palette name by shape, so it can
    // stamp a name this build no longer has. Boot is where that is undone.
    const storage = fakeStorage({ "valet-palette": "sunset" });
    const root = fakeRoot();
    root.attrs.set("data-palette", "sunset");
    applyStoredPalette({ root, storage });
    expect(root.attrs.has("data-palette")).toBe(false);
  });

  it("leaves the root untouched when nothing was ever chosen", () => {
    const root = fakeRoot();
    applyStoredPalette({ root, storage: fakeStorage() });
    expect(root.attrs.has("data-palette")).toBe(false);
    expect(root.setAttribute).not.toHaveBeenCalled();
  });
});
