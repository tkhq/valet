// @vitest-environment jsdom
/**
 * The navi easter egg swaps WHICH sound the attention ping makes, and that
 * dispatch is what these tests pin: the flag round-trips through storage,
 * defaults off, `playAttentionChime` reaches for the mp3 only when the flag
 * says so, and an mp3 that fails to play falls back to the synth chime. The
 * chime path runs against a minimal fake AudioContext — jsdom has none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isNaviModeEnabled,
  playAttentionChime,
  resetAudioForTests,
  setNaviModeEnabled,
} from "./notification-sound";

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

/** Just enough AudioContext for the chime to schedule its two tones. */
function fakeAudioContext() {
  const oscillatorStarts = vi.fn();
  const gainParam = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  class FakeContext {
    state = "running";
    currentTime = 0;
    destination = {};
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 0 },
        connect: vi.fn(),
        start: oscillatorStarts,
        stop: vi.fn(),
      };
    }
    createGain() {
      return { gain: gainParam, connect: vi.fn() };
    }
    resume() {
      return Promise.resolve();
    }
  }
  return { FakeContext, oscillatorStarts };
}

beforeEach(() => {
  window.localStorage.clear();
  FakeAudio.instances = [];
  vi.unstubAllGlobals();
  vi.stubGlobal("Audio", FakeAudio);
  resetAudioForTests();
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
    // No AudioContext stubbed, so the synth path reports "no sound
    // started" — which doubles as proof we fell through to it.
    expect(playAttentionChime()).toBe(false);
    expect(FakeAudio.instances).toHaveLength(0);
  });

  it("falls back to the synth chime when mp3 playback rejects", async () => {
    const { FakeContext, oscillatorStarts } = fakeAudioContext();
    vi.stubGlobal("AudioContext", FakeContext);
    setNaviModeEnabled(true);

    let reject: (e: Error) => void = () => undefined;
    const rejection = new Promise<void>((_, r) => {
      reject = r;
    });
    // Returns true: playback was INITIATED. The contract stops there — the
    // rejection lands later, and the fallback below is what covers it.
    expect(playAttentionChime()).toBe(true);
    expect(FakeAudio.instances[0].play).toHaveBeenCalledTimes(1);
    FakeAudio.instances[0].play.mockReturnValueOnce(rejection);

    expect(oscillatorStarts).not.toHaveBeenCalled();
    playAttentionChime();
    reject(new Error("NotAllowedError: autoplay blocked"));
    await vi.waitFor(() => expect(oscillatorStarts).toHaveBeenCalledTimes(2));
  });
});
