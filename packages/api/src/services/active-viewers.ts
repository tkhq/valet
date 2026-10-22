/**
 * Who has each thread open in a web tab right now, and who is typing in it.
 * Each session WebSocket reports the threads its tab shows and the tab's
 * visibility, and repeats the report as a heartbeat; closing the socket
 * removes them at once, and a socket that goes silent drops out. Nothing is
 * stored.
 *
 * The API runs one replica (deploy/chart/valet/values.yaml), and this map is
 * per process like the WebSocket fan-out it rides on. Use a shared store
 * before adding replicas.
 */
import type { ActiveViewer } from "../wire/types.js";

/** A tab in the background still counts this long, so a quick switch away does not flicker. */
export const HIDDEN_GRACE_MS = 45_000;
/** A person counts as typing this long after their last typing signal. */
export const TYPING_WINDOW_MS = 5_000;
/** A connection that sent nothing this long (sleep, lost network) drops out. The
 * web client repeats its report every 20 seconds. */
export const SILENT_MS = 60_000;

interface Connection {
  id: string;
  sessionId: string;
  orgId: string;
  person: { userId: string; name: string; avatarUrl?: string };
  openedAt: number;
  lastSeen: number;
  threadIds: Set<string>;
  hiddenAt?: number;
  typing?: { threadId: string; until: number };
}

export type ViewersListener = (threadId: string, viewers: ActiveViewer[]) => void;

export interface ActiveViewersOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

const realTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};

const threadKey = (sessionId: string, threadId: string) => `${sessionId} ${threadId}`;

export class ActiveViewers {
  private readonly connections = new Map<string, Connection>();
  /** Connection ids by `sessionId threadId`, so a thread's list reads only its own connections. */
  private readonly byThread = new Map<string, Set<string>>();
  private readonly listeners = new Map<string, Set<ViewersListener>>();
  /** The list last sent per `sessionId threadId`, so a listener hears only changes. */
  private readonly sent = new Map<string, string>();
  private readonly timers = new Map<string, { cancel: () => void }>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ActiveViewersOptions["setTimer"]>;

  constructor(options: ActiveViewersOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? realTimer;
  }

  /** Listens for viewer changes on one session's threads. Returns the unsubscribe. */
  subscribe(sessionId: string, listener: ViewersListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) { set = new Set(); this.listeners.set(sessionId, set); }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  /**
   * Records which threads a connection shows and whether its tab is visible.
   * Returns the threads the connection did not show before.
   */
  view(connection: { id: string; sessionId: string; orgId: string; person: Connection["person"] }, threadIds: string[], visible: boolean): string[] {
    const now = this.now();
    const existing = this.connections.get(connection.id);
    const before = existing?.threadIds ?? new Set<string>();
    const next: Connection = existing ?? { ...connection, openedAt: now, lastSeen: now, threadIds: new Set() };
    next.threadIds = new Set(threadIds);
    next.lastSeen = now;
    if (visible) delete next.hiddenAt;
    else next.hiddenAt ??= now;
    if (next.typing && !next.threadIds.has(next.typing.threadId)) delete next.typing;
    this.connections.set(connection.id, next);
    for (const threadId of before) if (!next.threadIds.has(threadId)) this.unindex(next.sessionId, threadId, next.id);
    const added = [...next.threadIds].filter((threadId) => !before.has(threadId));
    for (const threadId of added) this.index(next.sessionId, threadId, next.id);
    this.schedule(next);
    this.publish(next.sessionId, new Set([...before, ...next.threadIds]));
    return added;
  }

