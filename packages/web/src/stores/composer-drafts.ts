import { cardStorageKey } from "~/lib/card-context";
/**
 * Per-thread composer drafts: text, attachments, and intake errors, keyed
 * by the signed-in account and `draftKey(sessionId, threadId)`.
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
 * (account, sessionId, threadId) tuples. An undefined threadId (threads query still
 * loading) gets the session's "no-thread" slot; `adoptOrphanDraft` moves
 * that slot's content once the real thread id is known.
 */
export function draftKey(sessionId: string, threadId: string | undefined): string {
  return `${useComposerDraftStore.getState().owner}\u0000${sessionId}\u0000${threadId ?? ""}`;
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
  owner: string;
  activateOwner(owner: string): void;
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

/** One localStorage entry per draft, so a write in one window names exactly
 * the draft it changed and leaves the others alone. localStorage can be
 * absent or throw (private windows, blocked site data, a full quota). A draft
 * that cannot be saved still works for this tab. */
const STORAGE_PREFIX = cardStorageKey("valet:composer-draft:v2:");

function storedDrafts(owner: string): Record<string, ComposerDraft> {
  const byKey: Record<string, ComposerDraft> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      const text = name?.startsWith(STORAGE_PREFIX + owner + "\u0000") ? localStorage.getItem(name) : null;
      if (name && text) byKey[name.slice(STORAGE_PREFIX.length)] = { ...EMPTY_DRAFT, text };
    }
  } catch { /* nothing stored */ }
  return byKey;
}

function storeText(key: string, text: string): void {
  try {
    if (!useComposerDraftStore.getState().owner) return;
    if (text) localStorage.setItem(STORAGE_PREFIX + key, text);
    else localStorage.removeItem(STORAGE_PREFIX + key);
  } catch { /* keep the in-memory draft */ }
}

export const useComposerDraftStore = create<ComposerDraftStore>((set) => {
  /** Apply `fn` to the slot; an all-empty result deletes the slot. */
  function patch(key: string, fn: (prev: ComposerDraft) => ComposerDraft): void {
    set((state) => {
      if (!key.startsWith(state.owner + "\u0000")) return state;
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
    owner: "",
    byKey: {},
    // Never attribute legacy unscoped drafts to whichever account signs in next.
    activateOwner: (owner) => set((state) => state.owner === owner ? state : { owner, byKey: owner ? storedDrafts(owner) : {} }),
    setText: (key, text) => patch(key, (d) => ({ ...d, text })),
    setImages: (key, update) => patch(key, (d) => ({ ...d, images: resolve(update, d.images) })),
    setFiles: (key, update) => patch(key, (d) => ({ ...d, files: resolve(update, d.files) })),
    setImageErrors: (key, update) =>
      patch(key, (d) => ({ ...d, imageErrors: resolve(update, d.imageErrors) })),
    setFileErrors: (key, update) =>
      patch(key, (d) => ({ ...d, fileErrors: resolve(update, d.fileErrors) })),
    clear: (key) =>
      set((state) => {
        if (!key.startsWith(state.owner + "\u0000") || state.byKey[key] === undefined) return state;
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
});

let applyingRemoteDraft = false;

useComposerDraftStore.subscribe((state, prev) => {
  if (applyingRemoteDraft) return;
  if (state.owner !== prev.owner || state.byKey === prev.byKey) return;
  for (const key of new Set([...Object.keys(state.byKey), ...Object.keys(prev.byKey)])) {
    const text = state.byKey[key]?.text ?? "";
    if (text !== (prev.byKey[key]?.text ?? "")) storeText(key, text);
  }
});

// Another window changed one draft. Apply that draft only.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(STORAGE_PREFIX)) return;
    if (event.storageArea !== localStorage) return;
    // Storage events can queue behind newer keystrokes or a sent-message clear.
    // Never replay an obsolete value, or echo a remote update to other tabs.
    try {
      if (localStorage.getItem(event.key) !== event.newValue) return;
    } catch { return; }
    applyingRemoteDraft = true;
    try {
      useComposerDraftStore.getState().setText(event.key.slice(STORAGE_PREFIX.length), event.newValue ?? "");
    } finally {
      applyingRemoteDraft = false;
    }
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
