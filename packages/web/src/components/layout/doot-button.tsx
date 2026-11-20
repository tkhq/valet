import { useEffect } from "react";
import { cn } from "~/lib/cn";

const DOOT_SECONDS = 0.3;

let audioContext: AudioContext | null = null;

/** Creates the AudioContext on first use, which is always inside a user gesture. */
function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  if (typeof AudioContext === "undefined") return null;
  audioContext = new AudioContext();
  return audioContext;
}

/** Plays a short synthesized trumpet-like note. */
export function playDoot(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  const start = ctx.currentTime;
  const end = start + DOOT_SECONDS;

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(220, start);
  osc.frequency.exponentialRampToValueAtTime(233, start + 0.05);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.25, start + 0.03);
  gain.gain.setValueAtTime(0.25, end - 0.1);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(end);
}

/** True when a "0" key press should play the doot. */
export function shouldDoot(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if (e.key !== "0" || e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return false;
  return !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function DootButton({ className }: { className?: string }) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (shouldDoot(e)) playDoot();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <button
      type="button"
      aria-label="Doot"
      title="Doot (press 0)"
      onClick={playDoot}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted hover:bg-ink-wash hover:text-ink",
        className,
      )}
    >
      <span aria-hidden>🎺</span>
    </button>
  );
}
