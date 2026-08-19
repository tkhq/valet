import { createContext, useContext } from "react";

/**
 * Handshake between the composer (owner of the image intake pipeline) and
 * the page-level drop target (owner of the whole-viewport overlay).
 *
 * The composer is a sibling of the message list under SessionView, not an
 * ancestor of it. To let a drop *anywhere* on the chat tab reach the
 * composer's intake, SessionView owns a ref-backed intake object and
 * publishes it via this context. The composer writes the ref on mount and
 * whenever `intakeBlocked` changes; the page-level drop target reads it on
 * each drop.
 *
 * `ownedEl` is the composer's own `<form>` element. The page-level target
 * checks containment before intake to avoid double-processing a drop that
 * already landed on the form (its own `onDrop` handler runs too).
 */
export interface ComposerDropIntake {
  /**
   * Take files (from a whole-page drop) and run them through the
   * composer's intake pipeline — same `acceptImages` + `readImage` +
   * `setImages` path a paste or a picker click takes.
   */
  addFiles(files: File[]): void;
  /**
   * True when intake is temporarily blocked: a send is in flight, the
   * feature is disabled, or the thread id hasn't loaded yet. The page-level
   * drop target refuses drops in this state (and hides the overlay).
   */
  blocked: boolean;
  /**
   * The composer's own form element. The page-level drop target ignores
   * drops whose target is inside `ownedEl`, so the form's `onDrop` handler
   * is the only intake path for those drops. Null before mount.
   */
  ownedEl: HTMLElement | null;
}

/**
 * SessionView provides two channels:
 *
 * - `intake`: what the page-level drop target reads (memoized stable
 *   proxy — its identity doesn't change when the composer's real intake
 *   changes, so mounting/unmounting the overlay is not disturbed).
 * - `publish`: what the composer writes on mount + on `intakeBlocked`
 *   change. Wraps the ref update.
 *
 * Splitting them keeps the composer from having to know about a ref, and
 * keeps the drop target from having to re-attach listeners every render.
 */
export interface ComposerDropChannel {
  intake: ComposerDropIntake;
  publish(next: ComposerDropIntake | null): void;
}

export const ComposerDropContext = createContext<ComposerDropChannel | null>(null);

export function useComposerDrop(): ComposerDropChannel | null {
  return useContext(ComposerDropContext);
}
