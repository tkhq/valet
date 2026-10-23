import type { ChannelTransport, DecisionGate, DeliveredBusEvent, EventStream, Unsubscribe } from "@valet/engine";

interface StatusTurn {
  channelType: string;
  conversationKey: string;
  threadTs: string;
  sessionId: string;
  threadId: string;
}

interface Registration extends StatusTurn {
  queueItemId?: string;
  gateId?: string;
  recoveringId?: string;
  earlyEvents: DeliveredBusEvent[];
  status: string;
}

/** Owns processing indicators independently of streamed or discrete replies. */
export class ChannelProcessingStatus {
  private turns = new Set<Registration>();
  private chains = new Map<string, Promise<void>>();
  private unsubscribe: Unsubscribe | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly events: EventStream,
    private readonly transportFor: (channelType: string) => Pick<ChannelTransport, "setStatus"> | null,
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.events.subscribe({ eventTypes: ["submission_settled", "decision_gate", "decision_gate_resolved", "decision_gate_expired", "decision_gate_withdrawn"] }, event => {
      for (const turn of [...this.turns]) {
        if (event.sessionId !== turn.sessionId || !("threadId" in event.event) || event.event.threadId !== turn.threadId) continue;
        if (!turn.queueItemId) turn.earlyEvents.push(event);
        else this.apply(turn, event);
      }
    });
    // Slack expires an indicator after two minutes without a reply.
    this.timer = setInterval(() => {
      const refreshed = new Set<string>();
      for (const turn of this.turns) {
        const key = this.key(turn);
        if (!refreshed.has(key)) { refreshed.add(key); this.write(turn); }
      }
    }, 60_000);
    this.timer.unref?.();
  }

  begin(input: StatusTurn, recoveringId?: string): Registration | undefined {
    if (!this.unsubscribe) return undefined;
    if (recoveringId && [...this.turns].some(turn => turn.sessionId === input.sessionId && (turn.queueItemId === recoveringId || turn.recoveringId === recoveringId))) return undefined;
    if (!this.transportFor(input.channelType)?.setStatus) return undefined;
    const turn: Registration = { ...input, recoveringId, earlyEvents: [], status: "is thinking…" };
    this.turns.add(turn);
    this.write(turn);
    return turn;
  }

  bind(turn: Registration | undefined, queueItemId: string, gate?: DecisionGate): void {
    if (!turn || !this.turns.has(turn)) return;
    const existing = [...this.turns].find(candidate => candidate !== turn && candidate.sessionId === turn.sessionId && candidate.queueItemId === queueItemId);
    if (existing) { this.turns.delete(turn); this.write(existing); return; }
    turn.recoveringId = undefined;
    turn.queueItemId = queueItemId;
    if (gate) {
      turn.gateId = gate.id;
      turn.status = gate.type === "approval" ? "is waiting for your approval…" : "is waiting for your response…";
      this.write(turn);
    }
    for (const event of turn.earlyEvents) this.apply(turn, event);
    turn.earlyEvents = [];
  }

  cancel(turn: Registration | undefined): void {
    if (!turn || !this.turns.delete(turn)) return;
    const remaining = [...this.turns].find(candidate => this.key(candidate) === this.key(turn));
    if (remaining) this.write(remaining);
    else this.write(turn, "");
  }

  /** Slack clears status when a reply posts, even if the submission still has work. */
  refresh(sessionId: string, threadId: string): void {
    const refreshed = new Set<string>();
    for (const turn of this.turns) {
      if (turn.sessionId !== sessionId || turn.threadId !== threadId || refreshed.has(this.key(turn))) continue;
      refreshed.add(this.key(turn));
      this.write(turn);
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearInterval(this.timer);
    this.timer = undefined;
    for (const turn of [...this.turns]) this.cancel(turn);
    await Promise.all(this.chains.values());
  }

  private apply(turn: Registration, delivered: DeliveredBusEvent): void {
    if (!this.turns.has(turn)) return;
    const event = delivered.event;
    const queueItemId = event.type === "submission_settled" ? event.queueItemId : delivered.queueItemId;
    if (event.type === "submission_settled" && queueItemId === turn.queueItemId) {
      if (event.mergedIntoItemId) turn.queueItemId = event.mergedIntoItemId;
      else this.cancel(turn);
    } else if (event.type === "decision_gate" && queueItemId === turn.queueItemId) {
      turn.gateId = event.gate.id;
      turn.status = event.gate.type === "approval" ? "is waiting for your approval…" : "is waiting for your response…";
      this.write(turn);
    } else if ((event.type === "decision_gate_resolved" || event.type === "decision_gate_expired" || event.type === "decision_gate_withdrawn") && event.gateId === turn.gateId) {
      turn.gateId = undefined;
      turn.status = "is thinking…";
      this.write(turn);
    }
  }

  private key(turn: StatusTurn): string {
    return `${turn.channelType}\0${turn.conversationKey}\0${turn.threadTs}`;
  }

  private write(turn: Registration, status?: string): void {
    const key = this.key(turn);
    const candidates = [...this.turns].filter(candidate => this.key(candidate) === key);
    const aggregate = candidates.find(candidate => candidate.gateId !== undefined) ?? candidates[0];
    const value = aggregate?.status ?? status ?? "";
    const transport = this.transportFor(turn.channelType);
    const next = (this.chains.get(key) ?? Promise.resolve()).then(async () => {
      try { await transport?.setStatus?.(turn.conversationKey, turn.threadTs, value); }
      catch (error) { console.error(`[channels] ${turn.channelType}: processing status failed`, error); }
    });
    this.chains.set(key, next);
    void next.then(() => { if (this.chains.get(key) === next) this.chains.delete(key); });
  }
}
