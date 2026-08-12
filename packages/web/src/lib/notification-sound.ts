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
 * Browsers block audio until the page has seen a real user gesture. Rather
 * than fail silently at the moment we most need to be heard, `unlock()`
 * resumes the context on the first interaction and `isBlocked()` reports
 * when we still cannot make a sound, so the UI can fall back to the title
 * badge instead of pretending it pinged.
 */

/** Rising perfect fifth. Low enough not to pierce, high enough to carry. */
const TONES_HZ = [587.33, 880.0];
const TONE_SECONDS = 0.14;
const TONE_GAP_SECONDS = 0.1;
const PEAK_GAIN = 0.12;

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

/** True when the browser will not let us make a sound yet. The caller
 * should still show a visible signal in that case. */
export function isBlocked(): boolean {
  const c = context();
  return c === null || c.state !== "running";
}

/**
 * Play the chime. Never throws and never rejects — this runs inside
 * notification handling, where an audio failure must not take the UI with
 * it. Returns whether a sound was actually started.
 */
export function playAttentionChime(): boolean {
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

/** Test seam: drops the cached context so a suite can start clean. */
export function resetAudioContextForTests(): void {
  ctx = null;
}
