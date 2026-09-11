import { useEffect, useState } from "react";

/** Release a mobile overlay's focus and scroll lock when its desktop layout takes over. */
export function useResponsiveOverlay(breakpoint: "sm" | "md") {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(`(min-width: ${breakpoint === "sm" ? 640 : 768}px)`);
    const closeOnDesktop = () => {
      if (media.matches) setOpen(false);
    };
    closeOnDesktop();
    media.addEventListener("change", closeOnDesktop);
    return () => media.removeEventListener("change", closeOnDesktop);
  }, [breakpoint]);
  return { open, setOpen };
}