  /** Marks a connection as typing in one of its threads, or stops it. */
  type(connectionId: string, threadId: string, active: boolean): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.threadIds.has(threadId)) return;
    connection.lastSeen = this.now();
    if (active) connection.typing = { threadId, until: this.now() + TYPING_WINDOW_MS };
    else if (connection.typing?.threadId === threadId) delete connection.typing;
    this.schedule(connection);
    this.publish(connection.sessionId, new Set([threadId]));
  }

  /** Removes a closed connection. */
  leave(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    for (const threadId of connection.threadIds) this.unindex(connection.sessionId, threadId, connectionId);
    this.timers.get(connectionId)?.cancel();
    this.timers.delete(connectionId);
    this.publish(connection.sessionId, connection.threadIds);
  }

  /** The people with the thread open, each once, in the order they arrived. */
  viewersOf(sessionId: string, threadId: string): ActiveViewer[] {
    const now = this.now();
    const people = new Map<string, ActiveViewer & { since: number }>();
    for (const id of this.byThread.get(threadKey(sessionId, threadId)) ?? []) {
      const connection = this.connections.get(id);
      if (!connection || !this.live(connection, now)) continue;
      const typing = connection.typing?.threadId === threadId && connection.typing.until > now;
      const known = people.get(connection.person.userId);
      if (known) {
        known.typing ||= typing;
        known.since = Math.min(known.since, connection.openedAt);
        continue;
      }
      people.set(connection.person.userId, { ...connection.person, typing, since: connection.openedAt });
    }
    return [...people.values()].sort((a, b) => a.since - b.since)
      .map(({ since: _since, ...viewer }) => viewer);
  }

  /** One organization's threads with at least one live viewer, by session. */
  activeThreads(orgId: string): Map<string, Set<string>> {
    const now = this.now();
    const bySession = new Map<string, Set<string>>();
    for (const connection of this.connections.values()) {
      if (connection.orgId !== orgId || !this.live(connection, now)) continue;
      let set = bySession.get(connection.sessionId);
      if (!set) { set = new Set(); bySession.set(connection.sessionId, set); }
      for (const threadId of connection.threadIds) set.add(threadId);
    }
    return bySession;
  }

  private live(connection: Connection, now: number): boolean {
    return now - connection.lastSeen < SILENT_MS
      && (connection.hiddenAt === undefined || now - connection.hiddenAt < HIDDEN_GRACE_MS);
  }

  private index(sessionId: string, threadId: string, connectionId: string): void {
    const key = threadKey(sessionId, threadId);
    let set = this.byThread.get(key);
    if (!set) { set = new Set(); this.byThread.set(key, set); }
    set.add(connectionId);
  }

  private unindex(sessionId: string, threadId: string, connectionId: string): void {
    const key = threadKey(sessionId, threadId);
    const set = this.byThread.get(key);
    set?.delete(connectionId);
    if (set?.size === 0) this.byThread.delete(key);
  }

  /** Republishes when a background tab's grace, a typing window, or the silence limit ends. */
  private schedule(connection: Connection): void {
    this.timers.get(connection.id)?.cancel();
    const now = this.now();
    const due = [
      connection.hiddenAt !== undefined ? connection.hiddenAt + HIDDEN_GRACE_MS : undefined,
      connection.typing ? connection.typing.until : undefined,
      connection.lastSeen + SILENT_MS,
    ].filter((at): at is number => at !== undefined && at > now);
    if (due.length === 0) { this.timers.delete(connection.id); return; }
    this.timers.set(connection.id, this.setTimer(() => {
      this.timers.delete(connection.id);
      if (connection.typing && connection.typing.until <= this.now()) delete connection.typing;
      if (this.connections.get(connection.id) !== connection) return;
      this.schedule(connection);
      this.publish(connection.sessionId, connection.threadIds);
    }, Math.min(...due) - now));
  }

  private publish(sessionId: string, threadIds: Iterable<string>): void {
    for (const threadId of threadIds) {
      const viewers = this.viewersOf(sessionId, threadId);
      const key = threadKey(sessionId, threadId);
      const body = JSON.stringify(viewers);
      if (this.sent.get(key) === body) continue;
      if (viewers.length === 0) this.sent.delete(key);
      else this.sent.set(key, body);
      for (const listener of this.listeners.get(sessionId) ?? []) listener(threadId, viewers);
    }
  }
}

/** The process's registry. */
export const activeViewers = new ActiveViewers();
