/**
 * Per-browser UI preferences persisted in localStorage.
 *
 * Accessors take an injectable `storage` defaulting to `safeLocalStorage()`
 * (`./safe-storage.ts`) — the same pattern `theme.ts` and
 * `command-recency.ts` use. The shared shim degrades to an in-memory Map
 * when real storage is absent or non-functional, so a write still
 * round-trips on the next read within the page's lifetime. Reads that fail
 * outright fall back to the schema default; no exception escapes.
 */
import { safeLocalStorage, type StorageReader, type StorageWriter } from "./safe-storage";

/**
 * Default policy applied to a tool card at mount and across status
 * transitions. See `docs/specs/2026-08-20-tool-card-collapse-policy-design.md`
 * for the full interaction matrix; the policy itself is implemented by
 * `packages/web/src/components/session/tool-renderers/tool-shell.tsx`.
 *
 * - `smart` — running expanded, completed collapsed at mount; auto-collapse
 *   on completion unless the user touched the card.
 * - `always-collapsed` — every card mounts collapsed.
 * - `always-expanded` — every card mounts expanded and stays open.
 *
 * Errors override every policy: an error card always opens.
 */
export type ToolCardDefault = "smart" | "always-collapsed" | "always-expanded";

const TOOL_CARD_DEFAULT_KEY = "tool-card-default";
const TOOL_CARD_DEFAULT_FALLBACK: ToolCardDefault = "smart";

const TOOL_CARD_DEFAULT_VALUES: readonly ToolCardDefault[] = [
  "smart",
  "always-collapsed",
  "always-expanded",
];

function isToolCardDefault(value: string): value is ToolCardDefault {
  return (TOOL_CARD_DEFAULT_VALUES as readonly string[]).includes(value);
}

/**
 * Read the tool-card default policy.
 *
 * Returns `smart` when the key is absent, when the stored value is not one
 * of the known policies, or when the read throws. A corrupted value
 * self-heals to the schema default on the next write.
 */
export function getToolCardDefault(
  storage: StorageReader = safeLocalStorage(),
): ToolCardDefault {
  let raw: string | null;
  try {
    raw = storage.getItem(TOOL_CARD_DEFAULT_KEY);
  } catch {
    return TOOL_CARD_DEFAULT_FALLBACK;
  }
  return raw !== null && isToolCardDefault(raw) ? raw : TOOL_CARD_DEFAULT_FALLBACK;
}

/**
 * Persist the tool-card default policy.
 *
 * A throwing write (quota, private mode) is swallowed: the next
 * `getToolCardDefault()` call returns whatever the store still reports.
 */
export function setToolCardDefault(
  value: ToolCardDefault,
  storage: StorageWriter = safeLocalStorage(),
): void {
  try {
    storage.setItem(TOOL_CARD_DEFAULT_KEY, value);
  } catch {
    /* Best-effort persistence; the caller's UI state stands. */
  }
}
