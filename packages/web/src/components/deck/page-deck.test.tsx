// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeckAccess } from "./deck-access";
import { PageDeck } from "./page-deck";
import { DECK_KEY, internalPage, restoreDeck } from "./deck-state";
import { cardStorageKey, cardId } from "~/lib/card-context";

vi.mock("~/components/primitives/confirm-dialog", () => ({ ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open ? <button onClick={onConfirm}>Confirm close</button> : null }));
afterEach(() => { cleanup(); sessionStorage.clear(); });

describe("persistent page cards", () => {
  it("opens Tabs over the default page and preserves both views when returning", () => {
    const { container } = render(<DeckAccess><textarea aria-label="Normal page draft" defaultValue="keep this draft" /></DeckAccess>);
    const draft = screen.getByRole("textbox");
    draft.focus();
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent(window, new Event("valet:open-deck"));
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to page" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to page" }));
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(document.activeElement).toBe(draft);
    expect(frame?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("iframe")).toBe(frame);
    fireEvent(window, new Event("valet:open-deck"));
    expect(container.querySelector("iframe")).toBe(frame);
  });
  it("isolates workspace and same-thread drafts while retaining normal tab keys", () => {
    expect(cardId("valet-card:one", true)).toBe("one");
    expect(cardId("valet-card:one", false)).toBeUndefined();
    expect(cardId("untrusted-name", true)).toBeUndefined();
    expect(cardStorageKey("valet:workspace", "one")).not.toBe(cardStorageKey("valet:workspace", "two"));
    expect(cardStorageKey("valet:composer-draft:", "one")).not.toBe(cardStorageKey("valet:composer-draft:", "two"));
    expect(cardStorageKey("valet:workspace")).toBe("valet:workspace");
  });
  it("rejects external or recursive pages and repairs corrupt saved state", () => {
    for (const url of ["https://evil.test", "//evil.test", "/\\evil.test", "/deck", "/deck/nested", "javascript:alert(1)"]) expect(internalPage(url)).toBeUndefined();
    expect(internalPage("/chat?workspace=team-a")).toBe("/chat?workspace=team-a");
    expect(restoreDeck("invalid").cards).toHaveLength(1);
    const restored = restoreDeck(JSON.stringify({ active: "missing", mode: "compare", cards: [{ id: "a", url: "/events", title: "Events" }, { id: "a", url: "/chat" }, { id: "b", url: "//evil.test" }] }));
    expect(restored.cards).toEqual([{ id: "a", url: "/events", title: "Events" }]);
    expect(restored.active).toBe("a");
  });
  it("restores the comparison pair even when its right card has focus", () => {
    sessionStorage.setItem(DECK_KEY, JSON.stringify({ cards: ["one", "two", "three"].map((id) => ({ id, url: "/events", title: id })), active: "two", mode: "compare", compareStart: 0 }));
    const { container } = render(<PageDeck />);
    expect(container.querySelector('[data-slot="left"] iframe')?.getAttribute("name")).toBe("valet-card:one");
    expect(container.querySelector('[data-slot="right"] iframe')?.getAttribute("name")).toBe("valet-card:two");
  });
  it("keeps the same browsing contexts through focus, overview, comparison, and trusted navigation updates", () => {
    sessionStorage.setItem(DECK_KEY, JSON.stringify({ cards: [{ id: "one", url: "/chat?workspace=team-a", title: "First" }, { id: "two", url: "/events?workspace=team-b", title: "Second" }], active: "one", mode: "focus" }));
    const { container } = render(<PageDeck />);
    const frames = [...container.querySelectorAll("iframe")];
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus Second" }));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    expect([...container.querySelectorAll("iframe")]).toEqual(frames);
    fireEvent(window, new MessageEvent("message", { origin: location.origin, source: frames[0]!.contentWindow, data: { type: "valet:page", title: "Workflow", url: "/workflows?workspace=team-a" } }));
    expect(frames[0]!.getAttribute("src")).toBe("/chat?workspace=team-a");
    expect(restoreDeck(sessionStorage.getItem(DECK_KEY)).cards[0]!.url).toBe("/workflows?workspace=team-a");
    fireEvent(window, new MessageEvent("message", { origin: "https://evil.test", source: frames[0]!.contentWindow, data: { type: "valet:page", title: "Spoof", url: "/events" } }));
    expect(restoreDeck(sessionStorage.getItem(DECK_KEY)).cards[0]!.title).toBe("Workflow");
    fireEvent.click(screen.getByRole("button", { name: "Close Second" }));
    expect(container.querySelectorAll("iframe")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Confirm close" }));
    expect(container.querySelector("iframe")).toBe(frames[0]);
  });
});
