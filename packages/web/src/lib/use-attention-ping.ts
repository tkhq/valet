import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import type { NotificationKind, NotificationSummary } from "@valet/api/wire";
import { useNotifications } from "~/api/queries";
import { isBlocked, playAttentionChime } from "./notification-sound";

/**
 * Tells you when the assistant is waiting on you, out loud.
 *
 * A background agent that blocks on a person and cannot reach them is this
 * product's core failure mode — the work simply stops, and the only way to
 * find out is to go looking. The notifications bell already collects these,
 * but a badge you have to be looking at does not help someone who tabbed
 * away, which is the entire point of a background agent.
 *
 * What it deliberately does NOT do is ping for everything. Only the kinds
 * that block on a person get a sound; a general update does not earn one.
 * A sound that fires when nothing is needed is a sound people turn off, and
 * then the one that mattered is silent too.
 */

/** Kinds where the agent is stopped until a person acts. `notification` is
 * an update — it goes to the bell and the title, never to the speaker. */
const NEEDS_ACTION: readonly NotificationKind[] = ["question", "escalation", "approval"];

/** One ping per burst. Three gates resolving at once is one interruption,
 * not three. */
const PING_COOLDOWN_MS = 4_000;

const SOUND_PREF_KEY = "valet:attention-sound";

export function isAttentionSoundEnabled(): boolean {
  try {
    // Default ON. This product exists to work while you look away, so the
    // signal that it needs you should not be opt-in.
    return window.localStorage.getItem(SOUND_PREF_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAttentionSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUND_PREF_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable (private mode, blocked cookies): the preference
    // is in-session only rather than an error.
  }
}

export function isActionable(n: NotificationSummary): boolean {
  return n.readAt === undefined && NEEDS_ACTION.includes(n.kind);
}

export interface PingContext {
  /** Where the user is right now, e.g. `/chat` or `/sessions/abc`. */
  pathname: string;
  /** `document.visibilityState === "visible"`. */
  tabVisible: boolean;
}

/**
 * Pure: should THIS notification make a sound?
 *
 * The judgement call is the last clause. If you are looking at the very
 * page the notification points to, the decision card is already on screen
 * and a sound tells you nothing you cannot see — so we stay quiet. Tab
 * hidden, or anywhere else in the app, and it plays.
 */
export function shouldPing(n: NotificationSummary, ctx: PingContext): boolean {
  if (!isActionable(n)) return false;
  if (!ctx.tabVisible) return true;
  if (n.href === undefined) return true;
  return !hrefMatchesLocation(n.href, ctx.pathname);
}

/** `href` is a full path with an optional query; the comparison is on the
 * path alone, so a gate on the session you are reading stays silent even if
 * the link carries a thread parameter you do not currently have. */
export function hrefMatchesLocation(href: string, pathname: string): boolean {
  const path = href.split("?")[0] ?? href;
  return path === pathname;
}

/** The document title, with the count of things waiting on you. Restores
 * the bare title at zero rather than leaving a stale `(0)`. */
export function titleWithCount(base: string, count: number): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

const BASE_TITLE = "Valet";

export function useAttentionPing(): void {
  const notificationsQ = useNotifications();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Ids we have already considered. Seeded from the FIRST response without
  // pinging: everything unread at load is backlog, and announcing it would
  // make every page refresh sound like a fresh emergency.
  const seen = useRef<Set<string> | null>(null);
  const lastPingAt = useRef(0);

  const notifications = notificationsQ.data?.notifications;

  useEffect(() => {
    if (!notifications) return;

    if (seen.current === null) {
      seen.current = new Set(notifications.map((n) => n.id));
      return;
    }

    const fresh = notifications.filter((n) => !seen.current?.has(n.id));
    for (const n of notifications) seen.current.add(n.id);
    if (fresh.length === 0) return;

    const ctx: PingContext = {
      pathname,
      tabVisible: typeof document !== "undefined" && document.visibilityState === "visible",
    };
    if (!fresh.some((n) => shouldPing(n, ctx))) return;
    if (!isAttentionSoundEnabled()) return;

    const now = Date.now();
    if (now - lastPingAt.current < PING_COOLDOWN_MS) return;
    lastPingAt.current = now;
    playAttentionChime();
  }, [notifications, pathname]);

  // The title is the fallback that always works: muted tab, blocked
  // autoplay, headphones out. It costs nothing and it is the only signal
  // visible from another application's window.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const count = (notifications ?? []).filter(isActionable).length;
    document.title = titleWithCount(BASE_TITLE, count);
    return () => {
      document.title = BASE_TITLE;
    };
  }, [notifications]);
}

/** True when we owe the user a visible signal because we cannot make an
 * audible one. */
export function soundUnavailable(): boolean {
  return isAttentionSoundEnabled() && isBlocked();
}
