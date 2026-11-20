// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DootButton, shouldDoot } from "./doot-button";

function press(key: string, target: EventTarget | null, mods: Partial<KeyboardEvent> = {}) {
  return shouldDoot({ key, target, ctrlKey: false, metaKey: false, altKey: false, ...mods });
}

describe("shouldDoot", () => {
  it("fires on 0 from the page body", () => {
    expect(press("0", document.body)).toBe(true);
  });

  it("ignores other keys", () => {
    expect(press("1", document.body)).toBe(false);
  });

  it("ignores focus in text-entry elements", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(press("0", document.createElement(tag))).toBe(false);
    }
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(press("0", editable)).toBe(false);
  });

  it("ignores ctrl, meta and alt", () => {
    expect(press("0", document.body, { ctrlKey: true })).toBe(false);
    expect(press("0", document.body, { metaKey: true })).toBe(false);
    expect(press("0", document.body, { altKey: true })).toBe(false);
  });
});

describe("DootButton", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates the AudioContext lazily and plays on click and on key", async () => {
    const osc = {
      type: "",
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    osc.connect.mockReturnValue(gain);
    gain.connect.mockReturnValue(undefined);
    const ctor = vi.fn(function () {
      return { state: "running", currentTime: 0, destination: {}, createOscillator: () => osc, createGain: () => gain };
    });
    vi.stubGlobal("AudioContext", ctor);

    render(<DootButton />);
    expect(ctor).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Doot" }));
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(osc.start).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("0");
    expect(osc.start).toHaveBeenCalledTimes(2);
    expect(ctor).toHaveBeenCalledTimes(1);
  });
});
