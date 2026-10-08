// @vitest-environment jsdom
/**
 * Draft-store unit tests: per-thread slot isolation, empty-slot GC, and the
 * orphan-adoption rule that carries a pre-threads draft (typed or prefilled
 * while the threads query loaded) into the real thread, and draft text that
 * survives a reload.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { draftKey, EMPTY_DRAFT, useComposerDraftStore, prefillComposerDraft } from "./composer-drafts";

const SESSION = "sess-1";
const THREAD = "thread-1";

function store() {
  return useComposerDraftStore.getState();
}

beforeEach(() => {
  localStorage.clear();
  useComposerDraftStore.setState({ owner: "account-a", byKey: {} });
});

describe("composer draft store", () => {
  it("keeps drafts isolated per thread", () => {
    store().setText(draftKey(SESSION, "a"), "for thread a");
    store().setText(draftKey(SESSION, "b"), "for thread b");
    expect(store().byKey[draftKey(SESSION, "a")].text).toBe("for thread a");
    expect(store().byKey[draftKey(SESSION, "b")].text).toBe("for thread b");
  });

  it("deletes a slot whose draft empties out again", () => {
    const key = draftKey(SESSION, THREAD);
    store().setText(key, "draft");
    store().setText(key, "");
    expect(store().byKey[key]).toBeUndefined();
  });

  it("clear drops the whole slot", () => {
    const key = draftKey(SESSION, THREAD);
    store().setText(key, "draft");
    store().setFileErrors(key, ["send failed"]);
    store().clear(key);
    expect(store().byKey[key]).toBeUndefined();
  });

  it("list setters accept functional updates", () => {
    const key = draftKey(SESSION, THREAD);
    store().setImageErrors(key, ["first"]);
    store().setImageErrors(key, (prev) => [...prev, "second"]);
    expect(store().byKey[key].imageErrors).toEqual(["first", "second"]);
  });

  it("adoptOrphanDraft moves the no-thread draft into an empty thread slot", () => {
    store().setText(draftKey(SESSION, undefined), "typed before threads loaded");
    store().adoptOrphanDraft(SESSION, THREAD);
    expect(store().byKey[draftKey(SESSION, THREAD)].text).toBe("typed before threads loaded");
    expect(store().byKey[draftKey(SESSION, undefined)]).toBeUndefined();
  });

  it("adoptOrphanDraft never overwrites a thread's existing draft", () => {
    store().setText(draftKey(SESSION, THREAD), "the real draft");
    store().setText(draftKey(SESSION, undefined), "orphan");
    store().adoptOrphanDraft(SESSION, THREAD);
    expect(store().byKey[draftKey(SESSION, THREAD)].text).toBe("the real draft");
    // The orphan is dropped either way — it must not re-adopt later.
    expect(store().byKey[draftKey(SESSION, undefined)]).toBeUndefined();
  });

  it("adoptOrphanDraft is a no-op without an orphan", () => {
    const before = store().byKey;
    store().adoptOrphanDraft(SESSION, THREAD);
    expect(store().byKey).toBe(before);
  });

  it("EMPTY_DRAFT is returned by reads of unknown slots via the hook selector shape", () => {
    // The hook itself needs React; assert the underlying contract the
    // selector relies on — an unknown key is absent, and EMPTY_DRAFT is
    // the stable fallback value.
    expect(store().byKey["nope"]).toBeUndefined();
    expect(EMPTY_DRAFT.text).toBe("");
  });
});

describe("starter drafts", () => {
  it("does not append repeated starters and repairs identical legacy copies", () => {
    const key = draftKey(SESSION, THREAD);
    store().setText(key, "Create a workflow\n\nCreate a workflow");
    prefillComposerDraft(SESSION, THREAD, "Create a workflow");
    prefillComposerDraft(SESSION, THREAD, "Create a workflow");
    expect(store().byKey[key]?.text).toBe("Create a workflow");
  });
  it("preserves user text and keeps workspace drafts separate", () => {
    const key = draftKey(SESSION, THREAD);
    store().setText(key, "My unfinished request");
    prefillComposerDraft(SESSION, THREAD, "Create a workflow");
    prefillComposerDraft("another-workspace", THREAD, "Create a workflow");
    expect(store().byKey[key]?.text).toBe("My unfinished request");
    expect(store().byKey[draftKey("another-workspace", THREAD)]?.text).toBe("Create a workflow");
  });

  it("restores draft text after reactivation and keeps attachments in memory", () => {
    const key = draftKey(SESSION, THREAD);
    store().setText(key, "typed before reload");
    store().setFileErrors(key, ["too large"]);
    store().activateOwner("");
    store().activateOwner("account-a");
    expect(store().byKey[key]).toEqual({ ...EMPTY_DRAFT, text: "typed before reload" });

    store().clear(key);
    expect(localStorage.getItem(`valet:composer-draft:v2:${key}`)).toBeNull();
  });

  it("does not replay a queued draft update over newer text in shared storage", () => {
    const key = draftKey(SESSION, THREAD);
    const storageKey = `valet:composer-draft:v2:${key}`;
    store().setText(key, "aaa");
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: "a", storageArea: localStorage }));
    expect(store().byKey[key]?.text).toBe("aaa");
    expect(localStorage.getItem(storageKey)).toBe("aaa");
    localStorage.setItem(storageKey, "aaaa");
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: "aaaa", storageArea: localStorage }));
    expect(store().byKey[key]?.text).toBe("aaaa");
    localStorage.removeItem(storageKey);
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: "aaa", storageArea: localStorage }));
    expect(localStorage.getItem(storageKey)).toBeNull();
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: null, storageArea: localStorage }));
    expect(store().byKey[key]).toBeUndefined();
  });

  it("applies another window's draft without touching this window's others", () => {
    const mine = draftKey("session-a", "thread-a");
    const theirs = draftKey("session-b", "thread-b");
    store().setText(mine, "draft A");
    localStorage.setItem(`valet:composer-draft:v2:${theirs}`, "draft B");
    window.dispatchEvent(new StorageEvent("storage", { key: `valet:composer-draft:v2:${theirs}`, newValue: "draft B", storageArea: localStorage }));
    expect(store().byKey[mine]?.text).toBe("draft A");
    expect(store().byKey[theirs]?.text).toBe("draft B");
    // That window sent its message.
    localStorage.removeItem(`valet:composer-draft:v2:${theirs}`);
    window.dispatchEvent(new StorageEvent("storage", { key: `valet:composer-draft:v2:${theirs}`, newValue: null, storageArea: localStorage }));
    expect(store().byKey[theirs]).toBeUndefined();
    expect(store().byKey[mine]?.text).toBe("draft A");
  });
});


describe("account isolation", () => {
  it("isolates the same team thread across accounts, rejects late uploads and restores only its owner's text", () => {
    const alice = draftKey(SESSION, THREAD);
    store().setText(alice, "Alice private draft");
    store().activateOwner("account-b");
    const bob = draftKey(SESSION, THREAD);
    expect(bob).not.toBe(alice);
    expect(store().byKey).toEqual({});
    store().setFileErrors(alice, ["late upload"]);
    store().setText(bob, "Bob draft");
    localStorage.setItem(`valet:composer-draft:v2:${alice}`, "foreign window");
    window.dispatchEvent(new StorageEvent("storage", { key: `valet:composer-draft:v2:${alice}`, newValue: "foreign window", storageArea: localStorage }));
    expect(store().byKey[alice]).toBeUndefined();
    store().activateOwner("account-a");
    expect(store().byKey[alice]).toEqual({ ...EMPTY_DRAFT, text: "foreign window" });
    expect(store().byKey[bob]).toBeUndefined();
  });

  it("does not restore unscoped legacy drafts for the next signed-in account", () => {
    localStorage.setItem(`valet:composer-draft:${SESSION}\u0000${THREAD}`, "unattributed private text");
    store().activateOwner("new-account");
    expect(store().byKey).toEqual({});
  });
});
