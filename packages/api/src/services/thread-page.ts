import { parseThreadLineGroupKey, threadLineGroupKey, threadOrigin } from "@valet/shared";
import { HOME_THREAD_KEY } from "../home/context.js";
import type { ListThreadsResponse, ThreadLineGroup, ThreadSummary } from "../wire/types.js";

/** Threads each line group ships on the first page, newest first. */
export const LINE_GROUP_PREVIEW = 10;

/** Apply paging only after workspace authorization and archive/search filtering. */
export function threadPage(threads: ThreadSummary[], params: URLSearchParams): ListThreadsResponse {
  const fixed = new Set(params.getAll("fixedId"));
  const selected = params.get("threadId");
  if (fixed.size > 50) throw new Error("Request at most 50 fixed threads at a time.");
  if (params.get("fixedOnly") === "1") return { threads: threads.filter(t => fixed.has(t.id) || t.id === selected) };
  const rawLimit = params.get("limit");
  if (rawLimit === null) return { threads };
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Use a thread page limit from 1 to 100.");
  const sort = params.get("sort") ?? "last-user-activity";
  if (sort !== "created" && sort !== "last-user-activity") throw new Error("Use created or last-user-activity to sort threads.");
  const filter = params.get("origin") ?? "all";
  if (!["all", "chat", "auto", "channel", "other"].includes(filter)) throw new Error("Select a supported thread origin filter.");
  // `groups=lines` lists each Presence line's threads as one group, outside
  // the page. `line=<group>` pages one group's threads.
  const grouping = params.get("groups") === "lines";
  const line = params.get("line");
  if (line !== null && parseThreadLineGroupKey(line) === undefined) throw new Error("Select a Presence line group, such as sub:<id>.");
  // Home is the app's first screen, not a row in a thread list. Earlier
  // helper conversations are rows, so they stay reachable, but a workspace
  // never opens one by default.
  const visible = threads.filter(t => !t.key?.startsWith("workflow:") && t.key !== HOME_THREAD_KEY);
  const originCounts = { all: visible.length, chat: 0, auto: 0, channel: 0, other: 0 };
  for (const t of visible) originCounts[threadOrigin(t.key)]++;
  const newestFirst = (a: ThreadSummary, b: ThreadSummary) => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  const openable = visible.filter(t => !t.key?.startsWith("app-assistant:")).sort(newestFirst);
  // A grouped thread opens by default only when no other thread exists.
  const defaultThreadId = (grouping ? openable.find(t => threadLineGroupKey(t.key) === undefined) ?? openable[0] : openable[0])?.id;
  const time = (t: ThreadSummary) => sort === "created" ? t.createdAt : t.lastUserActivityAt;
  const sorted = visible.filter(t => filter === "all" || threadOrigin(t.key) === filter)
    .sort((a, b) => time(b) - time(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const inLine = line !== null ? sorted.filter(t => threadLineGroupKey(t.key) === line) : undefined;
  const grouped = grouping && inLine === undefined ? sorted.filter(t => threadLineGroupKey(t.key) !== undefined) : [];
  const listed = inLine ?? (grouped.length > 0 ? sorted.filter(t => threadLineGroupKey(t.key) === undefined) : sorted);
  let after: { time: number; created: number; id: string } | undefined;
  const cursor = params.get("cursor");
  if (cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!value || typeof value !== "object" || !("time" in value) || typeof value.time !== "number" || !("created" in value) || typeof value.created !== "number" || !("id" in value) || typeof value.id !== "string") throw new Error();
      after = { time: value.time, created: value.created, id: value.id };
    } catch { throw new Error("The thread cursor is invalid. Refresh the thread list."); }
  }
  const remaining = listed.filter(t => !fixed.has(t.id) && (!after || time(t) < after.time || (time(t) === after.time && (t.createdAt < after.created || (t.createdAt === after.created && t.id.localeCompare(after.id) > 0)))));
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = remaining.length > limit && last ? Buffer.from(JSON.stringify({ time: time(last), created: last.createdAt, id: last.id })).toString("base64url") : undefined;
  if (inLine !== undefined) return { threads: page, nextCursor };
  const extras = threads.filter(t => t.id === selected || t.id === defaultThreadId || fixed.has(t.id));
  // Groups ship once, with the first page. `sorted` is newest first, so a
  // group's first thread is its newest and groups keep that order.
  const lineGroups = new Map<string, { group: ThreadLineGroup; preview: ThreadSummary[] }>();
  if (!cursor) {
    for (const t of grouped) {
      const key = threadLineGroupKey(t.key)!;
      const parsed = parseThreadLineGroupKey(key)!;
      const entry = lineGroups.get(key) ?? { group: { key, kind: parsed.kind, ruleId: parsed.id, name: "", threadCount: 0 }, preview: [] };
      entry.group.threadCount++;
      if (entry.preview.length < LINE_GROUP_PREVIEW) entry.preview.push(t);
      lineGroups.set(key, entry);
    }
  }
  const previews = [...lineGroups.values()].flatMap(entry => entry.preview);
  return {
    threads: [...new Map([...page, ...previews, ...extras].map(t => [t.id, t])).values()],
    nextCursor, defaultThreadId, originCounts,
    ...(grouping && !cursor ? { lineGroups: [...lineGroups.values()].map(entry => entry.group) } : {}),
  };
}
