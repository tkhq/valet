/**
 * Principle citations (`docs/specs/2026-10-27-brain-principles-playbooks-design.md`,
 * "Usage"). The base principle tells the agent to say which principle it
 * followed. When a turn settles, this module reads that turn's answer and
 * any plan it wrote, finds the principles they name, appends one
 * `principle_cited` thread event, and counts a cite on each principle file.
 *
 * Explicit references come first: the principle's path as the index names
 * it, or a built-in principle's name. A title match is a heuristic, and its
 * citation says so (`match: "title"`).
 *
 * The work per turn is bounded: one submission's assistant entries, capped
 * in count and characters, and one capped read of the scope's principle
 * files. It runs in the event subscriber, after the turn, never inside it.
 */
import { sql } from "drizzle-orm";
import type { EventStream, MessagePart, PrincipleCitation } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { listPrincipleFiles, type MemoryFileKey } from "../services/memory.js";
import { memoryScopeForSession, memorySessionId } from "../services/memory-scope.js";
import { memoryUsageRecorder } from "../services/memory-usage.js";
import { BASE_PRINCIPLE_NAME } from "./principles.js";

/** Most citations one turn records. */
export const MAX_CITATIONS_PER_TURN = 10;
/** Most assistant entries and characters the scan reads for one turn. */
const MAX_SCANNED_ENTRIES = 50;
const MAX_SCANNED_CHARS = 64 * 1024;
/** A title shorter than this, or of one word, matches too much ordinary prose. */
const MIN_TITLE_CHARS = 8;

interface CitablePrinciple {
  /** The path as the index names it, `team:{id}/` prefix included. */
  path: string;
  title: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the path where it stands alone: not inside a longer path, so an
 * own `principles/x.md` never matches `team:t/principles/x.md`. The `.md`
 * and a leading `/` are optional, since models drop or add them. */
function pathPattern(path: string): RegExp {
  const stem = escapeRegExp(path.replace(/\.md$/i, ""));
  return new RegExp(`(?<![\\w:./-])/?${stem}(?:\\.md)?(?![\\w/-])`, "i");
}

function titlePattern(title: string): RegExp | null {
  const words = title.trim().split(/\s+/);
  if (words.length < 2 || title.trim().length < MIN_TITLE_CHARS) return null;
  return new RegExp(`(?<![\\w-])${words.map(escapeRegExp).join("\\s+")}(?![\\w-])`, "i");
}

/** The principles `texts` name, in the order of `principles`, explicit
 * matches before title matches, each principle once. Pure. */
export function findPrincipleCitations(texts: readonly string[], principles: readonly CitablePrinciple[]): PrincipleCitation[] {
  const text = texts.join("\n");
  const found: PrincipleCitation[] = [];
  const seen = new Set<string>();
  const add = (path: string, match: PrincipleCitation["match"]) => {
    if (seen.has(path) || found.length >= MAX_CITATIONS_PER_TURN) return;
    seen.add(path);
    found.push({ path, match });
  };
  for (const principle of principles) {
    if (pathPattern(principle.path).test(text)) add(principle.path, "path");
  }
  if (new RegExp(`(?<![\\w-])${escapeRegExp(BASE_PRINCIPLE_NAME)}(?![\\w-])`, "i").test(text)) add(BASE_PRINCIPLE_NAME, "path");
  for (const principle of principles) {
    const pattern = titlePattern(principle.title);
    if (pattern?.test(text)) add(principle.path, "title");
  }
  return found;
}

function planTexts(parts: MessagePart[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part.type !== "tool_call" || part.toolName !== "update_plan") continue;
    const args = part.args;
    if (typeof args !== "object" || args === null || !("items" in args) || !Array.isArray(args.items)) continue;
    for (const item of args.items) {
      if (typeof item === "object" && item !== null && "text" in item && typeof item.text === "string") out.push(item.text);
    }
  }
  return out;
}

function parseParts(raw: string | null): MessagePart[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    // Stored by the engine as `MessagePart[]`; `planTexts` re-checks every
    // field it reads, so a malformed part is skipped, not trusted.
    return Array.isArray(parsed) ? (parsed as MessagePart[]) : [];
  } catch {
    return [];
  }
}

/** The answer text and plan items one submission wrote, capped. */
async function turnTexts(db: AppDb, sessionId: string, queueItemId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT content, parts FROM engine_entries
    WHERE session_id = ${sessionId} AND queue_item_id = ${queueItemId}
      AND entry_type = 'message' AND role = 'assistant'
    ORDER BY created_at, seq LIMIT ${MAX_SCANNED_ENTRIES}`) as { rows: { content: string | null; parts: string | null }[] };
  const texts: string[] = [];
  let chars = 0;
  for (const row of result.rows) {
    for (const text of [row.content ?? "", ...planTexts(parseParts(row.parts))]) {
      if (!text || chars >= MAX_SCANNED_CHARS) continue;
      const kept = text.slice(0, MAX_SCANNED_CHARS - chars);
      texts.push(kept);
      chars += kept.length;
    }
  }
  return texts;
}

export interface SettledTurn {
  sessionId: string;
  threadId: string;
  queueItemId: string;
}

/** Finds the principles one settled turn named, appends the thread event,
 * and counts the cites. Idempotent per submission: the event key is the
 * submission, and a repeat append is a no-op that records no cite. */
export async function recordPrincipleCitations(db: AppDb, eventStream: EventStream, turn: SettledTurn): Promise<void> {
  const texts = await turnTexts(db, turn.sessionId, turn.queueItemId);
  if (texts.length === 0) return;
  // A child session reads its parent's memory, so its citations count there.
  const scope = await memoryScopeForSession(db, await memorySessionId(db, turn.sessionId));
  if (!scope) return;
  const files = await listPrincipleFiles(db, scope);
  const citations = findPrincipleCitations(texts, files);
  if (citations.length === 0) return;

  const eventKey = `principle_cited:${turn.queueItemId}`;
  // `append` is a no-op for a key it already holds, but it does not say
  // so. Check first, so a repeated settle counts no second cite.
  const existing = await db.execute(sql`SELECT 1 AS present FROM engine_events
    WHERE session_id = ${turn.sessionId} AND event_key = ${eventKey} LIMIT 1`) as { rows: unknown[] };
  if (existing.rows.length > 0) return;
  await eventStream.append({
    sessionId: turn.sessionId,
    threadId: turn.threadId,
    queueItemId: turn.queueItemId,
    timestamp: Date.now(),
    event: { type: "principle_cited", threadId: turn.threadId, citations },
  }, eventKey);

  const keys = new Map<string, MemoryFileKey>(files.map((file) => [file.path, file.key]));
  const usage = memoryUsageRecorder(db);
  const citedAt = Date.now();
  for (const citation of citations) {
    // A built-in principle has no memory file to count against.
    const key = keys.get(citation.path);
    if (key) usage.record(key, "cite", citedAt);
  }
}

/** Subscribe before boot restore, like the other settle subscribers. */
export function wirePrincipleCitations(eventStream: EventStream, db: AppDb): () => void {
  return eventStream.subscribe({ eventTypes: ["submission_settled"] }, ({ event }) => {
    if (event.type !== "submission_settled") return;
    void recordPrincipleCitations(db, eventStream, {
      sessionId: event.sessionId, threadId: event.threadId, queueItemId: event.queueItemId,
    }).catch((err: unknown) => console.warn("[principle-citations] could not record a turn's citations. Check database availability.", err));
  });
}
