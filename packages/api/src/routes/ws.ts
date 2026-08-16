/**
 * WebSocket event stream — `GET /api/sessions/:id/ws`.
 *
 * Subscribes to the engine bus for a given session, maps each BusEvent to a
 * wire event via the bridge, and pushes to the connected client. Adds a
 * monotonic per-session `seq` and a `ts` timestamp on the way out.
 *
 * Semantics:
 *   - One subscriber = one socket = one session.
 *   - `init` is sent first, metadata-only. Thread history loads via REST.
 *   - Resume: `?fromOffset=<offset>` replays durable events after that offset
 *     before live delivery resumes. Durable frames carry a persistent
 *     `offset`; ephemeral frames (text_delta) never do. Without the query
 *     param the socket delivers live-only from "now".
 *   - Periodic ping every 30s; client should reply with `pong`. The server
 *     does not enforce idle timeout.
 */
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import { busEventToWire, type WireEventDraft } from "../engine/bridge.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { deriveRunFields } from "../sessions/run-state.js";
import { canViewSession } from "../services/session-access.js";
import type { AssistantOwner, ClientFrame, SessionStatus, WireEvent } from "../wire/types.js";
import type { DeliveredBusEvent } from "@valet/engine";

const PING_INTERVAL_MS = 30_000;
/** Page size for durable replay reads on resume. */
const REPLAY_PAGE_SIZE = 500;

