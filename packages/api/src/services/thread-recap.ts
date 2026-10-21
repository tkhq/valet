/**
 * Writes the recap a person sees when they come back to a thread that other
 * people talked to Valet in.
 * `recapWindow` in @valet/shared decides whether a thread shows one; this
 * module turns the window into at most three lines with a small model.
 */
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { recapWindow, type RecapMessage, type RecapWindow } from "@valet/shared";
import type { ThreadRecapPoint, ThreadRecapResponse } from "../wire/types.js";

/** Same small model as thread naming: the recap needs speed, not reasoning. */
const RECAP_MODEL = "claude-haiku-4-5";
const RECAP_TIMEOUT_MS = 20_000;
const MAX_POINTS = 3;
const MAX_POINT_CHARS = 200;
const MAX_MESSAGE_CHARS = 1_200;
/** The newest new messages fill this budget first; older new messages drop out. */
const MAX_WINDOW_CHARS = 24_000;
const MAX_EARLIER_MESSAGES = 4;
const MAX_EARLIER_CHARS = 400;
const CACHE_LIMIT = 500;

const RECAP_SYSTEM = [
  "You write a short recap for a person who opens a shared conversation between people and an AI assistant named Valet.",
  "Reply with JSON only, in this shape: {\"points\":[{\"text\":\"...\",\"forReader\":false}]}",
  "Rules:",
  "- One to three points, most important first. Use fewer points when little happened.",
  "- Each point is one plain sentence of 15 words or fewer. No markdown, no emoji, no filler.",
  "- Say what was decided, done, sent, made, or asked. Keep concrete names, numbers, and document titles.",
  "- Name people by first name. Call the assistant Valet.",
  "- When something waits on the reader (a question to them, an approval only they can give, someone deferring to them), put it first, set forReader to true, and say what they need to do. Every other point has forReader false.",
  "- Use only facts from the transcript.",
].join("\n");

export type RecapWriter = (prompt: string) => Promise<string>;

export const defaultRecapWriter: RecapWriter = async (prompt) => {
  const model = getModel("anthropic", RECAP_MODEL);
  if (!model) throw new Error(`thread recap: unknown model "${RECAP_MODEL}"`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`thread recap: the model did not answer in ${RECAP_TIMEOUT_MS}ms`)), RECAP_TIMEOUT_MS);
    timer.unref?.();
  });
  const completion = completeSimple(model, {
    systemPrompt: RECAP_SYSTEM,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
  }, { temperature: 0.2, maxTokens: 400 });
  const result = await Promise.race([completion, timeout]).finally(() => clearTimeout(timer));
  return result.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("");
};

function speaker(message: RecapMessage, readerId: string): string {
  if (message.role === "assistant") return "Valet";
  const name = message.author?.name?.trim() || "A teammate";
  return message.author?.id === readerId && !message.author.externalSender ? `${name} (the reader)` : name;
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace("T", " ");
}

function line(message: RecapMessage, readerId: string, limit: number): string {
  const text = message.content.replace(/\s+/g, " ").trim();
  return `[${speaker(message, readerId)}, ${stamp(message.createdAt)} UTC] ${text.length > limit ? `${text.slice(0, limit - 1)}…` : text}`;
}

/** The model prompt for one window. Exported for tests. */
export function recapPrompt(window: RecapWindow, readerId: string, readerName: string): string {
  const lines: string[] = [];
  let budget = MAX_WINDOW_CHARS;
  for (const message of [...window.messages].reverse()) {
    const next = line(message, readerId, MAX_MESSAGE_CHARS);
    if (budget - next.length < 0 && lines.length > 0) {
      lines.push("(older new messages left out)");
      break;
    }
    budget -= next.length;
    lines.push(next);
  }
  lines.reverse();
  const earlier = window.earlier.slice(-MAX_EARLIER_MESSAGES).map((message) => line(message, readerId, MAX_EARLIER_CHARS));
  return [
    `The reader is ${readerName}.`,
    window.mode === "away"
      ? `They last saw this conversation at ${stamp(window.since ?? 0)} UTC. Recap only the NEW MESSAGES.`
      : "They have never opened this conversation. Recap where it stands: what it is for, what happened, and what is still open.",
    ...(earlier.length ? ["", "EARLIER MESSAGES (the reader saw these; use them as context only):", ...earlier] : []),
    "",
    window.mode === "away" ? "NEW MESSAGES:" : "MESSAGES:",
    ...lines,
  ].join("\n");
}

/** Reads the model reply. Throws when it holds no usable point. Exported for tests. */
export function parseRecapPoints(reply: string): ThreadRecapPoint[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("thread recap: the model reply had no JSON object");
  const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
  const raw = typeof parsed === "object" && parsed !== null && "points" in parsed ? parsed.points : undefined;
  if (!Array.isArray(raw)) throw new Error("thread recap: the model reply had no points array");
  const points: ThreadRecapPoint[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || !("text" in item) || typeof item.text !== "string") continue;
    const text = item.text.replace(/[*_`#]+/g, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const forReader = "forReader" in item && item.forReader === true;
    points.push({ text: text.length > MAX_POINT_CHARS ? `${text.slice(0, MAX_POINT_CHARS - 1)}…` : text, ...(forReader ? { forReader } : {}) });
  }
  if (points.length === 0) throw new Error("thread recap: the model reply had no usable point");
  // The line that waits on the reader leads, whatever order the model used.
  return points.sort((a, b) => Number(b.forReader ?? false) - Number(a.forReader ?? false)).slice(0, MAX_POINTS);
}

/**
 * Recaps by window. A reader who reopens the same window, or a second tab,
 * reuses the recap instead of paying for another model call. The key holds
 * the window's last message, so a new message makes a new recap.
 */
const cache = new Map<string, Promise<ThreadRecapPoint[]>>();

function remember(key: string, work: Promise<ThreadRecapPoint[]>): Promise<ThreadRecapPoint[]> {
  cache.set(key, work);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? key);
  // A failed recap is not kept: the next open asks the model again.
  work.catch(() => cache.delete(key));
  return work;
}

export async function threadRecap(input: {
  threadId: string;
  messages: RecapMessage[];
  readerId: string;
  readerName: string;
  readAt?: number;
  write?: RecapWriter;
}): Promise<ThreadRecapResponse> {
  const window = recapWindow(input.messages, input.readerId, input.readAt);
  if (!window?.worthRecap) return { recap: null };
  const last = window.messages.at(-1)?.id ?? "";
  const key = [input.threadId, input.readerId, window.mode, window.since ?? 0, last].join("|");
  const points = await (cache.get(key) ?? remember(key,
    (input.write ?? defaultRecapWriter)(recapPrompt(window, input.readerId, input.readerName)).then(parseRecapPoints)));
  return { recap: { mode: window.mode, points } };
}

/** Test seam: empties the recap cache. */
export function clearThreadRecapCache(): void {
  cache.clear();
}
