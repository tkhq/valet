/**
 * The sound the assistant makes when it needs you.
 *
 * Synthesised with Web Audio rather than shipped as an audio file: no
 * binary in the repo, no request at the moment it matters, and the tone is
 * tunable in code. It is two short sine tones rising a fifth, at low gain,
 * with a smooth envelope — a rising pair reads as a question, which is what
 * a blocked agent is asking. This product's whole visual language is calm;
 * an alert buzzer would contradict it and get muted on the first day, which
 * would cost more than the sound is worth.
 *
 * Browsers block audio until the page has seen a real user gesture, so
 * `unlock()` resumes the context on the first interaction. A context that
 * stays blocked costs the user nothing: the tab title in
 * `use-attention-ping.ts` carries the count on every poll, so a ping that
 * makes no sound still leaves a visible signal.
 */

/** Rising perfect fifth. Low enough not to pierce, high enough to carry. */
const TONES_HZ = [587.33, 880.0];
const TONE_SECONDS = 0.14;
const TONE_GAP_SECONDS = 0.1;
const PEAK_GAIN = 0.12;

/**
 * Easter egg. When set, the attention sound is Navi from Ocarina of Time
 * instead of the synth chime. Device-local for the same reason the sound
 * toggle is: what a machine sounds like belongs to the machine.
 */
const NAVI_PREF_KEY = "valet:attention-sound-navi";
const NAVI_SOUND_URL = "/sounds/hey-listen.mp3";
/** Tempered. The clip is louder than the chime and it plays uninvited. */
const NAVI_VOLUME = 0.5;

export function isNaviModeEnabled(): boolean {
  try {
    return window.localStorage.getItem(NAVI_PREF_KEY) === "on";
  } catch {
    return false;
  }
}

export function setNaviModeEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(NAVI_PREF_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable: the choice is in-session only rather than an
    // error. Same policy as the sound toggle.
  }
}

let naviAudio: HTMLAudioElement | null = null;

function naviElement(): HTMLAudioElement | null {
  if (naviAudio) return naviAudio;
  if (typeof Audio === "undefined") return null;
  try {
    naviAudio = new Audio(NAVI_SOUND_URL);
    naviAudio.volume = NAVI_VOLUME;
    naviAudio.preload = "auto";
  } catch {
    return null;
  }
  return naviAudio;
}

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  // Safari still only exposes the prefixed constructor on some versions.
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    // A browser that refuses to construct one (rare, but jsdom does) gets
    // silence rather than a thrown error inside a notification handler.
    return null;
  }
  return ctx;
}

/**
 * Resume the audio context. Call from a real user gesture — a click or a
 * keypress. Safe to call repeatedly.
 */
export function unlock(): void {
  const c = context();
  if (c && c.state === "suspended") void c.resume().catch(() => undefined);
}

/**
 * Play the chime. Never throws and never rejects — this runs inside
 * notification handling, where an audio failure must not take the UI with
 * it. Returns whether a sound was actually started.
 */
export function playAttentionChime(): boolean {
  if (isNaviModeEnabled() && playNaviSound()) return true;
  return playSynthChime();
}

/**
 * The egg. Returns whether playback was started; an async rejection (file
 * missing, autoplay blocked) falls back to the synth chime so the ping is
 * never silently lost to the joke.
 */
function playNaviSound(): boolean {
  const el = naviElement();
  if (!el) return false;
  try {
    el.currentTime = 0;
    // Older engines (and jsdom) return void from play(), not a promise.
    const playing = el.play() as Promise<void> | undefined;
    if (playing) {
      void playing.catch(() => {
        playSynthChime();
      });
    }
    return true;
  } catch {
    return false;
  }
}

function playSynthChime(): boolean {
  const c = context();
  if (!c) return false;
  if (c.state === "suspended") {
    void c.resume().catch(() => undefined);
  }
  if (c.state !== "running") return false;

  try {
    const startedAt = c.currentTime;
    TONES_HZ.forEach((hz, i) => {
      const at = startedAt + i * TONE_GAP_SECONDS;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;

      // Ramped, not switched. A square-edged gain change clicks, and a
      // click is exactly the harsh artefact this tone is trying to avoid.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + TONE_SECONDS);

      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(at);
      osc.stop(at + TONE_SECONDS + 0.02);
    });
    return true;
  } catch {
    return false;
  }
}
