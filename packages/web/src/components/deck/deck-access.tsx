import { useEffect, useRef, useState, type ReactNode } from "react";
import { PageActiveContext } from "~/lib/page-active";
import { PageDeck } from "./page-deck";

/** The normal page and the deck both stay mounted when the user switches. */
export function DeckAccess({ children }: { children: ReactNode }) {
  const standalone = window.location.pathname === "/deck" && window.parent === window;
  const [created, setCreated] = useState(standalone);
  const [open, setOpen] = useState(standalone);
  const previousFocus = useRef<HTMLElement | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const pageTitle = useRef(document.title);
  useEffect(() => {
    const show = () => { if (!open) { pageTitle.current = document.title; previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; } setCreated(true); setOpen(true); };
    window.addEventListener("valet:open-deck", show);
    return () => window.removeEventListener("valet:open-deck", show);
  }, [open]);
  useEffect(() => {
    if (open) overlay.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else previousFocus.current?.focus();
  }, [open]);
  if (standalone) return <PageDeck />;
  return <>
    <div className="h-full" inert={open} style={{ visibility: open ? "hidden" : undefined }}><PageActiveContext.Provider value={!open}>{children}</PageActiveContext.Provider></div>
    {created && <div ref={overlay} role="dialog" aria-modal={open || undefined} aria-label="Tabs" className="fixed inset-0 z-50" inert={!open} style={{ visibility: open ? undefined : "hidden", pointerEvents: open ? undefined : "none" }}>
      <PageDeck visible={open} onClose={() => { setOpen(false); document.title = pageTitle.current; }} />
    </div>}
  </>;
}
