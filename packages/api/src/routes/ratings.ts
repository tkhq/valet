/**
 * Thumbs up/down ratings (TKAI-334).
 *
 * `POST /api/sessions/:id/rating` — session-level rating, the primary
 * eval-seeding signal. `POST /api/sessions/:id/messages/:entryId/rating` —
 * entry-level rating, finer-grained feedback. Both upsert one row per
 * (user, target); `rating: null` clears it. `GET /api/sessions/:id/ratings`
 * returns the caller's persisted ratings for one session.
 *
 * `GET /api/evals/flagged` lists the caller's own rated sessions for eval
 * seeding; the eval CLI's `--pull-flagged` reads the database directly and
 * uses this route's shape as its contract.
 *
 * Authorization: rating is personal feedback on a session the caller can
 * read, so every session-scoped route gates on `canViewSession` (the named
 * check for this action — view access implies rate access, and rows are
 * always scoped to the caller's own userId). The flagged listing returns
 * only the caller's own rating rows.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, ratings } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import type {
  FlaggedSessionWire,
  GetSessionRatingsResponse,
  ListFlaggedResponse,
  PutRatingRequest,
  PutRatingResponse,
  RatingValue,
} from "../wire/types.js";

export const ratingsRouter = new Hono<AppEnv>();
export const evalsRouter = new Hono<AppEnv>();

function isRatingValue(v: unknown): v is RatingValue {
  return v === "positive" || v === "negative";
}

/** Load the session row and enforce view access; null → the caller gets a 404. */
async function loadViewableSession(
  db: AppDb,
  sessionId: string,
  userId: string,
) {
  const rows = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row || !(await canViewSession(db, row, userId))) return null;
  return row;
}

async function upsertRating(
  db: AppDb,
  args: {
    userId: string;
    targetType: "session" | "entry";
    targetId: string;
    sessionId: string;
    threadId?: string;
    rating: RatingValue | null;
  },
): Promise<void> {
  if (args.rating === null) {
    await db
      .delete(ratings)
      .where(
        and(
          eq(ratings.userId, args.userId),
          eq(ratings.targetType, args.targetType),
          eq(ratings.targetId, args.targetId),
        ),
      );
    return;
  }
  const now = Date.now();
  await db
    .insert(ratings)
    .values({
      id: randomUUID(),
      userId: args.userId,
      targetType: args.targetType,
      targetId: args.targetId,
      sessionId: args.sessionId,
      threadId: args.threadId ?? null,
      rating: args.rating,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [ratings.userId, ratings.targetType, ratings.targetId],
      set: {
        rating: args.rating,
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        updatedAt: now,
      },
    });
}

function parseRatingBody(body: unknown): PutRatingRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.threadId !== undefined && typeof b.threadId !== "string") return null;
  const threadId = typeof b.threadId === "string" ? { threadId: b.threadId } : {};
  if (b.rating === null) return { rating: null, ...threadId };
  if (!isRatingValue(b.rating)) return null;
  return { rating: b.rating, ...threadId };
}

// ── Session-level rating ───────────────────────────────────────────────────

ratingsRouter.post("/:id/rating", async (c) => {
  const { db } = c.var.providers;
  const sessionId = c.req.param("id");
  const userId = c.var.user.id;
  if ((await loadViewableSession(db, sessionId, userId)) === null) {
    return c.json({ error: "session not found" }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseRatingBody(body);
  if (parsed === null) {
    return c.json({ error: 'rating must be "positive", "negative", or null' }, 400);
  }
  await upsertRating(db, {
    userId,
    targetType: "session",
    targetId: sessionId,
    sessionId,
    rating: parsed.rating,
  });
  const res: PutRatingResponse = { rating: parsed.rating };
  return c.json(res);
});

// ── Entry-level rating ─────────────────────────────────────────────────────

ratingsRouter.post("/:id/messages/:entryId/rating", async (c) => {
  const { db } = c.var.providers;
  const sessionId = c.req.param("id");
  const entryId = c.req.param("entryId");
  const userId = c.var.user.id;
  if ((await loadViewableSession(db, sessionId, userId)) === null) {
    return c.json({ error: "session not found" }, 404);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseRatingBody(body);
  if (parsed === null) {
    return c.json({ error: 'rating must be "positive", "negative", or null' }, 400);
  }
  // The entry id is taken as sent: the row stays scoped to a session the
  // caller can view, so the worst a fabricated id yields is a rating row
  // nothing ever reads. Verifying entry existence would cost a full
  // thread-history read per click.
  await upsertRating(db, {
    userId,
    targetType: "entry",
    targetId: entryId,
    sessionId,
    ...(parsed.threadId !== undefined ? { threadId: parsed.threadId } : {}),
    rating: parsed.rating,
  });
  const res: PutRatingResponse = { rating: parsed.rating };
  return c.json(res);
});

// ── Read back ──────────────────────────────────────────────────────────────

ratingsRouter.get("/:id/ratings", async (c) => {
  const { db } = c.var.providers;
  const sessionId = c.req.param("id");
  const userId = c.var.user.id;
  if ((await loadViewableSession(db, sessionId, userId)) === null) {
    return c.json({ error: "session not found" }, 404);
  }
  const rows = await db
    .select()
    .from(ratings)
    .where(and(eq(ratings.sessionId, sessionId), eq(ratings.userId, userId)));
  const res: GetSessionRatingsResponse = { session: null, entries: {} };
  for (const row of rows) {
    if (row.targetType === "session") res.session = row.rating;
    else res.entries[row.targetId] = row.rating;
  }
  return c.json(res);
});

// ── Flagged listing (eval seeding) ─────────────────────────────────────────

const FLAGGED_PAGE_MAX = 100;

evalsRouter.get("/flagged", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const ratingParam = c.req.query("rating") ?? "positive";
  if (!isRatingValue(ratingParam)) {
    return c.json({ error: 'rating must be "positive" or "negative"' }, 400);
  }
  const level = c.req.query("level") ?? "session";
  if (level !== "session") {
    return c.json({ error: 'level must be "session" (entry-level listing is not implemented)' }, 400);
  }
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), FLAGGED_PAGE_MAX) : 50;
  const cursor = c.req.query("cursor");
  const cursorMs = cursor !== undefined ? Number.parseInt(cursor, 10) : undefined;

  const conditions = [
    eq(ratings.userId, userId),
    eq(ratings.targetType, "session" as const),
    eq(ratings.rating, ratingParam),
    ...(cursorMs !== undefined && Number.isFinite(cursorMs) ? [lt(ratings.updatedAt, cursorMs)] : []),
  ];
  const rows = await db
    .select({
      sessionId: ratings.sessionId,
      rating: ratings.rating,
      updatedAt: ratings.updatedAt,
      title: agentSessions.title,
    })
    .from(ratings)
    .leftJoin(agentSessions, eq(agentSessions.id, ratings.sessionId))
    .where(and(...conditions))
    .orderBy(desc(ratings.updatedAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const flagged: FlaggedSessionWire[] = page.map((r) => ({
    sessionId: r.sessionId,
    rating: r.rating,
    title: r.title ?? null,
    ratedAt: r.updatedAt,
  }));
  const res: ListFlaggedResponse = {
    flagged,
    ...(rows.length > limit ? { nextCursor: String(page[page.length - 1].updatedAt) } : {}),
  };
  return c.json(res);
});
