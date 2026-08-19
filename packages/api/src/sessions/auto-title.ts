/**
 * Automatic session/thread naming (V2 parity with the V1 OpenCode runner's
 * title generator). Server-side because we need the LLM API key and want a
 * single owner-gated seam for the write.
 *
 * Pattern:
 *   1. Read the first ~4 messages of the target session/thread
 *   2. Ask a small model for a 3-5 word title
 *   3. Write the result back to `agent_sessions.title` and (optionally) the
 *      requested thread's `session_threads.title`
 *
 * Kept in a dedicated module so the route handler stays HTTP-only and the
 * naming logic is unit-testable without spinning up Hono.
 */
import { and, eq } from "drizzle-orm";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, sessionThreads } from "../schema/index.js";

/** Cheap fast model — auto-titling has no reasoning value, and this call
 * is fired once per session lifetime, so use the cheapest option. */
const NAMING_MODEL = "claude-haiku-4-5";
const MAX_MESSAGES_FOR_TITLE = 4;
const MAX_CHARS_PER_MESSAGE = 800;
const MAX_TITLE_CHARS = 60;

const NAMING_SYSTEM = [
  "You produce very short, human-readable titles for chat conversations.",
  "Rules:",
  "- 3 to 6 words",
  "- Title case",
  "- No trailing punctuation, no quotes, no emojis",
  "- Reply with ONLY the title text, nothing else",
].join("\n");

export interface AutoTitleInput {
  sessionId: string;
  threadId?: string;
}

export type AutoTitleResult =
  | { ok: true; sessionTitle: string | null; threadTitle: string | null }
  | { ok: false; reason: "session_not_found" | "already_titled" | "no_messages" };

/**
 * Truncate + strip common decorations LLMs sneak in even when told not to.
 * Bounded to `MAX_TITLE_CHARS` because a runaway model output otherwise
 * lands unbounded in the header. Falls back to null when the model returned
 * something we don't want to persist (empty / whitespace / obviously wrong
 * — e.g. a full paragraph).
 */
export function sanitizeTitle(raw: string): string | null {
  let text = raw.trim();
  // Strip wrapping quotes / backticks / asterisks.
  text = text.replace(/^["'`*]+|["'`*]+$/g, "").trim();
  // Strip trailing punctuation.
  text = text.replace(/[.!?,;:—-]+$/g, "").trim();
  if (text.length === 0) return null;
  if (text.length > MAX_TITLE_CHARS) text = `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
  return text;
}

/** Cap opening-message content to keep the naming prompt bounded. */
function trimContent(content: string): string {
  return content.slice(0, MAX_CHARS_PER_MESSAGE);
}

/** Reader contract — the route injects one that reads from engine entries
 * (the authoritative message store). The tests inject a fixed array. */
export interface MessagesLoader {
  (sessionId: string, threadId: string | undefined): Promise<
    { role: string; content: string }[]
  >;
}

function buildNamingPrompt(msgs: { role: string; content: string }[]): string {
  const transcript = msgs
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n---\n\n");
  return [
    "Here is the start of a chat conversation:",
    "",
    transcript,
    "",
    "Reply with a 3-6 word title for this conversation and nothing else.",
  ].join("\n");
}

/**
 * Runs the naming LLM call. Extracted so tests can stub it — the real
 * caller uses `completeSimple` from pi-ai, which needs `ANTHROPIC_API_KEY`
 * in the environment.
 */
export interface Namer {
  (prompt: string): Promise<string>;
}

export const defaultNamer: Namer = async (prompt) => {
  const model = getModel("anthropic", NAMING_MODEL);
  if (!model) throw new Error(`auto-title: unknown model "${NAMING_MODEL}"`);
  const result = await completeSimple(
    model,
    {
      systemPrompt: NAMING_SYSTEM,
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
      ],
    },
    { temperature: 0.4, maxTokens: 40 },
  );
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
};

export interface AutoTitleDeps {
  db: AppDb;
  loadMessages: MessagesLoader;
  namer?: Namer;
  /** Clock injected for tests so `updatedAt` is deterministic. */
  now?: () => number;
}

/**
 * Generate + persist a title for the session (and, when `threadId` is
 * given, the thread too). Idempotent: if the session already has a title,
 * returns `already_titled` without spending a model call. Silent when there
 * are no messages yet — the caller may retry after the first exchange.
 */
export async function autoTitle(
  deps: AutoTitleDeps,
  input: AutoTitleInput,
): Promise<AutoTitleResult> {
  const namer = deps.namer ?? defaultNamer;
  const now = deps.now ?? Date.now;

  // Authorization is the CALLER's job — the route holds the request
  // context and applies `canViewSession`. This used to filter on
  // `userId` as well, which silently made a team-owned session titleable
  // only by whichever member opened it first.
  const [session] = await deps.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, input.sessionId))
    .limit(1);
  if (!session) return { ok: false, reason: "session_not_found" };

  // Consider the session titled if the field is a non-empty, non-placeholder
  // string. "" / null / "Untitled session" all count as un-titled.
  const existing = session.title?.trim();
  const alreadyTitled = !!existing && existing !== "Untitled session";
  if (alreadyTitled && !input.threadId) {
    return { ok: false, reason: "already_titled" };
  }

  const loaded = await deps.loadMessages(input.sessionId, input.threadId);
  const msgs = loaded
    .filter((m) => m.content && m.content.trim().length > 0)
    .slice(0, MAX_MESSAGES_FOR_TITLE)
    .map((m) => ({ role: m.role, content: trimContent(m.content) }));
  if (msgs.length === 0) return { ok: false, reason: "no_messages" };

  const namerReply = await namer(buildNamingPrompt(msgs));
  const title = sanitizeTitle(namerReply);
  if (!title) return { ok: true, sessionTitle: null, threadTitle: null };

  const ts = now();

  let wroteSession: string | null = null;
  if (!alreadyTitled) {
    await deps.db
      .update(agentSessions)
      .set({ title, updatedAt: ts })
      .where(eq(agentSessions.id, input.sessionId));
    wroteSession = title;
  }

  let wroteThread: string | null = null;
  if (input.threadId) {
    // Only overwrite when the thread's own title is empty. The engine
    // owns the thread's existence; `session_threads` is our app-side
    // mirror that carries the title. Upsert here so the mirror row is
    // created on first titling, and skip the write when a stored title
    // is already set (respect a user-picked name).
    const [existing] = await deps.db
      .select({ title: sessionThreads.title })
      .from(sessionThreads)
      .where(eq(sessionThreads.id, input.threadId))
      .limit(1);
    const currentTitle = existing?.title?.trim();
    if (!currentTitle) {
      await deps.db
        .insert(sessionThreads)
        .values({
          id: input.threadId,
          sessionId: input.sessionId,
          title,
          createdAt: ts,
        })
        .onConflictDoUpdate({
          target: sessionThreads.id,
          set: { title },
        });
      wroteThread = title;
    }
  }

  return { ok: true, sessionTitle: wroteSession, threadTitle: wroteThread };
}
