import { InMemoryEventStream } from "@valet/engine";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions, sessionThreads } from "../schema/index.js";
import { freshTestPgDb } from "../test-helpers/pg-test-db.js";
import { autoTitle, type AutoTitleResult } from "./auto-title.js";
import { AutoTitleHost } from "./auto-title-host.js";

const ORIGINS = ["web", "slack", "schedule", "event"] as const;

describe("AutoTitleHost", () => {
  let db: AppDb;
  let eventStream: InMemoryEventStream;

  beforeEach(async () => {
    ({ appDb: db } = await freshTestPgDb());
    eventStream = new InMemoryEventStream();
  });

  async function seedSession(sessionId: string): Promise<void> {
    await db.insert(agentSessions).values({
      id: sessionId,
      userId: "u1",
      orgId: "org1",
      workspace: "demo",
      title: null,
      createdAt: 1,
      updatedAt: 1,
    });
  }

  async function emitSettled(
    sessionId: string,
    threadId: string,
    queueItemId: string,
    outcome: "completed" | "failed" = "completed",
  ): Promise<void> {
    await eventStream.append(
      {
        sessionId,
        threadId,
        queueItemId,
        timestamp: Date.now(),
        event: {
          type: "submission_settled",
          sessionId,
          threadId,
          queueItemId,
          outcome: { outcome },
        },
      },
      `settled:${queueItemId}`,
    );
  }

  it.each(ORIGINS)(
    "persists titles after the first completed %s turn without a thread view",
    async (origin) => {
      const sessionId = `session-${origin}`;
      const threadId = `thread-${origin}`;
      await seedSession(sessionId);
      const namer = vi.fn(async () => `${origin} first turn`);
      const titleUpdates: string[] = [];
      eventStream.subscribe({ eventTypes: ["title_updated"] }, (event) => {
        if (event.event.type === "title_updated" && event.event.threadTitle) {
          titleUpdates.push(event.event.threadTitle);
        }
      });
      const host = new AutoTitleHost({
        eventStream,
        title: (input) =>
          autoTitle(
            {
              db,
              loadMessages: async () => [
                { role: "user", content: `prompt from ${origin}` },
                { role: "assistant", content: "completed response" },
              ],
              namer,
              now: () => 42,
            },
            input,
          ),
      });
      host.start();

      await emitSettled(sessionId, threadId, `${origin}-first`);

      await vi.waitFor(async () => {
        const [thread] = await db
          .select({ title: sessionThreads.title })
          .from(sessionThreads)
          .where(eq(sessionThreads.id, threadId));
        expect(thread?.title).toBe(`${origin} first turn`);
      });
      const [session] = await db
        .select({ title: agentSessions.title })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId));
      expect(session?.title).toBe(`${origin} first turn`);
      expect(namer).toHaveBeenCalledTimes(1);
      expect(titleUpdates).toEqual([`${origin} first turn`]);
      host.stop();
    },
  );

  it("retries a transient naming failure without another turn or thread view", async () => {
    await seedSession("session-retry");
    const wait = vi.fn(async () => undefined);
    const title = vi
      .fn<(input: { sessionId: string; threadId?: string }) => Promise<{
        ok: true;
        sessionTitle: string | null;
        threadTitle: string | null;
      }>>()
      .mockRejectedValueOnce(new Error("429 rate limited"))
      .mockResolvedValueOnce({
        ok: true,
        sessionTitle: "Retried Title",
        threadTitle: "Retried Title",
      });
    const updates: string[] = [];
    eventStream.subscribe({ eventTypes: ["title_updated"] }, (event) => {
      if (event.event.type === "title_updated" && event.event.threadTitle) {
        updates.push(event.event.threadTitle);
      }
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = new AutoTitleHost({ eventStream, title, sleep: wait });
    host.start();

    await emitSettled("session-retry", "thread-retry", "only-turn");

    await vi.waitFor(() => expect(updates).toEqual(["Retried Title"]));
    expect(title).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1_000);
    error.mockRestore();
    host.stop();
  });

  it("releases the in-flight key after a bounded failure", async () => {
    const title = vi
      .fn<(input: { sessionId: string; threadId?: string }) => Promise<AutoTitleResult>>()
      .mockRejectedValueOnce(new Error("namer timed out"))
      .mockResolvedValueOnce({ ok: false, reason: "already_titled" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = new AutoTitleHost({ eventStream, title, maxAttempts: 1 });
    host.start();

    await emitSettled("session-timeout", "thread-timeout", "first");
    await vi.waitFor(() => expect(title).toHaveBeenCalledTimes(1));
    await emitSettled("session-timeout", "thread-timeout", "later");
    await vi.waitFor(() => expect(title).toHaveBeenCalledTimes(2));

    error.mockRestore();
    host.stop();
  });

  it("ignores failed turns and coalesces duplicate completion events", async () => {
    await seedSession("session-1");
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const namer = vi.fn(async () => {
      await blocked;
      return "One Durable Title";
    });
    const host = new AutoTitleHost({
      eventStream,
      title: (input) =>
        autoTitle(
          {
            db,
            loadMessages: async () => [
              { role: "user", content: "name this" },
              { role: "assistant", content: "done" },
            ],
            namer,
          },
          input,
        ),
    });
    host.start();

    await emitSettled("session-1", "thread-1", "failed", "failed");
    expect(namer).not.toHaveBeenCalled();

    await emitSettled("session-1", "thread-1", "first");
    await emitSettled("session-1", "thread-1", "duplicate");
    await vi.waitFor(() => expect(namer).toHaveBeenCalledTimes(1));
    release?.();
    await vi.waitFor(async () => {
      const [thread] = await db
        .select({ title: sessionThreads.title })
        .from(sessionThreads)
        .where(eq(sessionThreads.id, "thread-1"));
      expect(thread?.title).toBe("One Durable Title");
    });

    await emitSettled("session-1", "thread-1", "later");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(namer).toHaveBeenCalledTimes(1);
    host.stop();
  });
});
