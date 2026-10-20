/**
 * The handoff from the editor's Create to the overview (spec Part H step 9).
 * Only the overview's launch points call `announceCreated` with the stored id. The
 * header's **Add** sits in the section layout, outside the overview, so the
 * handoff is a small module store, not a prop. The overview reads it with
 * `useCreatedTarget`, waits until its lists hold the id, then marks that
 * row and calls `clearCreated`.
 */
import { useSyncExternalStore } from "react";
import type { EditorSaved } from "./editor/line-editor";

/** What a Create stored: a line or a routine, by its id. */
export type CreatedTarget = EditorSaved;

let pending: CreatedTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Records what a Create stored, for the overview to mark. */
export function announceCreated(created: CreatedTarget): void {
  pending = created;
  emit();
}

/** Forgets the recorded Create, once the overview marked it. */
export function clearCreated(): void {
  if (pending === null) return;
  pending = null;
  emit();
}

/** The Create the overview has not marked yet, or null. */
export function useCreatedTarget(): CreatedTarget | null {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}
