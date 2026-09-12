import type {
  DeliveredBusEvent,
  EventStream,
  SessionStore,
  Unsubscribe,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import {
  autoTitle,
  type AutoTitleInput,
  type AutoTitleResult,
  type Namer,
} from "./auto-title.js";

export interface AutoTitleHostDeps {
  eventStream: EventStream;
  title: (input: AutoTitleInput) => Promise<AutoTitleResult>;
  maxAttempts?: number;
  initialRetryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createAutoTitleHost(deps: {
  db: AppDb;
  engineStore: SessionStore;
  eventStream: EventStream;
  namer?: Namer;
}): AutoTitleHost {
  return new AutoTitleHost({
    eventStream: deps.eventStream,
    title: (input) =>
      autoTitle(
        {
          db: deps.db,
          ...(deps.namer ? { namer: deps.namer } : {}),
          loadMessages: async (sessionId, threadId) => {
            if (!threadId) return [];
            const entries = await deps.engineStore.getEntries(sessionId, threadId);
            const messages: { role: string; content: string }[] = [];
            for (const entry of entries) {
              if (entry.type !== "message") continue;
              if (entry.role !== "user" && entry.role !== "assistant") continue;
              messages.push({ role: entry.role, content: entry.content ?? "" });
              if (messages.length === 4) break;
            }
            return messages;
          },
        },
        input,
      ),
  });
}

/**
 * Starts automatic naming after a submission settles successfully.
 *
 * The event is origin-neutral, so web, channel, schedule, and event prompts
 * all use the same path. The in-flight map coalesces duplicate settlement
 * delivery in this process. A bounded retry covers transient model failures
 * for one-turn sessions. The title writer provides the durable idempotency
 * check for retries and later events.
 */
export class AutoTitleHost {
  private unsubscribe: Unsubscribe | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private generation = 0;

  constructor(private readonly deps: AutoTitleHostDeps) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.eventStream.subscribe(
      { eventTypes: ["submission_settled"] },
      (event) => this.handle(event),
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.generation += 1;
    this.inFlight.clear();
  }

  private async titleWithRetry(
    input: AutoTitleInput,
    generation: number,
  ): Promise<AutoTitleResult | null> {
    const maxAttempts = this.deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const wait = this.deps.sleep ?? sleep;
    let retryMs = this.deps.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.deps.title(input);
      } catch (err) {
        console.error(
          `auto-title attempt ${attempt}/${maxAttempts} failed for ${input.sessionId}/${input.threadId}:`,
          err,
        );
        if (attempt === maxAttempts || generation !== this.generation) return null;
        await wait(retryMs);
        if (generation !== this.generation) return null;
        retryMs *= 2;
      }
    }
    return null;
  }

  private handle(event: DeliveredBusEvent): void {
    const settled = event.event;
    if (settled.type !== "submission_settled" || settled.outcome.outcome !== "completed") return;

    const input = { sessionId: event.sessionId, threadId: settled.threadId };
    const key = `${input.sessionId}\u0000${input.threadId}`;
    if (this.inFlight.has(key)) return;

    const generation = this.generation;
    const work = this.titleWithRetry(input, generation)
      .then((result) => {
        if (
          generation !== this.generation ||
          !result?.ok ||
          (!result.sessionTitle && !result.threadTitle)
        ) {
          return;
        }
        this.deps.eventStream.publishEphemeral({
          sessionId: input.sessionId,
          threadId: input.threadId,
          timestamp: Date.now(),
          event: {
            type: "title_updated",
            threadId: input.threadId,
            ...(result.sessionTitle ? { sessionTitle: result.sessionTitle } : {}),
            ...(result.threadTitle ? { threadTitle: result.threadTitle } : {}),
          },
        });
      })
      .finally(() => {
        if (this.inFlight.get(key) === work) this.inFlight.delete(key);
      });
    this.inFlight.set(key, work);
  }
}
