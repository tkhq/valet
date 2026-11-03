// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstVisitTasksOpen, loadTasksPanelChoice, storeTasksPanelChoice } from "./tasks-panel-choice";

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

  it("opens on a first visit only when something needs the person on a wide window", () => {
    expect(firstVisitTasksOpen(1, 1280)).toBe(true);
    expect(firstVisitTasksOpen(1, 1279)).toBe(false);
    expect(firstVisitTasksOpen(0, 1920)).toBe(false);
  });
});
