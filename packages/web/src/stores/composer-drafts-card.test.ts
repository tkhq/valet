// @vitest-environment jsdom
/**
 * A duplicated browser tab restores the same Tabs card ids. Card drafts must
 * stay in that tab's session storage, so the copy never overwrites them.
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("~/lib/card-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/card-context")>();
  return { ...actual, cardId: () => "one", cardStorageKey: (key: string) => actual.cardStorageKey(key, "one") };
});

import { draftKey, useComposerDraftStore } from "./composer-drafts";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useComposerDraftStore.setState({ owner: "account-a", byKey: {} });
});

it("keeps a card draft in this browser tab when a duplicated tab writes the same card key", () => {
  const key = draftKey("sess-1", "thread-1");
  const storageKey = `valet:card:one:valet:composer-draft:v2:${key}`;
  useComposerDraftStore.getState().setText(key, "unsent request");
  expect(sessionStorage.getItem(storageKey)).toBe("unsent request");
  expect(localStorage.getItem(storageKey)).toBeNull();

  localStorage.setItem(storageKey, "text from the duplicated tab");
  window.dispatchEvent(new StorageEvent("storage", { key: storageKey, newValue: "text from the duplicated tab", storageArea: localStorage }));
  expect(useComposerDraftStore.getState().byKey[key]?.text).toBe("unsent request");

  useComposerDraftStore.getState().activateOwner("");
  useComposerDraftStore.getState().activateOwner("account-a");
  expect(useComposerDraftStore.getState().byKey[key]?.text).toBe("unsent request");
});
