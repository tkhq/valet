export interface PageCard { id: string; url: string; title: string }
export type DeckMode = "focus" | "compare" | "overview";
export interface DeckState { cards: PageCard[]; active: string; mode: DeckMode; compareStart: number }
export const DECK_KEY = "valet:page-deck:v1";
export const MAX_CARDS = 6;

export function internalPage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/.test(value)) return;
  const url = new URL(value, "https://valet.invalid");
  if (url.origin !== "https://valet.invalid" || /^\/deck(?:\/|$)/.test(url.pathname)) return;
  return url.pathname + url.search + url.hash;
}

export function newCard(url = "/chat?workspace=user", title = "New page"): PageCard {
  return { id: crypto.randomUUID(), url, title };
}

export function restoreDeck(raw: string | null): DeckState {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (typeof value === "object" && value !== null && "cards" in value && Array.isArray(value.cards)) {
      const cards: PageCard[] = [];
      for (const card of value.cards.slice(0, MAX_CARDS)) {
        if (typeof card !== "object" || card === null || typeof card.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(card.id) || cards.some((c) => c.id === card.id)) continue;
        const url = internalPage(card.url);
        if (url) cards.push({ id: card.id, url, title: typeof card.title === "string" ? card.title.slice(0, 200) : "Valet page" });
      }
      if (cards.length) return {
        cards,
        compareStart: "compareStart" in value && typeof value.compareStart === "number" && Number.isSafeInteger(value.compareStart) ? Math.max(0, Math.min(value.compareStart, cards.length - 2)) : 0,
        active: "active" in value && typeof value.active === "string" && cards.some((c) => c.id === value.active) ? value.active : cards[0]!.id,
        mode: "mode" in value && (value.mode === "overview" || value.mode === "compare") ? value.mode : "focus",
      };
    }
  } catch { /* Start a fresh deck if saved browser state is unavailable. */ }
  const card = newCard();
  return { cards: [card], active: card.id, mode: "focus", compareStart: 0 };
}
