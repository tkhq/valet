import { useEffect, useLayoutEffect, type RefObject } from "react";

/** Measure content after draft changes and width changes, including sidebar toggles. */
export function useAutosizeTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [ref, value]);

  useEffect(() => {
    const textarea = ref.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    let width = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      // Setting height also notifies the observer. Only width changes require another measurement.
      if (textarea.clientWidth === width) return;
      width = textarea.clientWidth;
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [ref]);
}
