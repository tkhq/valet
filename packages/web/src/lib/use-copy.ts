import { useEffect, useRef, useState } from "react";

/**
 * Copy-to-clipboard with a "copied" flash that resets after `resetMs`.
 * Guards against clipboard failure (permissions, non-secure/http context —
 * `navigator.clipboard` is undefined there) and dedupes/clears the reset
 * timer so rapid clicks or an unmount can't leave a stray state update.
 */
export function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), resetMs);
      return true;
    } catch {
      // Clipboard unavailable (permissions denied, or a non-secure/http
      // origin where the API doesn't exist) — nothing to recover into.
      return false;
    }
  }

  return { copied, copy };
}
