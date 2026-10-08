import { cardStorageKey } from "~/lib/card-context";
import { useEffect, useRef, useState } from "react";
import { Columns2, Grid2X2, Maximize2, Plus, X, ArrowUpRight, ChevronLeft, ChevronRight, Layers3, ArrowLeft } from "lucide-react";
import { ConfirmDialog } from "~/components/primitives/confirm-dialog";
import { DECK_KEY, MAX_CARDS, internalPage, newCard, restoreDeck, type DeckMode, type PageCard } from "./deck-state";
import "./page-deck.css";

function loadDeck() {
  try { return restoreDeck(sessionStorage.getItem(DECK_KEY)); } catch { return restoreDeck(null); }
}

function LivePage({ card, interactive, register }: { card: PageCard; interactive: boolean; register: (id: string, frame: HTMLIFrameElement | null) => void }) {
  // Navigation updates the saved URL, never the mounted frame's src.
  const [initialUrl] = useState(card.url);
  return <iframe ref={(frame) => register(card.id, frame)} name={`valet-card:${card.id}`} src={initialUrl}
    title={card.title} inert={!interactive} className="deck-frame" allow="clipboard-write; microphone" />;
}

export function PageDeck({ onClose, visible = true }: { onClose?: () => void; visible?: boolean }) {
  const [deck, setDeck] = useState(loadDeck);
  const [closing, setClosing] = useState<string>();
  const [notice, setNotice] = useState("");
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const activeIndex = Math.max(0, deck.cards.findIndex((c) => c.id === deck.active));
  const active = deck.cards[activeIndex]!;
  const setCompareStart = (compareStart: number) => setDeck((prev) => ({ ...prev, compareStart }));
  const pairStart = Math.min(deck.compareStart, Math.max(0, deck.cards.length - 2));

  useEffect(() => {
    try { sessionStorage.setItem(DECK_KEY, JSON.stringify(deck)); } catch { setNotice("Browser storage is full. Keep this window open to retain your cards."); }
    if (visible) document.title = `${active.title.replace(/ · Valet$/, "")} · Deck`;
  }, [deck, active.title, visible]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.origin !== location.origin) return;
      const id = [...frames.current].find(([, frame]) => frame.contentWindow === event.source)?.[0];
      const data: unknown = event.data;
      if (!id || typeof data !== "object" || data === null || !("type" in data)) return;
      if (data.type === "valet:focus") { setDeck((prev) => prev.active === id ? prev : { ...prev, active: id }); return; }
      if (data.type !== "valet:page" || !("url" in data) || !("title" in data)) return;
      const url = internalPage(data.url);
      const title = typeof data.title === "string" ? data.title.slice(0, 200) : "Valet page";
      if (!url) return;
      setDeck((prev) => ({ ...prev, cards: prev.cards.map((c) => c.id === id ? { ...c, url, title } : c) }));
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  function focus(id: string) {
    const index = deck.cards.findIndex((c) => c.id === id);
    if (index < pairStart || index > pairStart + 1) setCompareStart(Math.min(index, Math.max(0, deck.cards.length - 2)));
    setDeck((prev) => ({ ...prev, active: id, mode: prev.mode === "overview" ? "focus" : prev.mode })); }
  function add() {
    if (deck.cards.length >= MAX_CARDS) return;
    let workspace = new URL(active.url, location.origin).searchParams.get("workspace") ?? "user";
    try { workspace = sessionStorage.getItem(cardStorageKey("valet:workspace", active.id)) ?? workspace; } catch { /* Keep the explicit page scope. */ }
    const card = newCard(`/chat?workspace=${encodeURIComponent(workspace)}`);
    setDeck((prev) => ({ ...prev, cards: [...prev.cards, card], active: card.id, mode: "focus" }));
  }
  function close() {
    setDeck((prev) => {
      const cards = prev.cards.filter((c) => c.id !== closing);
      if (!cards.length) cards.push(newCard());
      return { ...prev, cards, active: prev.active === closing ? cards[Math.min(activeIndex, cards.length - 1)]!.id : prev.active };
    });
    setClosing(undefined);
  }
  const modes: { value: DeckMode; label: string; icon: typeof Maximize2 }[] = [
    { value: "focus", label: "Focus", icon: Maximize2 }, { value: "compare", label: "Compare", icon: Columns2 }, { value: "overview", label: "Overview", icon: Grid2X2 },
  ];
  return <div className="page-deck" data-mode={deck.mode} data-count={deck.cards.length}>
    <header className="deck-toolbar">
      <div className="deck-brand">{onClose && <button onClick={onClose} aria-label="Back to page" title="Back to page"><ArrowLeft size={18} /></button>}<Layers3 size={22} /><span>Valet <small>your desk</small></span></div>
      <div className="deck-modes" aria-label="Card layout">{modes.map(({ value, label, icon: Icon }) => <button key={value} aria-label={label} aria-pressed={deck.mode === value} onClick={() => { if (value === "compare") setCompareStart(Math.min(activeIndex, Math.max(0, deck.cards.length - 2))); setDeck((prev) => ({ ...prev, mode: value })); }}><Icon size={16} /><span>{label}</span></button>)}</div>
      <button className="deck-add" onClick={add} disabled={deck.cards.length >= MAX_CARDS}><Plus size={17} /> New card</button>
    </header>
    <div className="deck-caption"><span>{deck.mode === "overview" ? "Everything in view" : deck.mode === "compare" ? "A little room to think together" : "One thing in focus. Everything else, close by."}</span><span>{deck.cards.length} / {MAX_CARDS} cards · saved in this tab</span></div>
    {notice && <p role="status">{notice}</p>}
    <main className="deck-stage" aria-label="Open Valet pages">
      {deck.cards.map((card, index) => {
        const selected = card.id === deck.active;
        const slot = deck.mode === "overview" ? `overview-${index}` : deck.mode === "compare" && deck.cards.length > 1 ? index === pairStart ? "left" : index === pairStart + 1 ? "right" : "parked" : selected ? "center" : index < activeIndex ? "before" : "after";
        return <section key={card.id} className="deck-card" data-slot={slot} data-active={selected} aria-label={card.title}
          inert={slot === "parked" || slot === "before" && index !== activeIndex - 1 || slot === "after" && index !== activeIndex + 1}>
          <div className="deck-card-bar">
            <button className="deck-card-name" onClick={() => focus(card.id)}><span className="deck-dot" />{card.title.replace(/ · Valet$/, "")}</button>
            <a href={card.url} target="_blank" rel="noreferrer" aria-label={`Open ${card.title} in a browser tab`}><ArrowUpRight size={15} /></a>
            <button onClick={() => setClosing(card.id)} aria-label={`Close ${card.title}`}><X size={15} /></button>
          </div>
          <div className="deck-page">
            <LivePage card={card} interactive={visible && deck.mode !== "overview" && (selected || slot === "left" || slot === "right")} register={(id, frame) => { if (frame) frames.current.set(id, frame); else frames.current.delete(id); }} />
            {(deck.mode === "overview" || !selected && deck.mode !== "compare") && <button className="deck-card-cover" aria-label={`Focus ${card.title}`} onClick={() => focus(card.id)} />}
          </div>
        </section>;
      })}
    </main>
    <footer className="deck-dock" aria-label="Switch cards">
      <button aria-label="Previous card" disabled={activeIndex === 0} onClick={() => focus(deck.cards[activeIndex - 1]!.id)}><ChevronLeft size={17} /></button>
      <div className="deck-tabs">{deck.cards.map((card, index) => <button key={card.id} aria-pressed={card.id === deck.active} onClick={() => focus(card.id)} title={card.title}><span>{index + 1}</span>{card.title.replace(/ · Valet$/, "")}</button>)}</div>
      <button aria-label="Next card" disabled={activeIndex === deck.cards.length - 1} onClick={() => focus(deck.cards[activeIndex + 1]!.id)}><ChevronRight size={17} /></button>
    </footer>
    <ConfirmDialog open={closing !== undefined} onOpenChange={(open) => { if (!open) setClosing(undefined); }} title="Close this card?"
      description="This closes the page. Its chats and workflows remain available. Unsent drafts, attachments, and open forms in this card will be lost."
      confirmLabel="Close card" onConfirm={close} />
  </div>;
}
