import { beforeEach, describe, expect, it } from "vitest";
import { useComposerPrefillStore } from "./composer-prefill";

describe("composer-prefill store", () => {
  beforeEach(() => {
    useComposerPrefillStore.setState({ text: null });
  });

  it("starts empty", () => {
    expect(useComposerPrefillStore.getState().consume()).toBeNull();
  });

  it("consume returns the set text once, then null on a second call", () => {
    useComposerPrefillStore.getState().set("Update memory file journal/2026-07-13.md: ");
    expect(useComposerPrefillStore.getState().consume()).toBe(
      "Update memory file journal/2026-07-13.md: ",
    );
    expect(useComposerPrefillStore.getState().consume()).toBeNull();
  });

  it("set overwrites a prior unconsumed value", () => {
    useComposerPrefillStore.getState().set("first");
    useComposerPrefillStore.getState().set("second");
    expect(useComposerPrefillStore.getState().consume()).toBe("second");
  });
});
