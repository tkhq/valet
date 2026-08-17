import { create } from "zustand";

/**
 * Composer-prefill mechanism (decision 17): the memory doc pane's
 * "Ask {name} to update this" footer navigates to `/chat` and needs the
 * composer to open with `Update memory file {path}: ` already typed. A
 * search param on `/chat` was the other option the brief floated, but that
 * route already owns `thread`/`child` search state (see `routes/chat.tsx`)
 * and a `prefill` param would either linger in the URL after being
 * consumed (stale on back/forward) or need its own strip-on-mount dance.
 * A tiny write-once store is simpler: the memory page sets it right before
 * navigating, and the next `Composer` to mount consumes it exactly once
 * via `getState().consume()` in its initial-text state initializer — see
 * `components/session/composer.tsx`. Not reactive on purpose (no
 * subscription): it's a handoff, not shared state.
 */
interface ComposerPrefillState {
  text: string | null;
  /** Monotonic counter: each `requestFocus()` bump asks the mounted
   * Composer to focus its input (thread-tree's New thread button). A
   * counter instead of a boolean so repeated requests always re-trigger
   * the subscriber effect. */
  focusNonce: number;
  /** Monotonic counter bumped by every `set()`, for the same reason
   * `focusNonce` exists: the workflow editor's assistant panel keeps its
   * Composer mounted beside the canvas, so a suggestion pressed while the
   * panel is open has no mount to seed. The Composer watches this counter
   * and consumes on a bump. */
  prefillNonce: number;
  set: (text: string) => void;
  /** Reads and clears in one step — a second call returns `null`. */
  consume: () => string | null;
  requestFocus: () => void;
}

export const useComposerPrefillStore = create<ComposerPrefillState>((set, get) => ({
  text: null,
  focusNonce: 0,
  prefillNonce: 0,
  set: (text) => set((s) => ({ text, prefillNonce: s.prefillNonce + 1 })),
  consume: () => {
    const current = get().text;
    if (current !== null) set({ text: null });
    return current;
  },
  requestFocus: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),
}));
