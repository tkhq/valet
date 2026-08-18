// @vitest-environment jsdom
/**
 * The navi easter egg swaps WHICH sound the attention ping makes, and that
 * dispatch is what these tests pin: the flag round-trips through storage,
 * defaults off, and `playAttentionChime` reaches for the mp3 only when the
 * flag says so. The synth path itself is Web Audio and stays untested here
 * — jsdom has no AudioContext, which conveniently makes "fell through to
 * the chime" observable as a `false` return.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isNaviModeEnabled, playAttentionChime, setNaviModeEnabled } from "./notification-sound";

class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  volume = 1;
  preload = "";
  currentTime = 0;
  play = vi.fn(() => Promise.resolve());
  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

beforeEach(() => {
  window.localStorage.clear();
  FakeAudio.instances = [];
  vi.stubGlobal("Audio", FakeAudio);
});

describe("navi mode flag", () => {
  it("defaults off — it is an easter egg, not a setting", () => {
    expect(isNaviModeEnabled()).toBe(false);
  });

  it("round-trips through storage", () => {
    setNaviModeEnabled(true);
    expect(isNaviModeEnabled()).toBe(true);
    setNaviModeEnabled(false);
    expect(isNaviModeEnabled()).toBe(false);
  });
});

describe("playAttentionChime dispatch", () => {
  it("plays the mp3 when navi mode is on, reusing one element", () => {
    setNaviModeEnabled(true);
    expect(playAttentionChime()).toBe(true);
    expect(playAttentionChime()).toBe(true);
    expect(FakeAudio.instances).toHaveLength(1);
    const el = FakeAudio.instances[0];
    expect(el.src).toContain("hey-listen.mp3");
    expect(el.volume).toBeLessThan(1);
    expect(el.play).toHaveBeenCalledTimes(2);
  });

  it("does not touch the mp3 when navi mode is off", () => {
    setNaviModeEnabled(false);
    // jsdom has no AudioContext, so the synth path reports "no sound
    // started" — which doubles as proof we fell through to it.
    expect(playAttentionChime()).toBe(false);
    expect(FakeAudio.instances.flatMap((a) => a.play.mock.calls)).toHaveLength(0);
  });
});
