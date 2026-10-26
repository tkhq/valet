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
 *   - After `init`, the handshake seeds each thread's queue and non-idle
 *     status before durable replay can advance that state.
 *   - The handshake subscribes before reading active model state. The model
 *     snapshot follows replay and buffered live frames, so it is authoritative.
 *   - Resume: `?fromOffset=<offset>` replays durable events after that offset
 *     before live delivery resumes. Durable frames carry a persistent
 *     `offset`; ephemeral frames (text_delta) never do. Without the query
 *     param the socket delivers live-only from "now".
 *   - Periodic ping every 30s; client should reply with `pong`. The server
 *     does not enforce idle timeout.
 */
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { agentSessions, users } from "../schema/index.js";
import { activeViewers } from "../services/active-viewers.js";
import { ensureDefaultThreadWhereOwned } from "../services/default-thread.js";
import { busEventToWire, queueStateToWire, type WireEventDraft } from "../engine/bridge.js";
import { loadSessionMeta } from "../engine/session-meta.js";
import { deriveRunFields } from "../sessions/run-state.js";
import { canViewSession } from "../services/session-access.js";
import { cachedThreadVisibility, requestViewer, threadVisibility, threadRef } from "../services/thread-access.js";
import { shareWriteCount, threadShareGrant } from "../services/thread-share.js";
import type { AssistantOwner, ClientFrame, ClientViewing, SessionStatus, WireEvent } from "../wire/types.js";
import type { DeliveredBusEvent, QueueItem } from "@valet/engine";

const PING_INTERVAL_MS = 30_000;
/** Page size for durable replay reads on resume. */
const REPLAY_PAGE_SIZE = 500;

export function createWsConnectionLifecycle() {
  let closed = false;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  return {
    get closed() {
      return closed;
    },
    setUnsubscribe(next: () => void) {
      if (closed) {
        next();
        return;
      }
      unsubscribe = next;
    },
    startKeepalive(sendPing: () => void) {
      if (closed || pingTimer !== undefined) return;
      pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
    },
    close() {
      if (closed) return;
      closed = true;
      if (pingTimer !== undefined) {
        clearInterval(pingTimer);
        pingTimer = undefined;
      }
      const currentUnsubscribe = unsubscribe;
      unsubscribe = undefined;
      currentUnsubscribe?.();
    },
  };
}

/** How long one connection trusts a thread access answer before asking again,
 * so a person removed from a private channel stops receiving it. */
const THREAD_ACCESS_RECHECK_MS = 5 * 60_000;
/** How long a shared thread's guest stream trusts a share before reading it
 * again. A share change in this process is seen at once. */
const SHARE_RECHECK_MS = 5_000;
/** The most threads one tab reports at once: a page shows one, a panel adds a few. */
const MAX_VIEWED_THREADS = 8;

