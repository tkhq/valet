import { createContext, useContext, useEffect, useState } from "react";

/** Hidden mounted pages retain state but must not handle global shortcuts. */
export const PageActiveContext = createContext(true);
export function usePageActive() {
  const pageActive = useContext(PageActiveContext);
  const [frameActive, setFrameActive] = useState(() => !window.frameElement?.closest("[inert]"));
  useEffect(() => {
    const frame = window.frameElement;
    if (!frame) return;
    const update = () => setFrameActive(!frame.closest("[inert]"));
    const observer = new MutationObserver(update);
    // The deck owns frame and overlay activity in the parent document.
    observer.observe(frame.ownerDocument.body, { attributes: true, subtree: true, attributeFilter: ["inert"] });
    update();
    return () => observer.disconnect();
  }, []);
  return pageActive && frameActive;
}
