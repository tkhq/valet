/**
 * Slash-command recency: which commands this browser used, and when.
 *
 * The composer records a use on every sent slash command, and the command
 * popup sorts its suggestions so recently used commands float to the top
 * (see `commandsToItems`). Storage is per-browser `localStorage` under
 * `valet-command-recency` — a UX ranking, not server state, so losing it
 * (new device, cleared storage) only resets the ordering.
 *
 * Functions take injectable `storage` so the logic is unit-testable without
 * a DOM, the same pattern `theme.ts` uses.
 */

export const COMMAND_RECENCY_STORAGE_KEY = "valet-command-recency";

/** Entries kept per browser. Oldest drop first — 50 covers every command a
 * person plausibly cycles through while keeping the stored JSON small. */
export const COMMAND_RECENCY_MAX_ENTRIES = 50;

/** Command name → epoch ms of the most recent use. */
export type CommandRecency = Record<string, number>;

interface StorageReader {
  getItem(key: string): string | null;
}

interface StorageWriter {
  setItem(key: string, value: string): void;
}

/** Reads the stored map. Anything unreadable (absent key, bad JSON, wrong
 * shapes) degrades to an empty map — ranking is best-effort by design. */
export function readCommandRecency(storage: StorageReader = safeLocalStorage()): CommandRecency {
  let raw: string | null;
  try {
    raw = storage.getItem(COMMAND_RECENCY_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const map: CommandRecency = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "number" && Number.isFinite(value)) map[name] = value;
  }
  return map;
}

/**
 * Stamps `name` as used at `now`, trims to the newest
 * `COMMAND_RECENCY_MAX_ENTRIES`, persists, and returns the new map. A
 * storage write failure (quota, private mode) still returns the updated
 * in-memory map, so the current page keeps its ordering.
 */
export function recordCommandUse(
  name: string,
  now: number = Date.now(),
  storage: StorageReader & StorageWriter = safeLocalStorage(),
): CommandRecency {
  const map = readCommandRecency(storage);
  map[name] = now;
  const trimmed = Object.fromEntries(
    Object.entries(map)
      .sort(([, a], [, b]) => b - a)
      .slice(0, COMMAND_RECENCY_MAX_ENTRIES),
  );
  try {
    storage.setItem(COMMAND_RECENCY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Best-effort persistence; the returned map still serves this page.
  }
  return trimmed;
}

/** In-memory fallback when real storage is absent or non-functional — same
 * rationale as `theme.ts` (Node ≥22 ships a stub `localStorage` global). */
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