export function registerWsRoutes(
  app: Hono<AppEnv>,
  upgradeWebSocket: UpgradeWebSocket,
) {
  app.get(
    "/api/sessions/:id/ws",
    upgradeWebSocket((c) => {
      const sessionId = c.req.param("id");
      const providers = c.var.providers;
      const caller = c.var.principal;
      // Resume handshake: `?fromOffset=<offset>` replays durable events after
      // that offset before live delivery. Empty/absent ⇒ live-only.
      const rawFromOffset = c.req.query("fromOffset");
      const fromOffset =
        rawFromOffset !== undefined && rawFromOffset !== "" ? rawFromOffset : undefined;

      let seq = 0;
      const lifecycle = createWsConnectionLifecycle();
      // Track the most recent assistant messageId per thread so text_delta
      // events can be tagged with a real id (engine emits deltas without one).
      const activeMessageByThread = new Map<string, string>();

      // A team runtime's private threads (`services/thread-access.ts`) stream
      // only to the people who may see them. Frames pass through one chain so
      // a thread awaiting its access check cannot reorder the stream.
      let threadShown: ((threadId: string) => Promise<boolean>) | undefined;
      // A shared thread's guest (`services/thread-share.ts`) connects with
      // `?threadId=` and receives that thread's frames and keepalives only.
      const sharedThreadId = c.req.query("threadId") || undefined;
      let guestOnly = false;
      let chain: Promise<void> = Promise.resolve();
      // Who has which thread open (`services/active-viewers.ts`). A person's
      // socket reports the threads its tab shows; a team API key never does.
      const connectionId = randomUUID();
      let viewing: ((frame: ClientViewing | { type: "typing"; threadId: string; active: boolean }) => Promise<void>) | undefined;
      let pendingViewing: ClientViewing | undefined;
      let stopViewers: (() => void) | undefined;
      // Frames apply in arrival order: each awaits access checks, so a quick
      // hidden-then-visible pair must not land the wrong way round.
      let viewerFrames: Promise<void> = Promise.resolve();
      const applyViewerFrame = (frame: ClientViewing | { type: "typing"; threadId: string; active: boolean }) => {
        const apply = viewing;
        if (!apply) return;
        viewerFrames = viewerFrames.then(() => apply(frame)).catch((err) => console.error(`ws ${frame.type} frame failed:`, err));
      };
      const deliver = (ws: { send: (data: string) => void; close: (code?: number, reason?: string) => void }, draftEvent: WireEventDraft) => {
        const threadId = "threadId" in draftEvent && typeof draftEvent.threadId === "string" ? draftEvent.threadId : undefined;
        const shown = threadShown;
        if (!shown) {
          send(ws, draftEvent);
          return;
        }
        chain = chain.then(async () => {
          if (guestOnly && !threadId && draftEvent.type !== "ping") return;
          // A guest's keepalive also checks the share, so an idle stream ends too.
          const checkThread = guestOnly && draftEvent.type === "ping" ? sharedThreadId : threadId;
          if (checkThread && !(await shown(checkThread).catch(() => false))) {
            // A revoked share ends the guest's stream.
            if (guestOnly && checkThread === sharedThreadId && !lifecycle.closed) ws.close(4040, "session not found");
            return;
          }
          if (!lifecycle.closed) send(ws, draftEvent);
        });
      };

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
            // team membership for a team's orchestrator session, or the
            // team principal itself (see `services/session-access.ts`).
            const rows = await providers.db
              .select()
              .from(agentSessions)
              .where(eq(agentSessions.id, sessionId))
              .limit(1);
            if (lifecycle.closed) return;
            const row = rows[0];
            if (!row) {
              ws.close(4040, "session not found");
              return;
            }
            const canView = await canViewSession(providers.db, row, caller)
              // A child started from a private thread is that thread's audience's.
              && (row.ownerType !== "team" || await threadVisibility(providers, row, requestViewer(row.orgId, caller, c.var.user.id))(null));
            if (lifecycle.closed) return;
            const share = !canView && sharedThreadId ? await threadShareGrant(providers.db, row, sharedThreadId, caller) : null;
            if (lifecycle.closed) return;
            if (!canView && !share) {
              ws.close(4040, "session not found");
              return;
            }
            if (share && sharedThreadId) {
              guestOnly = true;
              // Read the share again when it may have changed: after a share
              // write in this process, or after the recheck interval.
              let checked = { at: Date.now(), writes: shareWriteCount(), shown: true };
              threadShown = async (threadId) => {
                if (threadId !== sharedThreadId) return false;
                if (checked.writes !== shareWriteCount() || Date.now() - checked.at >= SHARE_RECHECK_MS) {
                  const writes = shareWriteCount();
                  const [current] = await providers.db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
                  const mode = current ? await threadShareGrant(providers.db, current, sharedThreadId, caller) : null;
                  checked = { at: Date.now(), writes, shown: mode !== null };
                }
                return checked.shown;
              };
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
            const sessionMeta = await loadSessionMeta(providers.db, row);
            if (lifecycle.closed) return;
            const engineSession = await providers.engineHost.sessionFor(sessionId, sessionMeta);
            if (lifecycle.closed) return;
            await ensureDefaultThreadWhereOwned(sessionId, engineSession);
            if (lifecycle.closed) return;

            if (row.ownerType === "team" && !guestOnly) {
              const visible = threadVisibility(providers, row, requestViewer(row.orgId, caller, c.var.user.id), {
                liveThread: (liveSessionId, liveThreadId) => {
                  const live = providers.engineHost.liveSession(liveSessionId)?.threadById(liveThreadId);
                  return live ? threadRef(live) : undefined;
                },
              });
              // A delivery that records a new Slack channel on a live thread
              // discards the cached answer on the next frame.
              threadShown = cachedThreadVisibility(visible,
                (threadId) => {
                  const live = engineSession.threadById(threadId);
                  return live ? threadRef(live) : undefined;
                },
                (threadId) => providers.engineStore.getThread(sessionId, threadId),
                THREAD_ACCESS_RECHECK_MS);
            }

            // Run state at handshake time, from the same derivation the REST
            // routes use (`sessions/run-state.ts`). Later changes arrive as
            // their own frames (`queue.state`, `decision_gate`,
            // `submission.settled`); this only seeds the opening view.
            const unsettled = await providers.engineStore.listUnsettledSubmissions(sessionId);
            if (lifecycle.closed) return;
            const run = deriveRunFields(
              { status: row.status as SessionStatus, updatedAt: row.updatedAt },
              guestOnly ? unsettled.filter((item: QueueItem) => item.threadId === sharedThreadId) : unsettled,
            );

            // A guest does not get the session's workspace label or title.
            send(ws, {
              type: "init",
              session: {
                id: row.id,
                workspace: guestOnly ? "" : row.workspace,
                status: row.status as SessionStatus,
                kind: row.kind === "security" ? "security" : "code",
                runState: run.runState,
                owner: { type: row.ownerType as AssistantOwner["type"], id: row.ownerId },
                title: guestOnly ? undefined : row.title ?? undefined,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                lastActivityAt: run.lastActivityAt,
                // Reserved field; populating accurately requires a count
                // query and the UI doesn't currently render this number.
                messageCount: 0,
                profile: row.profile,
                docker: row.docker,
              },
            });

            // Seed per-thread live state right after init. A client that
            // connects mid-turn (page load, reconnect) would otherwise show
            // the thread as idle — no Stop button, Escape inert — until the
            // NEXT transition event, which a long tool call can hold off for
            // minutes. `queue.state` comes from durable rows; the `status`
            // frame reads the in-memory turn phase. Both are chunk-style
            // (no offset), so the client applies them unconditionally and a
            // later durable replay still converges to the same state.
            for (const thread of engineSession.listThreads()) {
              const queueState = await thread.currentQueueState();
              if (lifecycle.closed) return;
              deliver(ws, queueStateToWire(sessionId, thread.id, queueState));
              const agentStatus = thread.currentAgentStatus;
              if (agentStatus !== "idle") {
                deliver(ws, { type: "status", threadId: thread.id, status: agentStatus });
              }
            }

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
                deliver(ws, draft);
              }
            };

            // Subscribe to the engine event stream for this session. During a
            // resume replay, live events are buffered so they can't jump ahead
            // of (or duplicate) the durable events being replayed.
            let replaying = fromOffset !== undefined;
            const liveBuffer: DeliveredBusEvent[] = [];
            lifecycle.setUnsubscribe(
              providers.eventStream.subscribe({ sessionId }, (busEvent: DeliveredBusEvent) => {
                if (replaying) {
                  liveBuffer.push(busEvent);
                  return;
                }
                emit(busEvent);
              }),
            );

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
                if (lifecycle.closed) return;
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

            // A fresh connection has no sandbox event to replay. Seed after
            // subscription and replay so gateway panes see the current state.
            deliver(ws, {
              type: "sandbox.status",
              state: engineSession.attachment.state,
              epoch: engineSession.attachment.currentEpoch(),
              estimateMs: engineSession.attachment.coldStartEstimateMs,
            });

            // Seed per-thread model state after the subscription and replay.
            // `currentModelState()` serializes with model transitions, so an
            // earlier live event is sent before this authoritative snapshot.
            // A later transition follows it through the installed subscription.
            for (const thread of engineSession.listThreads()) {
              const modelState = await thread.currentModelState();
              if (lifecycle.closed) return;
              deliver(ws, modelState
                ? {
                    type: "model.state",
                    threadId: thread.id,
                    queueItemId: modelState.queueItemId,
                    model: modelState.model,
                  }
                : {
                    type: "model.state",
                    threadId: thread.id,
                    queueItemId: null,
                    model: null,
                  });
            }

            // Periodic keepalive.
            lifecycle.startKeepalive(() => {
              deliver(ws, { type: "ping" });
            });

            // Viewer changes reach this socket through `deliver`, so a private
            // thread's or a guest's filter applies to them too.
            if (lifecycle.closed) return;
            stopViewers = activeViewers.subscribe(sessionId, (threadId, viewers) => {
              if (!lifecycle.closed) deliver(ws, { type: "thread.viewers", threadId, viewers });
            });
            if (caller.type === "user") {
              const [account] = await providers.db.select({ name: users.name, email: users.email, image: users.image })
                .from(users).where(eq(users.id, caller.id)).limit(1);
              if (lifecycle.closed) return;
              const person = {
                userId: caller.id,
                name: account?.name || account?.email || "A teammate",
                ...(account?.image ? { avatarUrl: account.image } : {}),
              };
              const mayShow = async (threadId: string) =>
                Boolean(engineSession.threadById(threadId) ?? await providers.engineStore.getThread(sessionId, threadId))
                && (!threadShown || await threadShown(threadId).catch(() => false));
              viewing = async (frame) => {
                if (frame.type === "viewing") {
                  const requested = [...new Set(frame.threadIds.filter((id): id is string => typeof id === "string"))].slice(0, MAX_VIEWED_THREADS);
                  const allowed = (await Promise.all(requested.map(async (id) => (await mayShow(id)) ? id : undefined)))
                    .filter((id): id is string => id !== undefined);
                  if (lifecycle.closed) return;
                  const added = activeViewers.view({ id: connectionId, sessionId, orgId: row.orgId, person }, allowed, frame.visible === true);
                  // A second tab of someone already listed changes no list, so
                  // this socket gets a newly shown thread's list directly.
                  for (const threadId of added) {
                    deliver(ws, { type: "thread.viewers", threadId, viewers: activeViewers.viewersOf(sessionId, threadId) });
                  }
                  return;
                }
                activeViewers.type(connectionId, frame.threadId, frame.active === true);
              };
              if (pendingViewing) applyViewerFrame(pendingViewing);
            }
          } catch (err) {
            // Engine setup failed (e.g. workspace doesn't exist, Docker
            // unreachable). Surface as a wire error and close — never
            // throw past the handler, or it crashes the whole process.
            if (lifecycle.closed) return;
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
          if (frame.type === "viewing" && Array.isArray(frame.threadIds)) {
            // A frame sent before the handshake ends waits for it.
            if (!viewing) { pendingViewing = frame; return; }
            applyViewerFrame(frame);
            return;
          }
          if (frame.type === "typing" && typeof frame.threadId === "string") applyViewerFrame(frame);
        },

        onClose() {
          lifecycle.close();
          stopViewers?.();
          activeViewers.leave(connectionId);
        },

        onError(err) {
          console.error("ws error:", err);
        },
      };
    }),
  );
}
