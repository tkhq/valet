import { useEffect, useState } from "react";

const PHONE = "(max-width: 639px)";

/** True below the `sm` breakpoint, where the editor stacks its panes. */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(PHONE);
    const sync = () => setPhone(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return phone;
}
