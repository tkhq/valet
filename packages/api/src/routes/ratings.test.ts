/**
 * `/api/sessions/:id/rating`, `/api/sessions/:id/messages/:entryId/rating`,
 * `/api/sessions/:id/ratings`, `/api/evals/flagged` — thumbs up/down
 * feedback (TKAI-334). Ratings are per-user upserts scoped by
 * `canViewSession`; the flagged listing returns only the caller's rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, ratings } from "../schema/index.js";
import type { GetSessionRatingsResponse, ListFlaggedResponse, PutRatingResponse } from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

async function seedSession(a: TestApi, opts: { id: string; userId?: string; title?: string }): Promise<void> {
  const now = Date.now();
  await a.providers.db.insert(agentSessions).values({
    id: opts.id,
    userId: opts.userId ?? "local-user",
    orgId: "local-org",
    workspace: `/tmp/ratings-test-${opts.id}`,
    status: "active",
    title: opts.title ?? null,
    ownerType: "user",
    ownerId: opts.userId ?? "local-user",
    createdAt: now,
    updatedAt: now,
  });
}

function post(a: TestApi, path: string, body: unknown) {
  return fetch(`${a.baseUrl}${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
}

describe("POST /api/sessions/:id/rating", () => {
  it("upserts the caller's session rating and null clears it", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rate-s1" });

    const up = await post(api, "/api/sessions/rate-s1/rating", { rating: "positive" });
    expect(up.status).toBe(200);
    expect(((await up.json()) as PutRatingResponse).rating).toBe("positive");

    // Re-rating updates the SAME row.
    const down = await post(api, "/api/sessions/rate-s1/rating", { rating: "negative" });
    expect(down.status).toBe(200);
    const rows = await api.providers.db
      .select()
      .from(ratings)
      .where(and(eq(ratings.sessionId, "rate-s1"), eq(ratings.targetType, "session")));
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe("negative");

    const clear = await post(api, "/api/sessions/rate-s1/rating", { rating: null });
    expect(clear.status).toBe(200);
    const after = await api.providers.db.select().from(ratings).where(eq(ratings.sessionId, "rate-s1"));
    expect(after).toHaveLength(0);
  });

  it("404s on someone else's session and on a missing session", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rate-s2", userId: "someone-else" });
    expect((await post(api, "/api/sessions/rate-s2/rating", { rating: "positive" })).status).toBe(404);
    expect((await post(api, "/api/sessions/nope/rating", { rating: "positive" })).status).toBe(404);
  });

  it("400s on an invalid rating value", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rate-s3" });
    const res = await post(api, "/api/sessions/rate-s3/rating", { rating: "meh" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("positive");
  });
});

describe("POST /api/sessions/:id/messages/:entryId/rating", () => {
  it("stores an entry-level rating with its thread id", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rate-m1" });

    const res = await post(api, "/api/sessions/rate-m1/messages/entry-42/rating", {
      rating: "positive",
      threadId: "th-1",
    });
    expect(res.status).toBe(200);

    const rows = await api.providers.db
      .select()
      .from(ratings)
      .where(and(eq(ratings.targetType, "entry"), eq(ratings.targetId, "entry-42")));
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("rate-m1");
    expect(rows[0].threadId).toBe("th-1");
  });
});

describe("GET /api/sessions/:id/ratings", () => {
  it("returns the caller's session and entry ratings", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "rate-r1" });
    await post(api, "/api/sessions/rate-r1/rating", { rating: "positive" });
    await post(api, "/api/sessions/rate-r1/messages/e-1/rating", { rating: "negative" });

    const res = await fetch(`${api.baseUrl}/api/sessions/rate-r1/ratings`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GetSessionRatingsResponse;
    expect(body.session).toBe("positive");
    expect(body.entries).toEqual({ "e-1": "negative" });
  });
});

describe("GET /api/evals/flagged", () => {
  it("lists the caller's positively rated sessions with pagination", async () => {
    api = await bootTestApi();
    await seedSession(api, { id: "flag-1", title: "First" });
    await seedSession(api, { id: "flag-2", title: "Second" });
    await seedSession(api, { id: "flag-3", title: "Third" });
    await post(api, "/api/sessions/flag-1/rating", { rating: "positive" });
    await post(api, "/api/sessions/flag-2/rating", { rating: "positive" });
    await post(api, "/api/sessions/flag-3/rating", { rating: "negative" });
    // The cursor is strict-less-than on updatedAt; two same-millisecond rows
    // would tie-drop, so separate them deterministically.
    await api.providers.db
      .update(ratings)
      .set({ updatedAt: Date.now() + 1000 })
      .where(eq(ratings.targetId, "flag-2"));

    const res = await fetch(`${api.baseUrl}/api/evals/flagged?rating=positive&limit=1`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const page1 = (await res.json()) as ListFlaggedResponse;
    expect(page1.flagged).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();

    const res2 = await fetch(
      `${api.baseUrl}/api/evals/flagged?rating=positive&limit=5&cursor=${page1.nextCursor}`,
      { headers: HEADERS },
    );
    const page2 = (await res2.json()) as ListFlaggedResponse;
    expect(page2.nextCursor).toBeUndefined();
    const all = [...page1.flagged, ...page2.flagged].map((f) => f.sessionId).sort();
    expect(all).toEqual(["flag-1", "flag-2"]);

    const negative = await fetch(`${api.baseUrl}/api/evals/flagged?rating=negative`, { headers: HEADERS });
    const negBody = (await negative.json()) as ListFlaggedResponse;
    expect(negBody.flagged.map((f) => f.sessionId)).toEqual(["flag-3"]);
  });

  it("rejects unknown rating values and non-session levels", async () => {
    api = await bootTestApi();
    expect((await fetch(`${api.baseUrl}/api/evals/flagged?rating=great`, { headers: HEADERS })).status).toBe(400);
    expect((await fetch(`${api.baseUrl}/api/evals/flagged?level=entry`, { headers: HEADERS })).status).toBe(400);
  });
});
