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
 *
 * The send key persists beside the text from the moment a send starts. A
 * send with a 2xx answer or a definite 4xx answer drops it. If the page
 * reloads while the send is in flight, the key brings its text back into
 * the box, so a resend reuses the key and the api does not post twice.
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
  /**
   * The history index of the prompt that Up or Down put in `text`. Every
   * composer on the thread reads it, and any other text change drops it, so
   * an edit in one composer ends the recall in all of them.
   */
  recall?: number;
  /**
   * The idempotency key of a send that is in flight or got no answer
   * (`SendPromptRequest.clientMessageId`). A resend of the same text and the
   * same attachments reuses it, so the api does not post the message twice
   * when the first try landed after all.
   */
  sendKey?: SendKey;
}

/** `attachments` holds the local ids of the images and files the send carried. */
export interface SendKey {
  id: string;
  text: string;
  attachments: string[];
}

/**
 * The kept key when `text` and `attachments` are exactly what that send
 * carried, else undefined. A changed attachment is a different message,
 * so it must not reuse the key.
 */
export function reusableSendKey(sendKey: SendKey | undefined, text: string, attachments: string[]): string | undefined {
  if (!sendKey || sendKey.text !== text || sendKey.attachments.length !== attachments.length) return undefined;
  const sent = [...sendKey.attachments].sort();
  return [...attachments].sort().every((id, i) => id === sent[i]) ? sendKey.id : undefined;
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
    draft.fileErrors.length === 0 &&
    draft.sendKey === undefined
  );
}

interface ComposerDraftStore {
  owner: string;
  activateOwner(owner: string): void;
  byKey: Record<string, ComposerDraft>;
  /** Replace the text. This ends a recall. An empty text also drops the send key. */
  setText(key: string, text: string): void;
  /** Show history prompt `index` as the text, or an empty text when `index` is null. */
  recallText(key: string, index: number | null, text: string): void;
  setImages(key: string, update: ListUpdate<ComposerImage>): void;
  setFiles(key: string, update: ListUpdate<ComposerFile>): void;
  setImageErrors(key: string, update: ListUpdate<string>): void;
  setFileErrors(key: string, update: ListUpdate<string>): void;
  setSendKey(key: string, sendKey: ComposerDraft["sendKey"]): void;
  /** Drop the send key if it is still `id`. A later send on the slot can own a newer key. */
  settleSendKey(key: string, id: string): void;
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
const STORAGE_PREFIX = "valet:composer-draft:v2:";
/** One JSON `SendKey` per draft, beside the draft's text entry. */
const SEND_KEY_PREFIX = "valet:composer-send-key:v1:";

function parseSendKey(raw: string | null): SendKey | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("id" in value) || !("text" in value) || !("attachments" in value)) return undefined;
    const { id, text, attachments } = value;
    if (typeof id !== "string" || typeof text !== "string" || !Array.isArray(attachments)) return undefined;
    if (!attachments.every((a): a is string => typeof a === "string")) return undefined;
    return { id, text, attachments };
  } catch {
    return undefined;
  }
}

/**
 * The owner's stored drafts. A send key without text is a send that was in
 * flight at the reload: its text comes back into the box with it.
 */
function storedDrafts(owner: string): Record<string, ComposerDraft> {
  const byKey: Record<string, ComposerDraft> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      const prefix = [STORAGE_PREFIX, SEND_KEY_PREFIX].find((p) => name?.startsWith(p + owner + "\u0000"));
      if (!name || !prefix) continue;
      const key = name.slice(prefix.length);
      if (byKey[key]) continue;
      const text = localStorage.getItem(STORAGE_PREFIX + key);
      const sendKey = parseSendKey(localStorage.getItem(SEND_KEY_PREFIX + key));
      if (text) byKey[key] = sendKey ? { ...EMPTY_DRAFT, text, sendKey } : { ...EMPTY_DRAFT, text };
      else if (sendKey) byKey[key] = { ...EMPTY_DRAFT, text: sendKey.text, sendKey };
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

function storeSendKey(key: string, sendKey: SendKey | undefined): void {
  try {
    if (!useComposerDraftStore.getState().owner) return;
    if (sendKey) localStorage.setItem(SEND_KEY_PREFIX + key, JSON.stringify(sendKey));
    else localStorage.removeItem(SEND_KEY_PREFIX + key);
  } catch { /* keep the in-memory key */ }
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
    // An emptied box drops the key too. Otherwise a key whose text the
    // person deleted would bring that text back at the next reload.
    setText: (key, text) => patch(key, ({ recall: _, sendKey, ...d }) => (text && sendKey ? { ...d, text, sendKey } : { ...d, text })),
    recallText: (key, index, text) =>
      patch(key, ({ recall: _, ...d }) => (index === null ? { ...d, text } : { ...d, text, recall: index })),
    setImages: (key, update) => patch(key, (d) => ({ ...d, images: resolve(update, d.images) })),
    setFiles: (key, update) => patch(key, (d) => ({ ...d, files: resolve(update, d.files) })),
    setImageErrors: (key, update) =>
      patch(key, (d) => ({ ...d, imageErrors: resolve(update, d.imageErrors) })),
    setFileErrors: (key, update) =>
      patch(key, (d) => ({ ...d, fileErrors: resolve(update, d.fileErrors) })),
    setSendKey: (key, sendKey) => patch(key, (d) => ({ ...d, sendKey })),
    settleSendKey: (key, id) =>
      patch(key, ({ sendKey, ...d }) => (sendKey && sendKey.id !== id ? { ...d, sendKey } : d)),
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
    const sendKey = state.byKey[key]?.sendKey;
    if (sendKey !== prev.byKey[key]?.sendKey) storeSendKey(key, sendKey);
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
