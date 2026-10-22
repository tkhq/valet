/**
 * Who has each thread open in a web tab right now, and who is typing in it.
 * Each session WebSocket reports the threads its tab shows and the tab's
 * visibility; closing the socket removes them at once. Nothing is stored.
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

interface Connection {
  id: string;
  sessionId: string;
  person: { userId: string; name: string; avatarUrl?: string };
  openedAt: number;
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

export class ActiveViewers {
  private readonly connections = new Map<string, Connection>();
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

  /** Records which threads a connection shows and whether its tab is visible. */
  view(connection: { id: string; sessionId: string; person: Connection["person"] }, threadIds: string[], visible: boolean): void {
    const existing = this.connections.get(connection.id);
    const touched = new Set(existing?.threadIds ?? []);
    const next: Connection = existing ?? { ...connection, openedAt: this.now(), threadIds: new Set() };
    next.threadIds = new Set(threadIds);
    if (visible) delete next.hiddenAt;
    else next.hiddenAt ??= this.now();
    if (next.typing && !next.threadIds.has(next.typing.threadId)) delete next.typing;
    this.connections.set(connection.id, next);
    for (const id of next.threadIds) touched.add(id);
    this.schedule(next);
    this.publish(next.sessionId, touched);
  }

  /** Marks a connection as typing in one of its threads, or stops it. */
  type(connectionId: string, threadId: string, active: boolean): void {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.threadIds.has(threadId)) return;
    if (active) connection.typing = { threadId, until: this.now() + TYPING_WINDOW_MS };
    else if (connection.typing?.threadId === threadId) delete connection.typing;
    else return;
    this.schedule(connection);
    this.publish(connection.sessionId, new Set([threadId]));
  }

  /** Removes a closed connection. */
  leave(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.connections.delete(connectionId);
    this.timers.get(connectionId)?.cancel();
    this.timers.delete(connectionId);
    this.publish(connection.sessionId, connection.threadIds);
  }

  /** The people with the thread open, each once, in the order they arrived. */
  viewersOf(sessionId: string, threadId: string): ActiveViewer[] {
    const now = this.now();
    const people = new Map<string, ActiveViewer & { since: number }>();
    for (const connection of this.connections.values()) {
      if (connection.sessionId !== sessionId || !connection.threadIds.has(threadId)) continue;
      if (connection.hiddenAt !== undefined && now - connection.hiddenAt >= HIDDEN_GRACE_MS) continue;
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

  /** Threads with at least one viewer, by session. */
  activeThreads(): Map<string, Set<string>> {
    const bySession = new Map<string, Set<string>>();
    for (const connection of this.connections.values()) {
      for (const threadId of connection.threadIds) {
        if (this.viewersOf(connection.sessionId, threadId).length === 0) continue;
        let set = bySession.get(connection.sessionId);
        if (!set) { set = new Set(); bySession.set(connection.sessionId, set); }
        set.add(threadId);
      }
    }
    return bySession;
  }

  /** Republishes when a background tab's grace or a typing window ends. */
  private schedule(connection: Connection): void {
    this.timers.get(connection.id)?.cancel();
    const now = this.now();
    const due = [
      connection.hiddenAt !== undefined ? connection.hiddenAt + HIDDEN_GRACE_MS : undefined,
      connection.typing ? connection.typing.until : undefined,
    ].filter((at): at is number => at !== undefined && at > now);
    if (due.length === 0) { this.timers.delete(connection.id); return; }
    this.timers.set(connection.id, this.setTimer(() => {
      this.timers.delete(connection.id);
      if (connection.typing && connection.typing.until <= this.now()) delete connection.typing;
      this.schedule(connection);
      this.publish(connection.sessionId, connection.threadIds);
    }, Math.min(...due) - now));
  }

  private publish(sessionId: string, threadIds: Iterable<string>): void {
    for (const threadId of threadIds) {
      const viewers = this.viewersOf(sessionId, threadId);
      const key = `${sessionId} ${threadId}`;
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
