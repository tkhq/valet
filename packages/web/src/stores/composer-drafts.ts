/**
 * Per-thread composer drafts: text, attachments, and intake errors, keyed
 * by `draftKey(sessionId, threadId)`.
 *
 * The draft lives OUTSIDE the Composer component for two reasons:
 *
 * 1. Thread scoping. A draft typed for thread A must never send to thread
 *    B. Component-local state followed the mounted instance across thread
 *    switches; a store slot per thread cannot.
 * 2. Upload survival. A file upload started on a thread keeps running if
 *    the user switches away. Its result folds into the ORIGINATING
 *    thread's slot here — component state would have dropped it on
 *    unmount, silently losing the attachment.
 *
 * The text also persists to localStorage, so a draft survives a reload and
 * shows in another window. Attachments stay in memory: they are uploads in
 * flight, not text that can be written back.
 */
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ComposerImage } from "~/components/session/composer-images";
import type { ComposerFile } from "~/components/session/composer-files";

export interface ComposerDraft {
  text: string;
  images: ComposerImage[];
  files: ComposerFile[];
  /** Intake refusals, one line per refused image. */
  imageErrors: string[];
  /** Intake refusals and send failures for file attachments. */
  fileErrors: string[];
}

/**
 * Stable empty draft so the selector returns a referentially equal value
 * for threads with no draft — zustand re-renders on identity change.
 */
export const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  images: [],
  files: [],
  imageErrors: [],
  fileErrors: [],
};

/**
 * NUL (`"\u0000"`) cannot appear in either id, so keys never collide across
 * (sessionId, threadId) pairs. An undefined threadId (threads query still
 * loading) gets the session's "no-thread" slot; `adoptOrphanDraft` moves
 * that slot's content once the real thread id is known.
 */
export function draftKey(sessionId: string, threadId: string | undefined): string {
  return `${sessionId}\u0000${threadId ?? ""}`;
}

type ListUpdate<T> = T[] | ((prev: T[]) => T[]);

function resolve<T>(update: ListUpdate<T>, prev: T[]): T[] {
  return typeof update === "function" ? update(prev) : update;
}

function isEmpty(draft: ComposerDraft): boolean {
  return (
    draft.text === "" &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.imageErrors.length === 0 &&
    draft.fileErrors.length === 0
  );
}

interface ComposerDraftStore {
  byKey: Record<string, ComposerDraft>;
  setText(key: string, text: string): void;
  setImages(key: string, update: ListUpdate<ComposerImage>): void;
  setFiles(key: string, update: ListUpdate<ComposerFile>): void;
  setImageErrors(key: string, update: ListUpdate<string>): void;
  setFileErrors(key: string, update: ListUpdate<string>): void;
  /** Drop the whole draft (a successful send). */
  clear(key: string): void;
  /**
   * Move the session's no-thread draft into `threadId`'s slot. A Composer
   * can mount before the threads query resolves; anything typed or
   * prefilled in that window lands in the no-thread slot. A non-empty
   * target wins — never overwrite a real draft with the orphan. The orphan
   * slot empties either way so it cannot re-adopt into a later thread.
   */
  adoptOrphanDraft(sessionId: string, threadId: string): void;
}

/** localStorage can be absent or throw (private windows, blocked site data,
 * a full quota). A draft that cannot be saved still works for this tab. */
const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try { return localStorage.getItem(name); } catch { return null; }
  },
  setItem: (name, value) => {
    try { localStorage.setItem(name, value); } catch { /* keep the in-memory draft */ }
  },
  removeItem: (name) => {
    try { localStorage.removeItem(name); } catch { /* nothing to remove */ }
  },
};

const STORAGE_NAME = "valet:composer-drafts";

type PersistedDrafts = { texts: Record<string, string> };

export const useComposerDraftStore = create<ComposerDraftStore>()(persist((set) => {
  /** Apply `fn` to the slot; an all-empty result deletes the slot. */
  function patch(key: string, fn: (prev: ComposerDraft) => ComposerDraft): void {
    set((state) => {
      const next = fn(state.byKey[key] ?? EMPTY_DRAFT);
      if (isEmpty(next)) {
        if (state.byKey[key] === undefined) return state;
        const { [key]: _, ...rest } = state.byKey;
        return { byKey: rest };
      }
      return { byKey: { ...state.byKey, [key]: next } };
    });
  }
  return {
    byKey: {},
    setText: (key, text) => patch(key, (d) => ({ ...d, text })),
    setImages: (key, update) => patch(key, (d) => ({ ...d, images: resolve(update, d.images) })),
    setFiles: (key, update) => patch(key, (d) => ({ ...d, files: resolve(update, d.files) })),
    setImageErrors: (key, update) =>
      patch(key, (d) => ({ ...d, imageErrors: resolve(update, d.imageErrors) })),
    setFileErrors: (key, update) =>
      patch(key, (d) => ({ ...d, fileErrors: resolve(update, d.fileErrors) })),
    clear: (key) =>
      set((state) => {
        if (state.byKey[key] === undefined) return state;
        const { [key]: _, ...rest } = state.byKey;
        return { byKey: rest };
      }),
    adoptOrphanDraft: (sessionId, threadId) =>
      set((state) => {
        const orphanKey = draftKey(sessionId, undefined);
        const orphan = state.byKey[orphanKey];
        if (orphan === undefined) return state;
        const targetKey = draftKey(sessionId, threadId);
        const target = state.byKey[targetKey];
        const { [orphanKey]: _, ...rest } = state.byKey;
        return { byKey: target !== undefined ? rest : { ...rest, [targetKey]: orphan } };
      }),
  };
}, {
  name: STORAGE_NAME,
  version: 1,
  storage: createJSONStorage<PersistedDrafts>(() => safeLocalStorage),
  partialize: (state): PersistedDrafts => ({
    texts: Object.fromEntries(
      Object.entries(state.byKey).filter(([, draft]) => draft.text !== "").map(([key, draft]) => [key, draft.text]),
    ),
  }),
  // The stored texts win; attachments and errors in memory are kept.
  merge: (persisted, current) => {
    const texts = (persisted as PersistedDrafts | undefined)?.texts ?? {};
    const byKey: Record<string, ComposerDraft> = {};
    for (const [key, draft] of Object.entries(current.byKey)) byKey[key] = { ...draft, text: texts[key] ?? "" };
    for (const [key, text] of Object.entries(texts)) byKey[key] = { ...(byKey[key] ?? EMPTY_DRAFT), text };
    for (const [key, draft] of Object.entries(byKey)) if (isEmpty(draft)) delete byKey[key];
    return { ...current, byKey };
  },
}));

// Another window wrote its drafts. Reload them, so this window's next write
// does not put back the text that window just changed.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_NAME) void useComposerDraftStore.persist.rehydrate();
  });
}

/** The draft for one (sessionId, threadId) slot, or the stable empty draft. */
export function useComposerDraft(key: string): ComposerDraft {
  return useComposerDraftStore((s) => s.byKey[key] ?? EMPTY_DRAFT);
}

/** Starter buttons fill an empty draft; repeated clicks never append or erase user text. */
export function prefillComposerDraft(sessionId: string, threadId: string, prompt: string): void {
  const store = useComposerDraftStore.getState();
  const key = draftKey(sessionId, threadId);
  const existing = store.byKey[key]?.text;
  if (!existing?.trim() || existing.split("\n\n").every((part) => part.trim() === prompt)) {
    store.setText(key, prompt);
  }
}
