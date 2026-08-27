/**
 * Safe localStorage access, shared by the per-browser preference modules
 * (`theme.ts`, `command-recency.ts`, `preferences.ts`).
 *
 * `safeLocalStorage()` returns the real `window.localStorage` when it is
 * present and functional, and an in-memory Map otherwise. Two traps make
 * the guard necessary: Node ≥22 ships a stub `localStorage` global whose
 * methods are undefined without --localstorage-file, and it can shadow
 * jsdom's in tests; Chrome throws a SecurityError on the property access
 * itself when the user blocks cookies. The Map keeps reads and writes
 * coherent within the page's lifetime, so a toggle still works for the
 * session even when persistence is unavailable.
 */

export interface StorageReader {
  getItem(key: string): string | null;
}

export interface StorageWriter {
  setItem(key: string, value: string): void;
}

/** In-memory fallback when real storage is absent or non-functional.
 * Module-level and therefore shared for the process lifetime: tests that
 * call an accessor WITHOUT an explicit `storage` argument share this map
 * and can bleed into each other — pass a per-test storage instead (see
 * `command-recency.test.ts`). */
const memoryStorage = new Map<string, string>();

export function safeLocalStorage(): StorageReader & StorageWriter {
  let candidate: unknown;
  try {
    candidate = typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    // Accessing `window.localStorage` itself throws when the browser
    // blocks storage (e.g. Chrome with cookies disabled).
    candidate = undefined;
  }
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as Partial<Storage>).getItem === "function" &&
    typeof (candidate as Partial<Storage>).setItem === "function"
  ) {
    // Structural narrowing of a host object; `Partial<Storage>` has no
    // overlap the compiler can verify beyond the two probed methods.
    return candidate as StorageReader & StorageWriter;
  }
  return {
    getItem: (key) => memoryStorage.get(key) ?? null,
    setItem: (key, value) => {
      memoryStorage.set(key, value);
    },
  };
}
