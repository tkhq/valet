/**
 * Appearance (Settings page, Appearance section). Two independent choices,
 * each persisted to `localStorage` and applied as an attribute on `<html>`:
 *
 * - Polarity — `system` (follow the OS `prefers-color-scheme`, no explicit
 *   override), `light`, `dark`. Key `valet-theme`, attribute `data-theme`.
 * - Palette — `default` plus the named color sets. Key `valet-palette`,
 *   attribute `data-palette`.
 *
 * The CSS side of both contracts lives in `src/theme.css`, which explains
 * why they are two attributes rather than one: `data-theme` also drives
 * Tailwind's `dark:` variant, so a palette name cannot share it.
 *
 * "Nothing chosen" is an ABSENT attribute in both cases, not a written-out
 * value. `system` and `default` remove theirs, which is what keeps an
 * untouched install on the OS-driven default palette.
 *
 * Functions here take injectable `storage`/`root` so the persistence +
 * attribute logic is unit-testable without a real DOM/localStorage (jsdom
 * is available in tests, but keeping this pure means no `@vitest-environment
 * jsdom` pragma is needed for the theme-setter tests).
 *
 * `applyStoredTheme()` and `applyStoredPalette()` run once at app boot (see
 * `main.tsx`). An inline script in `index.html` runs the same two steps
 * earlier still, because the module bundle only executes after it has
 * downloaded — long enough to paint one frame of the wrong appearance.
 */

export type ThemeChoice = "system" | "light" | "dark";

/** Named color sets from `theme.css`. `default` is the brand palette. */
export type PaletteChoice = "default" | "ember" | "tide" | "orchid";

export const THEME_STORAGE_KEY = "valet-theme";

export const PALETTE_STORAGE_KEY = "valet-palette";

/** Every palette, in picker order. `theme.tokens.test.ts` reads this list
 * and fails if `theme.css` is missing a block for any entry. */
export const PALETTE_CHOICES: readonly PaletteChoice[] = ["default", "ember", "tide", "orchid"];

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

/** Reads the stored palette, defaulting to `"default"` for anything unset or invalid. */
export function readStoredPalette(storage: StorageReader = safeLocalStorage()): PaletteChoice {
  const raw = storage.getItem(PALETTE_STORAGE_KEY);
  return raw !== null && isPaletteChoice(raw) ? raw : "default";
}

function isPaletteChoice(raw: string): raw is PaletteChoice {
  return PALETTE_CHOICES.some((choice) => choice === raw);
}

/** Pure: the `data-theme` attribute value for a choice, or `null` to remove it (system). */
export function themeAttributeValue(choice: ThemeChoice): "light" | "dark" | null {
  return choice === "system" ? null : choice;
}

/** Pure: the `data-palette` attribute value, or `null` to remove it (default). */
export function paletteAttributeValue(choice: PaletteChoice): PaletteChoice | null {
  return choice === "default" ? null : choice;
}

function applyAttribute(root: ThemeRoot, name: string, value: string | null): void {
  if (value) root.setAttribute(name, value);
  else root.removeAttribute(name);
}

/** Persists `choice` and applies it to `root` (defaults: localStorage + `<html>`). */
export function setTheme(
  choice: ThemeChoice,
  opts: { root?: ThemeRoot; storage?: StorageWriter } = {},
): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  storage.setItem(THEME_STORAGE_KEY, choice);
  applyAttribute(root, "data-theme", themeAttributeValue(choice));
}

/** Persists `choice` and applies it to `root`. Polarity is left untouched:
 * a palette supplies both a light and a dark form, so choosing one must not
 * discard the reader's light/dark decision. */
export function setPalette(
  choice: PaletteChoice,
  opts: { root?: ThemeRoot; storage?: StorageWriter } = {},
): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  storage.setItem(PALETTE_STORAGE_KEY, choice);
  applyAttribute(root, "data-palette", paletteAttributeValue(choice));
}

/** Reads whatever is already stored and applies it — the app-boot entry point. */
export function applyStoredTheme(opts: { root?: ThemeRoot; storage?: StorageReader } = {}): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  applyAttribute(root, "data-theme", themeAttributeValue(readStoredTheme(storage)));
}

/** The palette half of the app-boot entry point. */
export function applyStoredPalette(opts: { root?: ThemeRoot; storage?: StorageReader } = {}): void {
  const root = opts.root ?? documentRoot();
  const storage = opts.storage ?? safeLocalStorage();
  applyAttribute(root, "data-palette", paletteAttributeValue(readStoredPalette(storage)));
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
