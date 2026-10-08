import type { ListThreadsResponse, ThreadSummary } from "../wire/types.js";

type Origin = "chat" | "auto" | "channel" | "other";
function origin(thread: ThreadSummary): Origin {
  const key = thread.key;
  if (!key || key === "default" || key.startsWith("web:")) return "chat";
  if (key === "events" || key.startsWith("signal:workflow:")) return "auto";
  if (["telegram:", "slack:", "discord:", "email:", "sms:"].some(prefix => key.startsWith(prefix))) return "channel";
  return "other";
}

/** Apply paging only after workspace authorization and archive/search filtering. */
export function threadPage(threads: ThreadSummary[], params: URLSearchParams): ListThreadsResponse {
  const rawLimit = params.get("limit");
  if (rawLimit === null) return { threads };
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Use a thread page limit from 1 to 100.");
  const sort = params.get("sort") ?? "last-user-activity";
  if (sort !== "created" && sort !== "last-user-activity") throw new Error("Use created or last-user-activity to sort threads.");
  const filter = params.get("origin") ?? "all";
  if (!["all", "chat", "auto", "channel", "other"].includes(filter)) throw new Error("Select a supported thread origin filter.");
  const visible = threads.filter(t => !t.key?.startsWith("app-assistant:") && !t.key?.startsWith("workflow:"));
  const originCounts = { all: visible.length, chat: 0, auto: 0, channel: 0, other: 0 };
  for (const t of visible) originCounts[origin(t)]++;
  const defaultThreadId = [...visible].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0]?.id;
  const fixed = new Set(params.getAll("fixedId"));
  const selected = params.get("threadId");
  const time = (t: ThreadSummary) => sort === "created" ? t.createdAt : t.lastUserActivityAt;
  const sorted = visible.filter(t => filter === "all" || origin(t) === filter)
    .sort((a, b) => time(b) - time(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  let after: { time: number; created: number; id: string } | undefined;
  const cursor = params.get("cursor");
  if (cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!value || typeof value !== "object" || !("time" in value) || typeof value.time !== "number" || !("created" in value) || typeof value.created !== "number" || !("id" in value) || typeof value.id !== "string") throw new Error();
      after = { time: value.time, created: value.created, id: value.id };
    } catch { throw new Error("The thread cursor is invalid. Refresh the thread list."); }
  }
  const remaining = sorted.filter(t => !fixed.has(t.id) && (!after || time(t) < after.time || (time(t) === after.time && (t.createdAt < after.created || (t.createdAt === after.created && t.id.localeCompare(after.id) > 0)))));
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = remaining.length > limit && last ? Buffer.from(JSON.stringify({ time: time(last), created: last.createdAt, id: last.id })).toString("base64url") : undefined;
  const extras = threads.filter(t => t.id === selected || t.id === defaultThreadId || (fixed.has(t.id) && (filter === "all" || origin(t) === filter)));
  return { threads: [...new Map([...page, ...extras].map(t => [t.id, t])).values()], nextCursor, defaultThreadId, originCounts };
}
