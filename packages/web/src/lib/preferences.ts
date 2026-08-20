/**
 * Per-browser UI preferences persisted in localStorage.
 *
 * This module is the first `packages/web` preference. Legacy V1 stored
 * `thread-sidebar-collapsed` inline in `packages/client`; V2 centralises
 * the same pattern here so the next preference has a natural home.
 *
 * Every accessor tolerates a hostile localStorage: throwing setters (a
 * private-mode Safari quirk), absent globals (SSR), and stored strings
 * that no longer match the current schema. When the store rejects a
 * write, the getter returns the schema default on the next read; no
 * exception escapes.
 */

/**
 * Default policy applied to a tool card at mount and across status
 * transitions. See `docs/specs/2026-08-20-tool-card-collapse-policy-design.md`
 * for the full interaction matrix. Consumed by
 * `packages/web/src/components/session/tool-renderers/tool-shell.tsx`.
 *
 * - `smart` — running expanded, completed collapsed at mount; a card that
 *   flips running→completed auto-collapses unless the user toggled the
 *   header while it was running. Errors always stay expanded.
 * - `always-collapsed` — every card mounts collapsed. Errors override.
 * - `always-expanded` — every card mounts expanded and stays that way.
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
 * of the known policies, or when localStorage is unavailable. The caller
 * never sees a thrown error, so a corrupted value silently self-heals to
 * the schema default on the next write.
 */
export function getToolCardDefault(): ToolCardDefault {
  try {
    const raw = globalThis.localStorage?.getItem(TOOL_CARD_DEFAULT_KEY);
    if (raw !== null && raw !== undefined && isToolCardDefault(raw)) {
      return raw;
    }
    return TOOL_CARD_DEFAULT_FALLBACK;
  } catch {
    return TOOL_CARD_DEFAULT_FALLBACK;
  }
}

/**
 * Persist the tool-card default policy.
 *
 * A failed write is swallowed. The next `getToolCardDefault()` call
 * returns whatever the store now reports, which is the previous value
 * when the write failed or the fallback when the store is unavailable.
 */
export function setToolCardDefault(value: ToolCardDefault): void {
  try {
    globalThis.localStorage?.setItem(TOOL_CARD_DEFAULT_KEY, value);
  } catch {
    /* localStorage unavailable or quota exceeded — silent no-op. */
  }
}
