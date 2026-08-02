/**
 * Appearance theme (Settings page, Appearance section). Three choices:
 * `system` (follow the OS `prefers-color-scheme`, decision — no explicit
 * override), `light`, `dark`. Persisted to `localStorage["valet-theme"]`
 * and applied by setting/removing `data-theme` on `<html>` — the CSS side
 * of this contract already exists in `src/theme.css` (`:root[data-theme=…]`
 * overrides win over the OS media query in both directions).
 *
 * Functions here take injectable `storage`/`root` so the persistence +
 * attribute logic is unit-testable without a real DOM/localStorage (jsdom
 * is available in tests, but keeping this pure means no `@vitest-environment
 * jsdom` pragma is needed for the theme-setter tests).
 *
 * `applyStoredTheme()` is called once at app boot, before first paint if
 * possible (see `main.tsx`), so a returning user with `dark` stored doesn't
 * flash light before React mounts.
 */

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "valet-theme";

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Reads the stored choice, defaulting to `"system"` for anything unset or invalid. */
export function readStoredTheme(storage: StorageReader = safeLocalStorage()): ThemeChoice {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** Pure: the `data-theme` attribute value for a choice, or `null` to remove it (system). */
export function themeAttributeValue(choice: ThemeChoice): "light" | "dark" | null {
  return choice === "system" ? null : choice;
}

function applyAttribute(root: ThemeRoot, choice: ThemeChoice): void {
  const attr = themeAttributeValue(choice);
  if (attr) root.setAttribute("data-theme", attr);
  else root.removeAttribute("data-theme");
}

/** Persists `choice` and applies it to `root` (defaults: localStorage + `<html>`). */
export function setTheme(
  choice: ThemeChoice,
  opts: { root?: ThemeRoot; storage?: StorageWriter } = {},
): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  storage.setItem(THEME_STORAGE_KEY, choice);
  applyAttribute(root, choice);
}

/** Reads whatever is already stored and applies it — the app-boot entry point. */
export function applyStoredTheme(opts: { root?: ThemeRoot; storage?: StorageReader } = {}): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  applyAttribute(root, readStoredTheme(storage));
}

function documentRoot(): ThemeRoot {
  return document.documentElement;
}

/** In-memory fallback when real storage is absent or non-functional —
 * Node ≥22 ships a stub `localStorage` global whose methods are undefined
 * without --localstorage-file, and it can shadow jsdom's in tests. */
const memoryStorage = new Map<string, string>();

function safeLocalStorage(): StorageReader & StorageWriter {
  const candidate: unknown = typeof window !== "undefined" ? window.localStorage : undefined;
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as Partial<Storage>).getItem === "function" &&
    typeof (candidate as Partial<Storage>).setItem === "function"
  ) {
    return candidate as StorageReader & StorageWriter;
  }
  return {
    getItem: (key) => memoryStorage.get(key) ?? null,
    setItem: (key, value) => {
      memoryStorage.set(key, value);
    },
  };
}
