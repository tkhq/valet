import type { AppDb } from "../lib/drizzle.js";

export const WEB_PRESENCE_TTL_MS = 45_000;

/** The API runs one replica. Use a shared presence store before adding replicas. */
export class WebPresence {
  private readonly users = new Map<string, Map<string, number>>();

  report(userId: string, tabId: string, active: boolean, now = Date.now()): void {
    // Expired tabs are normal: a tab can close without a final request.
    for (const [user, tabs] of this.users) {
      for (const [tab, at] of tabs) if (now - at >= WEB_PRESENCE_TTL_MS) tabs.delete(tab);
      if (tabs.size === 0) this.users.delete(user);
    }
    const tabs = this.users.get(userId) ?? new Map<string, number>();
    if (active) tabs.set(tabId, now);
    else tabs.delete(tabId);
    // Bound tab ids supplied by a client. Keep the most recent reports.
    if (tabs.size > 32) tabs.delete(tabs.keys().next().value ?? "");
    if (tabs.size > 0) this.users.set(userId, tabs);
    else this.users.delete(userId);
  }

  isActive(userId: string, now = Date.now()): boolean {
    return [...(this.users.get(userId)?.values() ?? [])].some(at => now - at < WEB_PRESENCE_TTL_MS);
  }
}

const instances = new WeakMap<AppDb, WebPresence>();

/** One presence scope per API database handle, including isolated test stacks. */
export function webPresence(db: AppDb): WebPresence {
  let presence = instances.get(db);
  if (!presence) { presence = new WebPresence(); instances.set(db, presence); }
  return presence;
}
