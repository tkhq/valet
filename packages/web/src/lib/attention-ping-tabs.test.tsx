// @vitest-environment jsdom
/**
 * Tabs cards are separate pages in one browser tab. Each one polls
 * notifications, so the top page must be the only one that plays the chime,
 * and it must count the cards on screen as the pages a person is looking at.
 */
import type { NotificationSummary } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  card: undefined as string | undefined,
  notifications: [] as NotificationSummary[],
  chime: vi.fn(() => true),
}));

vi.mock("~/api/queries", () => ({ useNotifications: () => ({ data: { notifications: h.notifications } }) }));
vi.mock("./notification-sound", () => ({ playAttentionChime: h.chime, unlock: () => {} }));
vi.mock("./card-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./card-context")>();
  return { ...actual, cardId: () => h.card };
});
vi.mock("~/components/primitives/confirm-dialog", () => ({ ConfirmDialog: () => null }));

import { PageActiveContext } from "./page-active";
import { useAttentionPing } from "./use-attention-ping";
import { PageDeck } from "~/components/deck/page-deck";
import { DECK_KEY } from "~/components/deck/deck-state";

const TARGET = "/chat?workspace=team-a&thread=t1";

function approval(id: string): NotificationSummary {
  return { id, kind: "approval", urgency: "high", title: "Approve the deploy", createdAt: 1, href: TARGET };
}

/** Mount the hook, then deliver one new approval on the next poll. */
function deliver(pageActive: boolean) {
  h.notifications = [];
  const wrapper = ({ children }: { children: ReactNode }) => <PageActiveContext.Provider value={pageActive}>{children}</PageActiveContext.Provider>;
  const view = renderHook(() => useAttentionPing(), { wrapper });
  h.notifications = [approval("n1")];
  view.rerender();
  return view;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.card = undefined;
  h.chime.mockClear();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
});

describe("attention chime with Tabs", () => {
  it("never plays in a card, because the top page plays it for the whole browser tab", () => {
    h.card = "one";
    deliver(true);
    expect(h.chime).not.toHaveBeenCalled();
  });

  it("plays when Tabs covers a normal page that shows the target", () => {
    history.replaceState(null, "", TARGET);
    deliver(false);
    expect(h.chime).toHaveBeenCalledOnce();
  });

  // The notification list is per person, not per workspace. So the poll of a
  // personal top page also holds the notifications of a card in a team.
  it("plays once for a team card's notification while the top page is personal", () => {
    history.replaceState(null, "", "/chat?workspace=user");
    sessionStorage.setItem(DECK_KEY, JSON.stringify({ cards: [{ id: "one", url: "/chat?workspace=team-a&thread=t9", title: "Chat" }], active: "one", mode: "focus" }));
    render(<PageDeck />);
    const view = deliver(false);
    expect(h.chime).toHaveBeenCalledOnce();
    // A later poll that still lists the same id does not play it again.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    h.notifications = [approval("n1")];
    view.rerender();
    expect(h.chime).toHaveBeenCalledOnce();
  });

  it("stays quiet when the focused card shows the target", () => {
    sessionStorage.setItem(DECK_KEY, JSON.stringify({ cards: [{ id: "one", url: TARGET, title: "Chat" }], active: "one", mode: "focus" }));
    render(<PageDeck />);
    deliver(false);
    expect(h.chime).not.toHaveBeenCalled();
  });
});
