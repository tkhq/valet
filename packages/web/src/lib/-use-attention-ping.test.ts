/**
 * The decision of WHEN to make a sound is the whole design here, so it
 * lives in pure functions and is tested directly. The rules being pinned:
 * only blocked-on-a-person kinds ping, an already-read item never does, and
 * a gate on the page you are looking at stays silent.
 */
import { describe, expect, it } from "vitest";
import type { NotificationKind, NotificationSummary } from "@valet/api/wire";
import {
  hrefMatchesLocation,
  isActionable,
  shouldPing,
  titleWithCount,
  type PingContext,
} from "./use-attention-ping";

function notif(kind: NotificationKind, over: Partial<NotificationSummary> = {}): NotificationSummary {
  return {
    id: "n1",
    kind,
    urgency: "high",
    title: "Approve the deploy",
    createdAt: 1,
    ...over,
  };
}

const VISIBLE: PingContext = { pathname: "/sessions/abc", search: "", tabVisible: true };
const HIDDEN: PingContext = { pathname: "/sessions/abc", search: "", tabVisible: false };

describe("isActionable", () => {
  it("counts the kinds that block on a person", () => {
    expect(isActionable(notif("approval"))).toBe(true);
    expect(isActionable(notif("question"))).toBe(true);
    expect(isActionable(notif("escalation"))).toBe(true);
  });

  it("excludes a general update — it goes to the bell, not the speaker", () => {
    expect(isActionable(notif("notification"))).toBe(false);
  });

  it("excludes anything already read", () => {
    expect(isActionable(notif("approval", { readAt: 5 }))).toBe(false);
  });
});

describe("shouldPing", () => {
  it("stays silent for a general update", () => {
    expect(shouldPing(notif("notification"), HIDDEN)).toBe(false);
  });

  it("pings when the tab is hidden, wherever the gate points", () => {
    expect(shouldPing(notif("approval", { href: "/sessions/abc" }), HIDDEN)).toBe(true);
  });

  it("stays silent when you are already looking at the page it points to", () => {
    // The decision card is on screen. A sound adds nothing you cannot see.
    expect(shouldPing(notif("approval", { href: "/sessions/abc" }), VISIBLE)).toBe(false);
  });

  it("pings when you are visible but somewhere else in the app", () => {
    expect(shouldPing(notif("approval", { href: "/sessions/other" }), VISIBLE)).toBe(true);
  });

  it("pings when the notification has no link to compare", () => {
    expect(shouldPing(notif("escalation"), VISIBLE)).toBe(true);
  });
});

describe("hrefMatchesLocation", () => {
  it("ignores a thread parameter, which names a place inside a conversation you can see", () => {
    expect(hrefMatchesLocation("/chat?thread=t1", "/chat", "")).toBe(true);
    expect(hrefMatchesLocation("/chat", "/chat", "")).toBe(true);
  });

  it("does not match a different path", () => {
    expect(hrefMatchesLocation("/sessions/a", "/sessions/b", "")).toBe(false);
  });

  /**
   * Every assistant conversation lives at `/chat`, so the path alone cannot
   * say which one is open. Comparing paths only made a gate raised by any
   * OTHER assistant silent while the reader sat on `/chat` — the case this
   * whole feature exists to catch.
   */
  it("does not match another assistant's conversation at the same path", () => {
    expect(hrefMatchesLocation("/chat?assistant=b", "/chat", "?assistant=a")).toBe(false);
  });

  it("matches the assistant actually open", () => {
    expect(hrefMatchesLocation("/chat?assistant=a", "/chat", "?assistant=a")).toBe(true);
    // The leading `?` is optional — routers report it both ways.
    expect(hrefMatchesLocation("/chat?assistant=a", "/chat", "assistant=a")).toBe(true);
  });

  it("does not match when no assistant is open at all", () => {
    expect(hrefMatchesLocation("/chat?assistant=b", "/chat", "")).toBe(false);
  });

  it("ignores a thread difference once the assistant agrees", () => {
    expect(hrefMatchesLocation("/chat?assistant=a&thread=t9", "/chat", "?assistant=a")).toBe(true);
  });
});

describe("shouldPing — several assistants share /chat", () => {
  const onA: PingContext = { pathname: "/chat", search: "?assistant=a", tabVisible: true };

  it("pings for a gate raised by an assistant you are NOT looking at", () => {
    expect(shouldPing(notif("approval", { href: "/chat?assistant=b" }), onA)).toBe(true);
  });

  it("stays quiet for the conversation already on screen", () => {
    expect(shouldPing(notif("approval", { href: "/chat?assistant=a" }), onA)).toBe(false);
  });
});

describe("titleWithCount", () => {
  it("prefixes a count when something waits", () => {
    expect(titleWithCount("Valet", 2)).toBe("(2) Valet");
  });

  it("restores the bare title at zero rather than showing (0)", () => {
    expect(titleWithCount("Valet", 0)).toBe("Valet");
  });
});
