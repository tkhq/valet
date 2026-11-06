// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTasksPanelChoice, storeTasksPanelChoice } from "./tasks-panel-choice";

describe("Tasks panel choice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("round-trips the stored choice", () => {
    expect(loadTasksPanelChoice()).toBeUndefined();
    storeTasksPanelChoice(true);
    expect(loadTasksPanelChoice()).toBe(true);
    storeTasksPanelChoice(false);
    expect(loadTasksPanelChoice()).toBe(false);
  });

  it("falls back to no choice when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => storeTasksPanelChoice(true)).not.toThrow();
    expect(loadTasksPanelChoice()).toBeUndefined();
  });
});
