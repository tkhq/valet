import { useEffect, useRef, useState } from "react";

/** Last-resort copy for browsers that deny/lack the async Clipboard API: a
 * hidden, off-screen textarea plus the legacy synchronous `execCommand`. */
function copyViaHiddenTextarea(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.style.position = "fixed";
  el.style.opacity = "0";
  document.body.appendChild(el);
  el.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(el);
  }
}

/**
 * Copy-to-clipboard with a "copied" flash that resets after `resetMs`.
 * Tries the async Clipboard API first, then the hidden-textarea fallback
 * for browsers that deny or lack it (some non-secure/http origins, some
 * permission policies). Dedupes/clears the reset timer so rapid clicks or
 * an unmount can't leave a stray state update.
 */
export function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function flash() {
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), resetMs);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      flash();
      return true;
    } catch {
      if (copyViaHiddenTextarea(text)) {
        flash();
        return true;
      }
      return false;
    }
  }

  return { copied, copy };
}