export function registerWsRoutes(
  app: Hono<AppEnv>,
  upgradeWebSocket: UpgradeWebSocket,
) {
  app.get(
    "/api/sessions/:id/ws",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id");
      const providers = c.var.providers;
      const userId = c.var.user.id;
      // Resume handshake: `?fromOffset=<offset>` replays durable events after
      // that offset before live delivery. Empty/absent ⇒ live-only.
      const rawFromOffset = c.req.query("fromOffset");
      const fromOffset =
        rawFromOffset !== undefined && rawFromOffset !== "" ? rawFromOffset : undefined;

      let seq = 0;
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      // Track the most recent assistant messageId per thread so text_delta
      // events can be tagged with a real id (engine emits deltas without one).
      const activeMessageByThread = new Map<string, string>();

      const send = (ws: { send: (data: string) => void }, draftEvent: WireEventDraft) => {
        const ev = { ...draftEvent, seq: ++seq, ts: Date.now() } as WireEvent;
        try {
          ws.send(JSON.stringify(ev));
        } catch (err) {
          console.error("ws send failed:", err);
        }
      };

      return {
        async onOpen(_evt, ws) {
          // Wrap the whole handshake in try/catch — any throw here would
          // become an unhandled rejection and crash the entire server
          // process, killing every other live session. We instead emit an
          // error frame and close the socket gracefully.
          try {
            // Verify view access before subscribing — direct ownership, or
            // team membership for a team's orchestrator session (see
            // `services/session-access.ts`).
            const rows = await providers.db
              .select()
              .from(agentSessions)
              .where(eq(agentSessions.id, sessionId))
              .limit(1);
            const row = rows[0];
            if (!row || !(await canViewSession(providers.db, row, userId))) {
              ws.close(4040, "session not found");
              return;
            }

            // Materialize the engine session so the bus is set up + the
            // default thread exists (so the client can immediately POST
            // /threads or /messages without race against the engine).
            // We DO NOT read the persisted entries here — the client loads
            // history per-thread via REST so reconnects don't wipe the
            // currently-visible thread when it isn't the default.
            //
            // The WS is the FIRST touch in the web flow (the browser opens
            // this stream before POSTing the first prompt), so the meta MUST
            // carry repo bindings — otherwise the session caches a prep-less
            // attachment and repo-bound sessions never clone. `loadSessionMeta`
            // assembles the complete meta (repos + git identity included).
            const engineSession = await providers.engineHost.sessionFor(
              sessionId,
              await loadSessionMeta(providers.db, row),
            );
            await engineSession.ensureDefaultThread();

            // Run state at handshake time, from the same derivation the REST
            // routes use (`sessions/run-state.ts`). Later changes arrive as
            // their own frames (`queue.state`, `decision_gate`,
            // `submission.settled`); this only seeds the opening view.
            const unsettled = await providers.engineStore.listUnsettledSubmissions(sessionId);
            const run = deriveRunFields(
              { status: row.status as SessionStatus, updatedAt: row.updatedAt },
              unsettled,
            );

            send(ws, {
              type: "init",
              session: {
                id: row.id,
                workspace: row.workspace,
                status: row.status as SessionStatus,
                runState: run.runState,
                owner: { type: row.ownerType as AssistantOwner["type"], id: row.ownerId },
                title: row.title ?? undefined,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                lastActivityAt: run.lastActivityAt,
                // Reserved field; populating accurately requires a count
                // query and the UI doesn't currently render this number.
                messageCount: 0,
                profile: row.profile,
              },
            });

            // Map one bus event → wire frames and push them. Durable events
            // carry `offset`; we stamp it onto each frame so clients can
            // resume. Ephemeral frames (text_delta) have no offset.
            const emit = (busEvent: DeliveredBusEvent) => {
              if (busEvent.event.type === "message_start") {
                activeMessageByThread.set(busEvent.event.threadId, busEvent.event.messageId);
              }
              const drafts = busEventToWire(busEvent);
              for (const draft of drafts) {
                if (draft.type === "text_delta" && !draft.messageId) {
                  const filled = activeMessageByThread.get(draft.threadId);
                  if (filled) draft.messageId = filled;
                }
                if (busEvent.offset !== undefined) draft.offset = busEvent.offset;
                send(ws, draft);
              }
            };

            // Subscribe to the engine event stream for this session. During a
            // resume replay, live events are buffered so they can't jump ahead
            // of (or duplicate) the durable events being replayed.
            let replaying = fromOffset !== undefined;
            const liveBuffer: DeliveredBusEvent[] = [];
            unsubscribe = providers.eventStream.subscribe({ sessionId }, (busEvent: DeliveredBusEvent) => {
              if (replaying) {
                liveBuffer.push(busEvent);
                return;
              }
              emit(busEvent);
            });

            if (fromOffset !== undefined) {
              // Replay durable events strictly after `fromOffset`, in pages,
              // in order. Track the highest offset delivered so the live
              // buffer can drop anything already replayed.
              let lastReplayedSeq = Number(fromOffset);
              if (!Number.isFinite(lastReplayedSeq)) lastReplayedSeq = 0;
              let cursor = fromOffset;
              for (;;) {
                const { events, nextOffset } = await providers.eventStream.read(sessionId, {
                  fromOffset: cursor,
                  limit: REPLAY_PAGE_SIZE,
                });
                if (events.length === 0) break;
                for (const stored of events) {
                  emit(stored);
                  lastReplayedSeq = Number(stored.offset);
                }
                cursor = nextOffset;
                if (events.length < REPLAY_PAGE_SIZE) break;
              }
              // Flush buffered live events, dropping any at-or-below the last
              // replayed offset (delivered exactly once). No `await` between
              // here and clearing `replaying`, so nothing interleaves.
              for (const buffered of liveBuffer) {
                if (buffered.offset !== undefined && Number(buffered.offset) <= lastReplayedSeq) {
                  continue;
                }
                emit(buffered);
              }
              liveBuffer.length = 0;
              replaying = false;
            }

            // Periodic keepalive.
            pingTimer = setInterval(() => {
              send(ws, { type: "ping" });
            }, PING_INTERVAL_MS);
          } catch (err) {
            // Engine setup failed (e.g. workspace doesn't exist, Docker
            // unreachable). Surface as a wire error and close — never
            // throw past the handler, or it crashes the whole process.
            console.error("ws onOpen failed:", err);
            try {
              send(ws, {
                type: "error",
                code: "ws_open_failed",
                message: (err as Error).message ?? "failed to open session stream",
                recoverable: false,
              });
            } catch {}
            try {
              ws.close(1011, "internal error");
            } catch {}
          }
        },

        onMessage(evt) {
          // Best-effort parse; ignore unknowns.
          let frame: ClientFrame;
          try {
            const data = typeof evt.data === "string" ? evt.data : evt.data.toString();
            frame = JSON.parse(data) as ClientFrame;
          } catch {
            return;
          }
          // v1: subscribe is implicit on connect, pong is best-effort.
          if (frame.type === "subscribe" || frame.type === "pong") return;
        },

        onClose() {
          if (pingTimer) clearInterval(pingTimer);
          if (unsubscribe) unsubscribe();
        },

        onError(err) {
          console.error("ws error:", err);
        },
      };
    }),
  );
}
