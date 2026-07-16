# Portable Runtime Engine

> Defines the portable agent runtime engine that replaces OpenCode, the Runner, and the SessionAgentDO's orchestration logic with a single, platform-agnostic TypeScript library deployable on Cloudflare Workers or Kubernetes.

## Scope

This spec covers:

- Engine library architecture and abstraction boundaries
- Session, thread, and message hierarchy
- Agent loop, tool system, compaction, and event emission
- Per-thread prompt queue with modes, backed by durable submissions
- Durable execution: submission lifecycle, claims, leases, reconciliation, terminalization
- Decision-gated execution (approvals, credential requests, questions)
- Prompt and signal ingress (`PromptContent`, `SignalContent`, idempotent admission)
- Provider interfaces (SessionStore, SandboxProvider, EventStream, BlobStore, CredentialStore)
- Schema ownership and migration strategy
- Platform adapter contracts (Cloudflare and Kubernetes)
- Channel transport contracts, with Slack as the required reference transport for V1
- Shared API route layer
- Tool implementation and integration framework (ToolContext, ToolResult, credentials, OAuth)
- LLM provider layer (pi-ai and pi-agent-core adoption)
- Package structure

### Boundary Rules

- This spec does NOT cover individual tool implementations (GitHub, Slack, Linear, etc.) — those are ported separately against the ToolDef interface.
- This spec does NOT cover frontend component implementation details, but it DOES define the API and event contracts the frontend consumes.
- This spec does NOT cover sandbox image building (Dockerfiles, Modal image definitions, warm pools) — the sandbox image gets simpler but that's a separate concern.
- This spec does NOT cover auth, users, orgs, or billing — those stay in the API layer.
- This spec does NOT cover workflow execution internals (definition format, DAG interpretation, trigger management) — but it DOES define the Workflow Caller Contract: the engine primitives workflow steps consume (durable submission ids, result-await, settled events, transcript reads).
- This spec does NOT cover orchestrator persona or long-term memory product behavior — those are application-level services built on top of the engine. The engine-level hooks they consume ARE covered: tool registration, per-session tool configuration, thread identity in ToolContext, the pre-compaction hook, and ordered system-context injection.

## Design Pillars

The engine is defined by these commitments; every contract in this spec serves one of them:

- **Portable core, injected platform.** The engine has zero platform dependencies. Cloudflare and Kubernetes are provider bundles, not architectures.
- **Multi-threaded sessions with concurrent per-thread queues.** The thread is the concurrency, history, and FIFO boundary.
- **Durable-by-default execution.** Every accepted prompt is a durable submission with an explicit lifecycle. A crash, restart, or host replacement never loses accepted work and never leaves the transcript in an ambiguous state.
- **Channel-aware, tenant-aware routing.** Web, Slack, Telegram, and child-session threads route into one session under org/user identity and access control. Channel identity resolution is a first-class engine-adjacent concern, not application glue.
- **Decision-gated execution.** Approvals, questions, and credential acquisition are persisted engine primitives that survive restarts and deliver across channels.
- **Replayable event streams.** Events are an offset-addressed durable log, not a fire-and-forget broadcast. Reconnection is a resume, not a refetch-and-hope.
- **Decoupled lifecycles: the agent is instant; the sandbox is a disposable, asynchronously attached resource.** Session state restores from the store in milliseconds and the turn starts immediately; the sandbox warms in the background and only sandbox-requiring tool calls ever wait on it. The workspace survives; the sandbox does not have to.

## Why: Contrast with Current Architecture

### What Exists Today

```
Client
  ↓ WebSocket
Cloudflare Worker (Hono, 50+ routes)
  ↓ DO binding
SessionAgentDO (~3000 lines)
  ├── Prompt queue (SQLite, alarm-based flush)
  ├── Channel session routing (web/slack/telegram multiplexing)
  ├── Decision gates (approvals, questions, expiry alarms)
  ├── Model selection & credential resolution
  ├── Message persistence (SQLite hot → D1 cold, debounced)
  ├── Connected user tracking
  ├── Health monitoring
  ├── Hibernation/restore orchestration
  ├── Analytics event buffering
  ├── Child session coordination
  ├── Tunnel URL management
  ↓ WebSocket (custom protocol, ~680 lines of type defs)
Runner (~6000 lines across 4 files, runs inside Modal sandbox)
  ├── WebSocket client to DO (reconnection, buffering, request/response tracking)
  ├── ChannelSession state machine (per-channel OpenCode session isolation)
  ├── OpenCode lifecycle management (spawn, health poll, crash recovery, restart)
  ├── SSE event stream consumption & parsing
  ├── Model failover chain (15+ retriable error patterns)
  ├── Audio transcription
  ├── Memory pre-compaction flush
  ├── Auth gateway (JWT, proxying to 5 services, tunnel system)
  ↓ HTTP + SSE
OpenCode (external dependency, runs inside Modal sandbox)
  ├── LLM provider connections
  ├── 73 registered tools
  ├── Session state & context management
  ├── Plugin system (personas, skills, tools)
  └── Config hot-reload via filesystem watch
```

Total moving parts: 4 processes (Worker, DO, Runner, OpenCode), 3 transport protocols (HTTP, WebSocket, SSE), 2 custom message protocols (DO-to-Runner, Runner-to-OpenCode), ~10,000 lines of orchestration code.

### What's Wrong With It

**The DO is a god object.** SessionAgentDO does prompt queuing, channel routing, message persistence, credential resolution, health monitoring, alarm scheduling, WebSocket multiplexing, analytics buffering, and hibernation orchestration. These responsibilities accumulated because the DO is the only stateful coordination point, so everything that needs state ends up there. The result is 3000 lines of deeply coupled code where a change to prompt queuing can break alarm scheduling.

**Three hops to execute a tool call.** When the LLM decides to read a file: LLM (in OpenCode) invokes tool handler, which hits the filesystem directly. Fine. But the prompt that led to that tool call traveled: Client, Worker, DO, WebSocket, Runner, HTTP, OpenCode. And the result travels back the same path. Six network hops round-trip for every user message. Each hop is a failure point, a latency penalty, and a protocol translation.

**The Runner exists to bridge two things that shouldn't be separate.** The Runner's entire purpose is to translate between the DO's WebSocket protocol and OpenCode's HTTP/SSE protocol. It manages OpenCode's process lifecycle, consumes its event stream, tracks per-channel state, handles model failover, and reports back to the DO. It's 6000 lines of glue code. If the agent runtime talked directly to the sandbox, the Runner wouldn't need to exist.

**Two sources of truth for session state.** The DO holds prompt queue state, channel mappings, and decision gates in SQLite. The Runner holds per-channel OpenCode session IDs, streaming state, tool call tracking, and model failover state in memory. D1 holds the canonical message history. When the Runner disconnects and reconnects, there's a complex resync protocol to reconcile these three state locations. This is fragile: the 60-second grace period, the session recreation logic, the "resync if busy, abort if stuck" flow all exist because state is scattered.

**OpenCode is an opaque dependency.** We can't fix bugs in its agent loop or change how it handles tool calls, compaction, or context management. When it crashes, the Runner has to detect the crash, track crash counts, apply exponential backoff, and eventually declare a fatal state. We work around its limitations rather than fixing them: the memory pre-compaction flush at 70% context exists because we can't modify OpenCode's compaction behavior directly.

**Platform lock-in is structural, not incidental.** The architecture doesn't just run on Cloudflare; it's shaped by Cloudflare. The DO's single-writer guarantee shapes the prompt queue design. Hibernatable WebSockets shape the connection model. DO alarms shape the timer system. SQLite in the DO shapes the hot storage pattern. To port to Kubernetes, you wouldn't just swap implementations; you'd have to redesign every subsystem that was shaped by a DO capability.

**The prompt queue is session-wide, blocking cross-channel work.** A Slack conversation blocks web UI prompts. An orchestrator can't research in one thread while coding in another. This isn't a fundamental limitation; it's an artifact of the DO processing one prompt at a time because that's simpler in the single-writer model.

### What Replaces It

```
Client
  ↓ WebSocket / SSE
Platform Adapter (thin: ~200-400 lines)
  ├── CF: Worker routes + SessionHostDO (just hosts engine)
  └── K8s: Hono service + SessionPool (just hosts engine)
  ↓ function call
Engine (portable, ~2000-3000 lines)
  ├── Agent loop (pi-agent-core: prompt → LLM → tools → response)
  ├── Thread management (per-thread queues, cross-visibility)
  ├── Tool execution (built-in + custom ToolDef[])
  ├── Session state (DAG history, compaction)
  ├── Model resolution & failover (pi-ai)
  ├── Event emission
  ↓ SandboxProvider interface
Sandbox (Modal / K8s Pod / Docker / Virtual)
  └── filesystem + shell (no agent logic)
```

Total moving parts: 2 processes (adapter + sandbox), 1 transport protocol (HTTP to sandbox API), 0 custom message protocols, ~3000 lines of orchestration code.

### Why It's Better

**The engine is a library, not a distributed system.** Session state, prompt queuing, thread management, tool execution, and event emission all live in one process with one call stack. No WebSocket protocols, no message serialization, no reconnection logic, no state reconciliation. A prompt goes in, events come out.

**One hop to execute a tool call.** Engine calls `sandbox.exec()` or `sandbox.readFile()`. The sandbox is just a filesystem and shell behind an interface.

**Single source of truth for session state.** The engine holds all session state in memory during execution and persists through SessionStore. No split between DO SQLite, Runner memory, and D1. No resync protocol. No grace periods. If the engine process restarts, it rehydrates from SessionStore: one load, complete state.

**Per-thread concurrency is natural.** Each thread has its own queue and executes independently. The engine manages concurrent threads within a session because it's just concurrent async operations in one process, not distributed coordination.

**We own the agent loop.** Compaction behavior, tool call handling, context management, model failover: all modifiable. No working around an opaque dependency.

**Platform is a configuration choice, not an architectural commitment.** The engine doesn't know about DOs, Workers, pods, or containers. It knows about SessionStore, SandboxProvider, EventStream, BlobStore, and CredentialStore. Porting to a new platform means implementing provider interfaces, not redesigning the session model.

**The sandbox becomes simpler.** The sandbox runs only dev tools (code-server, VNC, TTYD) and a lightweight auth gateway. The agent brain is elsewhere. Sandbox boot time decreases. Sandbox crashes don't kill the agent; they just make tool calls fail temporarily until the sandbox recovers.

**Testing becomes trivial.** The engine is a TypeScript library with injected interfaces. Test it with InMemorySessionStore, VirtualSandbox (just-bash), and InMemoryEventStream. No containers, no DOs, no network. Full integration tests run in milliseconds.

## Architecture

### Three Layers

**1. Engine (`packages/engine/`)** — Portable TypeScript library, zero platform dependencies. Owns the agent loop, session/thread state, tool execution, prompt queuing, compaction, model failover, event emission, roles, and skills.

**2. Provider interfaces** — Contracts defined by the engine, implemented per-platform. Five interfaces: SessionStore, SandboxProvider, EventStream, BlobStore, CredentialStore.

**3. Platform adapters (`packages/adapter-cloudflare/`, `packages/adapter-k8s/`)** — Thin packages (~200-400 lines each) that implement the provider interfaces for a specific deployment target and host the engine process.

```
┌─────────────────────────────────────────────────────┐
│              packages/engine/                        │
│                                                      │
│  ┌───────────┐ ┌──────────┐ ┌───────────────┐      │
│  │ AgentLoop │ │ Session  │ │ ToolRegistry  │      │
│  │(pi-agent- │ │ Manager  │ │               │      │
│  │ core)     │ │          │ │               │      │
│  └─────┬─────┘ └────┬─────┘ └───────┬───────┘      │
│        │             │               │               │
│  ┌─────▼─────────────▼───────────────▼───────────┐  │
│  │            Provider Interfaces                 │  │
│  │  SessionStore | SandboxProvider | EventStream     │  │
│  │  BlobStore    | CredentialStore                │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │                    │
┌────────▼────────┐  ┌───────▼─────────┐
│ adapter-cf/     │  │ adapter-k8s/    │
│ D1, DO, R2,     │  │ PG, Redis, S3,  │
│ Modal           │  │ Modal/K8s Pods  │
└─────────────────┘  └─────────────────┘
```

### Package Structure

```
packages/
  engine/                  ← portable core (agent loop, tools, interfaces, schema)
    src/
      schema/              ← Drizzle schema definitions (source of truth)
      tools/               ← built-in tool implementations
      session.ts           ← session management
      thread.ts            ← thread lifecycle, cross-visibility
      queue.ts             ← per-thread prompt queue
      agent-loop.ts        ← pi-agent-core wrapper
      compaction.ts        ← context compression
      events.ts            ← typed event system
      roles.ts             ← role loading and resolution
      skills.ts            ← skill discovery and invocation
      result.ts            ← structured result extraction
      types.ts             ← all public types and interfaces
    migrations/
      sqlite/              ← generated by drizzle-kit for D1
      postgresql/          ← generated by drizzle-kit for PG
  api/                     ← shared Hono route handlers, parameterized by store impls
  adapter-cloudflare/      ← CF-specific wiring (DO host, D1/R2/DO providers)
  adapter-k8s/             ← K8s-specific wiring (session pool, PG/Redis/S3 providers)
```

## V1 Completeness Contract

V1 is complete when the engine can replace OpenCode, the Runner, and the SessionAgentDO orchestration path for normal interactive sessions on the Cloudflare adapter, while preserving the product-facing API/event behavior required by the web client and Slack reference transport.

The V1 implementation must define and implement these contracts:

| Contract | Owner | Required for V1 |
|---|---|---|
| Engine public API | `packages/engine` | Session creation/restoration, thread lookup, prompt submission, abort/pause/resume, decision resolution, event subscription |
| Session/thread/message model | `packages/engine` | DAG entries, thread metadata, queue state, compaction entries, decision gate entries, suspended turn checkpoints |
| Agent loop contract | `packages/engine` | pi-agent-core integration, model resolution, tool execution, failover, abort propagation, structured results |
| Tool contract | `packages/engine` + plugin packages | Built-in tools, plugin `ToolDef`s, command tools, action-policy wrapping, attachment handling |
| Decision gate contract | `packages/engine` + adapters | Approval, question, and credential-request gates, delivery refs, resolution, expiry, withdrawal, restart-safe resume |
| Durable submission contract | `packages/engine` | Idempotent admission, claim/lease lifecycle, attempt markers, reconciliation decision tree, two-phase settlement, terminalization |
| Signal ingress contract | `packages/engine` + adapters | `SignalContent` admission, XML envelope rendering, dispatchId idempotency |
| Workflow caller contract | `packages/engine` + adapters | Idempotent session creation, durable submission ids, `awaitResult`, settled events, unified transcript read, dual-target approvals |
| Application service hooks | `packages/engine` | Per-session `toolConfig`, ordered `systemContext` injection, compaction hooks, thread identity in ToolContext |
| Compaction contract | `packages/engine` | Pruning, LLM compaction, tail preservation, `CompactionEntry` persistence, auto-continue, compaction hooks |
| Model registry contract | `packages/engine` + adapters | Provider registration, model resolution order, failover authorization boundary |
| Roles/skills contract | `packages/engine` | Role overlays and precedence, skill discovery and invocation, load-error semantics |
| Provider contracts | adapters | SessionStore, SandboxProvider, EventStream, BlobStore, CredentialStore |
| Sandbox RPC contract | sandbox runtime + adapters | File operations, process execution, snapshots, tunnels, health, auth, request limits |
| Sandbox attachment contract | `packages/engine` + providers | Lazy attachment, capabilities, provider registry, `sandbox_status` events, cold-attachment model hint, workspace survival |
| Channel transport contract | SDK + adapters | Outbound messages, decision gate delivery/update, inbound action parsing, free-text gate resolution |
| API route contract | `packages/api` + adapters | Shared session/thread/prompt/history/decision/control routes |
| Client event contract | adapters | WebSocket/SSE event names and payloads for web UI consumption |
| Schema/migration contract | `packages/engine` | Drizzle schema (clean-slate, no legacy compatibility), SQLite and PostgreSQL migrations, schema version stamping |
| Observability contract | `packages/engine` + adapters | Audit events, analytics events, logs, status events, recoverable vs fatal errors |

### V1 Exclusions

The following are explicitly post-V1 unless needed to preserve an existing production workflow:

- User-facing branch/replay controls beyond preserving DAG metadata.
- Kubernetes production deployment. The contract must exist, but Cloudflare is the V1 shipping adapter.
- Rewriting every plugin package by hand. V1 may use an `ActionSource` to `ToolDef` bridge.
- Replacing workflow execution internals. The workflow interpreter stays on its durable substrate and consumes the engine through the Workflow Caller Contract; migrating its polling and memoized-prompt patterns onto `awaitResult` and durable submission ids is the integration work, not a rewrite of the interpreter.
- Importers for legacy state beyond memory bundles. Export/import is the transfer model (see Clean-Slate Schema); additional importers ship on demand, never dual-schema bridges.

## Engine Public API

The engine is a library. Platform adapters host it and expose HTTP/WebSocket entrypoints, but all session execution flows through this API.

```typescript
interface Engine {
  createSession(opts: CreateSessionOptions): Promise<SessionHandle>;
  restoreSession(opts: RestoreSessionOptions): Promise<SessionHandle>;
  getSession(sessionId: string): Promise<SessionHandle | null>;
  deleteSession(sessionId: string): Promise<void>;
  onEvent(listener: (event: BusEvent) => void): Unsubscribe;
}

interface RestoreSessionOptions {
  sessionId: string;
  // Same shape as CreateSessionOptions minus `id` — the caller re-supplies
  // tools, sandbox, model, system prompt, etc. The engine does not maintain
  // a registry of session-creation options across restarts; the host (DO,
  // pod, CLI) is responsible for reconstructing them from its own config.
  options: Omit<CreateSessionOptions, 'id'>;
}

interface CreateSessionOptions {
  id?: string;
  /** Owning principal. Defaults to user:{userId}. Children inherit the parent's owner. */
  owner?: Principal;
  /** Actor: the human whose action created the session (attribution, not access). */
  userId: string;
  orgId: string;
  workspace: string;
  purpose?: 'interactive' | 'orchestrator' | 'workflow' | 'child';
  parentSessionId?: string;
  parentThreadId?: string;
  sandbox: Sandbox | SandboxCreateOpts;
  tools?: ToolDef[];
  commandTools?: CommandToolDef[];
  roles?: RoleSpec[];
  skills?: SkillSource[];
  model: string;
  modelFailover?: string[];
  queueMode?: QueueMode;
  /**
   * Ordered system-context fragments injected after the base system prompt
   * and role overlays. Application services use this to inject session-start
   * context (e.g. the orchestrator's memory snapshot) with a stable position.
   */
  systemContext?: Array<{ name: string; content: string; order?: number }>;
  /**
   * Per-session tool configuration injected by the adapter and surfaced to
   * every tool via ToolContext.config: service endpoints, API base URLs,
   * feature flags. Tools must receive endpoints through this config, never
   * assume loopback addresses or read ambient process env — tool code runs
   * in the engine host, not the sandbox.
   */
  toolConfig?: Record<string, unknown>;
  /** Compaction lifecycle hooks (see Compaction hooks). Run in order; failures never block compaction. */
  compactionHooks?: CompactionHook[];
  metadata?: Record<string, unknown>;
}

interface SessionHandle {
  id: string;
  thread(key?: string): ThreadHandle;
  threadById(id: string): ThreadHandle | null;
  prompt(content: PromptContent, opts?: PromptOptions): Promise<PromptReceipt>;
  resolveDecision(gateId: string, resolution: DecisionResolution): Promise<void>;
  withdrawDecision(gateId: string, reason: DecisionWithdrawReason): Promise<void>;
  abort(opts?: { threadId?: string }): Promise<void>;
  pause(opts?: { threadId?: string }): Promise<void>;
  resume(opts?: { threadId?: string }): Promise<void>;
  snapshot(): Promise<string>;
  destroy(): Promise<void>;
}

interface ThreadHandle {
  id: string;
  prompt(content: PromptContent, opts?: PromptOptions): Promise<PromptReceipt>;
  /** Durably await a submission's terminal result. Resumable across caller restarts. */
  awaitResult(queueItemId: string, opts?: AwaitResultOptions): Promise<SubmissionResult>;
  skill(name: string, opts?: SkillInvokeOptions): Promise<PromptReceipt>;
  shell(command: string, opts?: ExecOpts): Promise<ExecResult>;
  readThread(key: string, opts?: MessageQuery): Promise<SessionEntry[]>;
  abort(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

type QueueMode = 'followup' | 'steer' | 'collect';

type PromptContent =
  | string
  | {
      text?: string;
      attachments?: PromptAttachment[];
    }
  | SignalContent;

/**
 * A signal is an event the agent observes rather than a direct user→assistant
 * message: a Slack thread reply, a GitHub issue comment, a webhook, a timer.
 * External conversations are multi-party — the agent participates as one
 * member — so sender identity and event metadata travel as flat string
 * attributes, not as the message author.
 */
interface SignalContent {
  kind: 'signal';
  /** Namespaced event type, e.g. 'slack.message', 'github.issue_comment', 'schedule.tick'. */
  signalType: string;
  /** The event's text payload. Always a plain string; JSON-stringify structured payloads. */
  body: string;
  /** Flat, string-valued metadata: sender, external ids, timestamps, permalinks. */
  attributes?: Record<string, string>;
  /** XML envelope tag for model rendering. Must match /^[A-Za-z_][A-Za-z0-9_.-]*$/; defaults to 'signal'. */
  tagName?: string;
}

interface PromptOptions {
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  queueMode?: QueueMode;
  model?: string;
  role?: string;
  resultSchema?: TSchema;
  /**
   * Idempotent admission key, typically the provider's stable event id
   * (Slack event_id, Telegram update_id). Re-submitting the same dispatchId
   * with the same payload returns the original receipt; the same dispatchId
   * with a different payload returns a conflict error. Required for
   * at-least-once webhook delivery to be safe.
   */
  dispatchId?: string;
  metadata?: Record<string, unknown>;
}

interface PromptAuthor {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  externalId?: string;
}

type PromptAttachment =
  | { type: 'image'; url?: string; data?: Uint8Array; mimeType: string; name?: string }
  | { type: 'file'; url?: string; data?: Uint8Array; mimeType: string; name: string }
  | { type: 'audio'; url?: string; data?: Uint8Array; mimeType: string; name?: string };

interface PromptReceipt {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  status: 'queued' | 'running' | 'blocked_on_decision_gate';
}
```

Prompt submission is **fire-and-forget**: `prompt()` resolves when the submission is durably admitted, not when the model finishes. Results are observed through the event stream and the message history API.

Callers that need a final answer (workflow steps, `task` tools) use `thread.awaitResult(queueItemId)` — a **derived** observation primitive built on the event stream and submission settlement, not a change to admission semantics. It is resumable by construction: because the submission id and its terminal outcome are durable, `awaitResult` can be called again after a caller restart with the same `queueItemId`; a settled submission returns its result immediately from the store, an unsettled one subscribes to the stream. This replaces poll-until-idle loops entirely.

```typescript
interface AwaitResultOptions {
  timeoutMs?: number;
  resultSchema?: TSchema;   // validate/repair structured output from the final assistant message
  signal?: AbortSignal;
}

interface SubmissionResult {
  queueItemId: string;
  outcome: 'completed' | 'failed' | 'aborted' | 'superseded' | 'merged';
  /** Final assistant message text for the turn(s) this submission drove. */
  text?: string;
  /** Present when resultSchema was supplied: validated structured output. */
  output?: unknown;
  error?: string;
}
```

**Result ownership:** every turn — including compaction auto-continue turns and post-gate-replay continuation turns — belongs to the submission whose queue item was active when the turn started, and every entry that turn produces carries that submission's `queueItemId` (see `BaseEntry.queueItemId`). `SubmissionResult.text` is the content of the last persisted assistant entry carrying this submission's `queueItemId` with `stopReason: 'end_turn'` — the transcript linkage is the mechanism, not a heuristic. Outcome `superseded` returns whatever partial assistant output persisted under the submission's `queueItemId` together with the outcome, so callers can distinguish a replaced turn from a completed one. Outcome `merged` delegates: `awaitResult` on a constituent of a collect-window merge resolves with the merged item's result (see Collect semantics).

**Signal rendering:** signals are persisted as `MessageEntry` rows with `signal` metadata and rendered into LLM context as an XML envelope — `signalType` and each `attributes` entry become XML attributes, `body` is XML-escaped text content, `tagName` is the element name. `tagName` is regex-validated because it renders unescaped; `body` and attribute values are always escaped. Direct user prompts render as ordinary user messages.

**Internal signal admission (engine-stamped identity):** when a signal is admitted on behalf of another session (child settlement, cross-orchestrator messaging, workflow dispatch) rather than a verified channel webhook, the engine stamps the envelope with the sender's verified identity — `senderSessionId` and the sender's owner `Principal` — from the authenticated call context. Attributes may carry display context but can never override the stamped identity. The engine also maintains a `hopCount` on the envelope, incremented at each cross-orchestrator admission; admission is rejected when it exceeds the configured budget (the application layer sets the budget and the allowed sender→recipient edges — see the orchestrator spec's signal-authorization contract). Internal-signal `dispatchId`s are namespaced by the stamped sender session ID so senders cannot collide with or replay one another's ids.

```typescript
interface MessageQuery {
  limit?: number;
  cursor?: string;
  afterEntryId?: string;
  beforeEntryId?: string;
  includeCompacted?: boolean;
  includeSystemEntries?: boolean;
}

interface ListOpts {
  limit?: number;
  cursor?: string;
  status?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}
```

The API is idempotent where identifiers are supplied by the caller. `createSession({ id })` must return the existing session if it has already been created with the same ID and compatible immutable fields. `resolveDecision()` must be safe to retry: resolving an already resolved gate with the same resolution is a no-op; resolving it with a different resolution returns a conflict error.

`TSchema` refers to the TypeBox schema type used by pi-ai for structured parameters and results. API-layer adapters must serialize schemas as JSON Schema and preserve the original TypeScript type only inside package boundaries.

## Data Model: Sessions, Threads, and Messages

### Hierarchy

```
Session (sandbox, tools, roles, config)
  ├── Thread 'web:default'     ─── Messages (DAG)
  ├── Thread 'slack:C123'      ─── Messages (DAG)
  ├── Thread 'task:research'   ─── Messages (DAG)
  │
  │     Threads can read from siblings (cross-thread visibility).
  │     Threads execute concurrently (independent queues).
  │
  └── Child Session (own or shared sandbox)
        ├── Thread 'default'   ─── Messages (DAG)
        │     Can read from parent threads.
        └── Parent can read child thread summaries.
```

### Session

A session owns a sandbox instance, registered tools, roles, and configuration. It is the container for all agent work.

- Created via the engine's API: `engine.createSession(opts)`
- Has a unique ID, a sandbox, a set of tools, optional roles and skills
- Can spawn child sessions (single-threaded or multi-threaded)
- Owns shared decision state used by its threads: pending decision gates, credentials, and child-session registry
- Session-wide controls: `abort()` aborts all threads, `pause()`/`resume()` freeze/unfreeze all thread queues
- Deleting a session cascade-terminates its children: sessions of purpose `child` whose parent is deleted are aborted, settled, and their sandboxes destroyed

### Thread

A named conversation within a session. Each thread has its own message history (DAG-based), its own prompt queue, its own compaction state, and its own active model. Threads share the sandbox, tools, and roles from the parent session.

- Created or retrieved via `session.thread(key)`; calling `thread(key)` on an archived thread reactivates it. `session.threadById(id)` looks a thread up by its durable id (e.g. a workflow's parked `threadId`), returning null when it doesn't exist.
- `session.prompt()` is sugar for `session.thread('default').prompt()`
- Each channel target naturally maps to a thread key: `web:default`, `slack:C123`, `telegram:456`, `thread:<orchestratorThreadId>`
- Threads can also be created explicitly for focused work: `task:research`, `review:pr-42`

**Channel-aware thread identity:** A thread is the engine's concurrency and history boundary. Channel metadata is attached to prompts and messages, but channel transports do not define execution boundaries on their own. Multiple external channel targets may point at the same logical thread when the application intentionally converges them (for example, a Slack thread and the web UI both steering the same orchestrator thread).

**Cross-thread visibility:** Threads can read messages from sibling threads via a built-in `thread_read` tool. The LLM can pull in context from another thread when it needs it, without paying the token cost of having it in context permanently. Cross-visibility also works across the session boundary: child session threads can read from parent threads, and parent threads can read child thread summaries.

The reachability graph is closed and authorized at call time: a thread may read (a) sibling threads in its own session, (b) threads of its session's direct parent, and (c) threads of its session's direct children — nothing else. Each cross-session read re-checks the caller session's owner principal against the target session's access control at call time (the same per-query rule as memory scoping), so an arbitrary or prompt-injected session key never grants access, and membership loss cuts visibility immediately.

**Thread controls:**
- `thread.prompt(text, opts)` — submit a prompt
- `thread.abort()` — abort current prompt, clear this thread's queue
- `thread.pause()` / `thread.resume()` — freeze/unfreeze this thread's queue
- `thread.skill(name, opts)` — invoke a named skill
- `thread.shell(command)` — execute a shell command (recorded in history)
- `thread.readThread(key)` — read messages from a sibling thread

### Messages

Messages within a thread form a DAG (directed acyclic graph). Each message entry has a `parentId` pointing to its predecessor, enabling branching and replay.

**Entry types:**
- `MessageEntry` — LLM or engine-authored messages (user, assistant, toolResult, system) with content, attachments, and source metadata
- `DecisionGateEntry` — a persisted decision point in the conversation DAG, including its status and any eventual resolution
- `CompactionEntry` — summarized context checkpoint inserted by the compaction system
- `BranchSummaryEntry` — summary of a branched conversation

```typescript
interface BaseEntry {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  /**
   * The durable submission that produced this entry. Set on every entry an
   * active submission writes (user prompt rendering, assistant output, tool
   * results, gates, compaction entries created inside a turn). This is the
   * transcript↔submission linkage that reconciliation and awaitResult
   * compute from; it is not optional decoration for turn-produced entries.
   */
  queueItemId?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

interface MessageEntry extends BaseEntry {
  type: 'message';
  role: 'user' | 'assistant' | 'tool' | 'system';
  /**
   * Persisted on the final assistant entry of a turn. 'end_turn' marks the
   * turn's terminal assistant entry — the marker reconciliation step 1 and
   * SubmissionResult.text resolution key off.
   */
  stopReason?: 'end_turn' | 'error' | 'abort';
  content: string;
  parts?: MessagePart[];
  author?: PromptAuthor;
  channel?: ChannelTarget;
  /** Present when this entry was admitted as a signal rather than a direct user prompt. */
  signal?: {
    signalType: string;
    attributes?: Record<string, string>;
    tagName?: string;
    dispatchId?: string;
  };
  model?: string;
}

type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; callId: string; toolName: string; status: 'running' | 'completed' | 'error'; args?: unknown; result?: unknown; error?: string }
  | { type: 'attachment'; attachment: ToolAttachment }
  | { type: 'error'; message: string; code?: string };

interface CompactionEntry extends BaseEntry {
  type: 'compaction';
  summary: string;
  coveredEntryIds: string[];
  tokenCountBefore: number;
  tokenCountAfter: number;
  fileContext?: {
    read: string[];
    modified: string[];
  };
}

interface BranchSummaryEntry extends BaseEntry {
  type: 'branch_summary';
  branchRootId: string;
  branchLeafId: string;
  summary: string;
}
```

The active conversation path is reconstructed by following `parentId` pointers from the leaf back to the root. Compaction inserts a summary without rewriting history.

**LLM-faithful entry persistence (rehydration contract):** the engine must persist enough information in `MessageEntry.parts` to reconstruct LLM-compatible content blocks on restore. Specifically:

- An assistant entry that issued tool calls MUST persist one `MessagePart` of type `tool_call` per call, with `callId`, `toolName`, and `args`. Without this, a restored transcript would show the assistant's text but lose the tool calls, producing a malformed `[user, assistant(text), toolResult]` sequence that LLM providers reject.
- A tool-result entry (role `tool`) MUST persist `callId` so the LLM provider can match it to the assistant's tool call.
- Thinking content, if recorded at all, persists with provider-specific signatures intact when available, so cross-provider handoff and replay produce valid context.

`MessageEntry.content` is the human-readable text rendering; `MessageEntry.parts` is the structured source of truth used during rehydration.

**Suspension history rules:** Decision-gated turns are represented in the DAG by a first-class `DecisionGateEntry`, not by synthetic system messages. The entry is created when the gate is opened and then updated in place as it moves through `pending`, `resolved`, `expired`, or `withdrawn` states. This keeps the history model explicit and replayable: gates are decision artifacts, not conversation utterances.

**V1 branching stance:** The storage model remains DAG-based so future replay and alternate branches are possible without schema redesign, but V1 does not require exposing full user-facing branch/replay controls in the API. V1 must preserve enough metadata for later branching support without forcing branching UX to ship in the first implementation batch.

## Engine Internals

### Agent Loop

The engine uses `@mariozechner/pi-agent-core` for the inner agent loop and `@mariozechner/pi-ai` for the LLM provider layer. The engine wraps these with session/thread management, tool context injection, and event routing.

**Per-thread agent instance:** Each thread gets its own `Agent` instance (from pi-agent-core). The agent manages the LLM streaming, parallel tool execution, and turn lifecycle. The engine subscribes to the agent's events and translates them to `EngineEvent` emissions.

**Loop flow:**

```
prompt received on thread
  → compose context (system prompt + thread history + role instructions)
  → build tool list (built-in + custom, with ToolContext injection)
  → create/update Agent instance with context and tools
  → agent runs: call LLM (streaming via pi-ai)
  → for each tool call in response:
      → execute tool via ToolDef.execute(args, ctx)
      → if tool requests a decision gate:
          → persist DecisionGate + SuspendedTurnState
          → append DecisionGateEntry(status='pending') to the DAG
          → emit decision_gate event
          → stop only this thread's active turn
      → when a decision gate is resolved:
          → update the existing DecisionGateEntry with resolution metadata and status='resolved'
          → reconstruct the suspended turn from persisted state
          → re-run the suspended tool/turn from the checkpoint
      → when a decision gate expires or is withdrawn:
          → update the existing DecisionGateEntry with status='expired' or status='withdrawn'
          → fail or cancel the suspended turn
      → if tool returns attachments, handle per type:
          → image attachments → route to LLM as vision content
          → text attachments → include inline in tool result
          → file attachments → store via BlobStore, reference in history
      → append tool result to thread history
  → if LLM wants to continue (more tool calls): loop
  → if LLM emits end_turn: done
  → check compaction threshold, compact if needed
  → persist thread state via SessionStore
  → emit events throughout
```

### LLM Provider Layer

The engine adopts `@mariozechner/pi-ai` for model abstraction. pi-ai provides a unified streaming interface across 20+ providers (Anthropic, OpenAI, Google, Mistral, Bedrock, etc.), typed streaming events, tool type definitions, vision support detection, context serialization, and cross-provider handoffs.

The engine adopts `@mariozechner/pi-agent-core` for the inner agent loop. pi-agent-core provides the `Agent` class that handles the LLM streaming, parallel tool execution, abort handling, and event emission cycle.

**What pi-ai gives us:**
- Model discovery and provider configuration (`getModel('anthropic', 'claude-sonnet-4-6')`)
- Streaming with typed events (`text_delta`, `toolcall_start/delta/end`, `thinking_start/delta/end`)
- Token and cost tracking per call
- Context serialization for persistence
- Cross-provider context handoffs (enables model failover with automatic thinking-to-text conversion)
- Faux provider for deterministic testing (`registerFauxProvider()`)

**What pi-agent-core gives us:**
- The `Agent` class: prompt → LLM → tool calls → execute → feed results → loop until end_turn
- Parallel tool execution (`toolExecution: 'parallel'`)
- Typed event subscription (`agent_start`, `message_update`, `tool_execution_start/end`, `turn_end`)
- Abort signal propagation
- State management (messages, model, tools)

**What the engine adds on top:**
- Sessions and threads (pi-agent-core has no concept of persistence or multi-conversation)
- Per-thread prompt queue with modes
- Cross-thread visibility
- Decision gates and resumable user-interaction points
- Compaction (using pi-ai's token counts to decide when, pi-ai's streaming to generate summaries)
- Tool context injection (credentials, sandbox, user identity)
- Event routing from pi-agent-core events to EngineEvent emissions
- Model failover (catch retriable errors, hand off context to next model via pi-ai)
- Structured result extraction with schema validation

**Model resolution:** Uses `provider/model` string convention (same as pi-ai and OpenRouter). Provider instances are registered at startup by the platform adapter. Model failover is configured per-session as an ordered list; on retriable errors, the engine advances to the next model and hands off the context using pi-ai's cross-provider serialization.

#### Model Registry Contract

Adapters register model providers before restoring or creating sessions.

```typescript
interface ModelRegistry {
  registerProvider(provider: ModelProviderConfig): void;
  get(model: string): Promise<ModelHandle>;
  list(opts?: { userId?: string; orgId?: string }): Promise<ModelDescriptor[]>;
}

interface ModelProviderConfig {
  id: string;
  displayName: string;
  apiKey?: string;
  baseUrl?: string;
  models?: ModelDescriptor[];
}

interface ModelDescriptor {
  id: string;              // provider/model
  providerId: string;
  modelId: string;
  displayName?: string;
  contextWindow?: number;
  outputLimit?: number;
  input: Array<'text' | 'image' | 'audio'>;
  output: Array<'text' | 'tool_call'>;
}

interface ModelHandle {
  descriptor: ModelDescriptor;
  provider: unknown;       // pi-ai provider instance, hidden behind engine package boundaries
}
```

Model selection order is prompt override, role override, thread model, session model, then platform default. Failover never crosses into a model the user or org is not authorized to use.

### Tool System

Three categories of tools, merged at prompt time:

**Built-in tools** (provided by the engine, always available):
- `read` — read file contents via SandboxProvider
- `write` — create/overwrite files via SandboxProvider
- `edit` — exact text replacement via SandboxProvider
- `bash` — shell execution via SandboxProvider
- `grep` — pattern search via SandboxProvider
- `glob` — file pattern matching via SandboxProvider
- `thread_read` — read messages from a sibling, parent, or child thread
- `task` — spawn a child session for delegated work (depth-limited)

**Plugin tools** (`ToolDef[]`, registered at session creation):
- Custom tools from plugin packages (GitHub, Slack, Linear, memory, browser, etc.)
- Each is a `{ name, description, parameters, execute }` object
- Registered per-session or per-thread (thread-level overrides session-level on name conflict)

**Command tools** (privileged CLI wrappers):
- Shell commands with injected environment variables
- Secrets are injected at the host level, never visible to the LLM
- Scoped per-prompt or per-session

```typescript
interface CommandToolDef {
  name: string;
  description: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval?: boolean;
  timeoutMs?: number;
}
```

Command tools execute through `Sandbox.exec`. The engine injects configured environment variables into the process environment and never serializes secret values into message history, tool arguments visible to the model, or events.

#### ToolDef Interface

```typescript
interface ToolDef {
  name: string;
  description: string;
  parameters: TSchema;  // TypeBox schema (pi-ai native)
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval?: boolean | ((args: Record<string, unknown>, ctx: ToolContext) => Promise<boolean> | boolean);
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
```

Tool names are globally unique within a session after registration. Built-in tools use short names (`read`, `bash`); plugin tools use service-qualified names (`github.create_pr`, `linear.create_issue`). If two tools register the same name at the same scope, session creation fails unless a thread-level override intentionally replaces a session-level tool.

#### ToolContext

Every tool execution receives a context object from the engine:

```typescript
interface ToolContext {
  // Identity
  userId: string;
  orgId: string;
  sessionId: string;
  threadId: string;
  sessionPurpose?: string;
  actor?: {
    id: string;
    name?: string;
    email?: string;
  };

  // Prompt/message routing
  channelType?: string;
  channelId?: string;
  decisionGateId?: string;
  replyChannelType?: string;
  replyChannelId?: string;

  // Repo / workspace context
  cwd?: string;
  repo?: {
    url?: string;
    branch?: string;
    ref?: string;
    provider?: string;
  };

  // Credentials
  credentials: CredentialProvider;

  // Per-session tool configuration (from CreateSessionOptions.toolConfig):
  // service endpoints, API base URLs. The replacement for sandbox-loopback
  // URLs and ambient env reads now that tools execute in the engine host.
  config?: Record<string, unknown>;

  // Sandbox (for tools that need file/shell access). A LAZY handle: the
  // attachment may still be provisioning. The first operation awaits
  // readiness (bounded by a timeout, then a structured
  // workspace_provisioning error). Tools that never touch it never wait.
  sandbox: Sandbox;

  // Structured runtime interactions
  requestDecision: (req: DecisionGateRequest) => Promise<DecisionResolution>;
  emitArtifact?: (artifact: ToolArtifact) => Promise<void>;
  /**
   * Set by the engine ONLY on a replayed tool execution after restart.
   * When `gateId` matches the deterministic ID derived from this call's
   * `req.resumeKey`, the engine returns the stored `resolution` immediately
   * instead of opening a new gate. Tools never set this themselves.
   */
  suspendedDecision?: SuspendedDecisionContext;

  // Abort
  signal: AbortSignal;
}

interface CredentialProvider {
  get(service: string): Promise<Credential | null>;
  request(service: string, reason: string): Promise<Credential>;
}

interface Credential {
  type: StoredCredential['type'];
  /** The usable secret regardless of kind: accessToken for oauth2, apiKey for api_key, the bot token for bot_token, and so on. */
  token: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

type ToolArtifact =
  | { type: 'file'; path?: string; blobKey?: string; title?: string }
  | { type: 'link'; url: string; title: string }
  | { type: 'diff'; path?: string; content: string };

interface SuspendedDecisionContext {
  gateId: string;
  resolution?: DecisionResolution;
}
```

`Credential` is a normalized shape: the CredentialProvider maps whatever `StoredCredential` kind is on file (oauth2 access token, API key, bot token, service account) into `token` — performing refresh where applicable — so tools never branch on credential kind. When a tool calls `credentials.request()` for a credential that doesn't exist, the engine pauses tool execution and emits a `decision_gate` event to the user. Execution resumes when the credential is provided. If the user does not respond before the gate expires (default 24 hours, configurable — see Decision Gates expiry defaults), the request fails and the tool receives a structured credential error. Same pattern as tool approvals.

Approval-gated tools follow the same suspension model. A tool can return or throw a structured `approval_required` signal, which the engine converts into a `DecisionGate`, persists, emits, and resumes on resolution.

**Restart-safe tool suspension contract:** The engine does not rely on preserving an in-memory JavaScript continuation across restarts. Tools that call `requestDecision(...)` must therefore be re-entrant up to their decision points. On first execution, `requestDecision(...)` persists the gate and suspends the turn. On resumed execution, the engine re-runs the tool from the start with `suspendedDecision` populated for the matching gate ID, and the same `requestDecision(...)` call returns the stored resolution instead of creating a new gate.

**What "re-entrant up to the decision point" means in practice:** any work the tool does *before* `requestDecision(...)` will run twice — once on the original execution (lost when the engine restarts), once on replay. Side effects in that prefix must be idempotent or read-only. Work *after* `requestDecision(...)` returns runs once on replay only. Tools that need to do non-idempotent work before a gate should split into two tools (one to do the work and persist a result, another to gate-and-act on it) or move the work to after the gate.

**How the engine populates `ctx.suspendedDecision`:** on `restoreSession`, for every thread whose persisted queue status is `blocked_on_decision_gate`, the engine loads the corresponding `DecisionGate` and `SuspendedTurnState`. If the gate is still `pending`, the engine re-arms its in-memory wait so a future `resolveDecision(...)` call delivers the resolution. If the gate is already `resolved` (the user resolved it while the engine was down) or becomes resolved later, the engine invokes the persisted tool by name with the persisted args, sets `ctx.suspendedDecision = { gateId, resolution }` for that one execution, and feeds the returned `ToolResult` back into the agent loop as if the original turn had completed — then calls the agent's continuation to produce the next assistant turn.

**Replay event guarantees:** the replayed tool execution does not need to emit the same per-call `tool_start` / `tool_end` event pair as the original turn (the original pair was already emitted before the engine went down). The engine MUST emit the post-replay `text_delta` / `message_end` / `turn_end` events for the continuation turn so that connected clients see the agent finish the work. Adapters re-deliver pending gates on client (re)connection through the `init` event payload.

#### Plugin Action Bridge

V1 keeps using existing plugin action packages through an adapter, but the bridge does NOT register one LLM-visible tool per action. With dozens of plugins each exporting dozens of actions, direct registration would (a) blow past LLM tool-catalog size budgets, (b) collide with provider tool-name regexes (Anthropic requires `^[a-zA-Z0-9_-]{1,128}$`, so dotted ids like `github.create_issue` are rejected), and (c) force every session to pay the prompt cost of every action even when only a few are relevant.

Instead, plugin actions are surfaced through two engine-built-in indirection tools — `list_tools` and `call_tool` — that expose a searchable catalog the agent consults on demand.

```typescript
interface ActionSource {
  listActions(ctx?: { credentials?: Record<string, string> }): ActionDefinition[] | Promise<ActionDefinition[]>;
  execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult>;
}

interface ActionDefinition {
  id: string;            // fully-qualified, e.g. "github.create_issue"
  name: string;
  description: string;
  riskLevel: RiskLevel;
  params?: unknown;        // Zod schema from current SDK packages
  inputSchema?: Record<string, unknown>;
}

interface ActionContext {
  credentials: Record<string, string>;
  userId: string;
  orgId?: string;
  callerIdentity?: { name: string; avatar?: string };
  analytics?: unknown;
  attribution?: { name: string; email: string };
  guardConfig?: Record<string, unknown>;
}

interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  images?: Array<{ data: string; mimeType: string; description: string }>;
}

interface ActionSourceConfig {
  service: string;            // routing key + default credential service
  actions: ActionSource;
  credentialService?: string; // override service for credential lookup
  defaultApprovalMode?: 'allow' | 'require_approval' | 'deny';
}

interface ActionBridgeOptions {
  sources: ActionSourceConfig[];
}

/**
 * Returns exactly two ToolDefs: `list_tools` and `call_tool`. Internally the
 * bridge holds a catalog assembled from every ActionSource passed in.
 */
function actionBridgeTools(opts: ActionBridgeOptions): Promise<ToolDef[]>;
```

`list_tools` accepts:

- `service?: string` — filter by service name.
- `query?: string` — match against action name, id, and description (case-insensitive substring).
- `limit?: number` — cap results (default 50, max 200).

It returns a structured payload: `{ service, id, name, description, riskLevel, params }` per action, plus per-service auth/availability warnings when credentials are missing or expired.

`call_tool` accepts:

- `tool_id: string` — the fully-qualified action id (e.g. `github.create_issue`).
- `params: object` — the action arguments, validated against the action's parameter schema before dispatch.
- `summary: string` — one-line human-readable description used in approval gates and audit logs.

Bridge behavior:

- Action ids stay unchanged inside the catalog and as `tool_id` arguments. Provider tool-name regexes never apply because action ids ride as string args, not tool names.
- Zod parameters are converted to TypeBox/JSON Schema at registration time and exposed verbatim through `list_tools`.
- `call_tool` validates `params` against the action's schema. Validation errors return a structured tool error, not an exception.
- `riskLevel` is reported in `list_tools` and consulted in `call_tool` to decide whether to open a `DecisionGate` (`high`/`critical` default to `require_approval` unless the per-source `defaultApprovalMode` overrides). The action's `summary` arg is the gate body.
- Credentials are resolved through `CredentialProvider` per call, scoped to the action's `credentialService`. Missing credentials surface as a structured "auth required" tool error and as a warning in subsequent `list_tools` responses.
- Action analytics events are forwarded to the engine observability sink.
- Action images are converted to `ToolAttachment` objects and handled by the engine attachment pipeline.

The bridge is a migration layer, not a permanent engine dependency. New plugins may either (a) keep emitting `ActionSource`s and let the bridge expose them, or (b) export `ToolDef[]` directly when they want to be registered as first-class engine tools (e.g. coding-loop primitives where the per-call indirection is unwanted overhead). Engine adapters compose both paths in the same session.

#### ToolResult

```typescript
type ToolResult = {
  text: string;
  attachments?: ToolAttachment[];
};

type ToolAttachment =
  | { type: 'image'; data: Uint8Array; mimeType: string; name?: string }
  | { type: 'file'; data: Uint8Array; mimeType: string; name: string }
  | { type: 'text'; content: string; name?: string; language?: string };
```

**Attachment handling by the engine:**
- `image` attachments are routed to the LLM as vision content (if the model supports it via `model.input.includes('image')`).
- `file` attachments are stored via BlobStore and referenced in the message history. Available to the LLM if requested but not injected into context automatically.
- `text` attachments are included inline in the tool result message. The `language` field enables syntax-aware formatting.

### Compaction

Token-aware context compression with two complementary techniques. When a thread approaches the model's context window, the engine **prunes** stale tool outputs cheaply (no LLM) and, if more space is needed, **compacts** older messages into a structured summary (one LLM call). The DAG is preserved verbatim — pruning marks tool-output strings as elided, compaction inserts a `CompactionEntry`. Both transformations apply only when assembling the LLM-visible context; the engine's history record never loses anything.

#### Triggers

- **Proactive (auto)** — after each turn, if `tokens.total >= usable(model, cfg)` where
  ```
  usable = contextWindow − reserved
  reserved = cfg.reserveTokens ?? min(20_000, model.maxOutputTokens)
  ```
  the engine queues a compaction pass to run before the next user turn would otherwise execute. Token usage comes from pi-ai's per-call `Usage`; we do not estimate independently in this path.
- **Reactive (overflow)** — if a turn's assistant message returns `stopReason === 'error'` and pi-ai's `isContextOverflow(message)` matches the error, the engine compacts and retries the same turn. Reactive compaction strips media attachments from history before summarizing (some overflow is media-bytes, not token-count, so dropping images can be enough on its own).

#### Tail preservation

Compaction never touches the most recent turns. A "turn" is the segment from one user message up to (but not including) the next user message, including the assistant's tool calls and tool results.

- Default keep: the last `cfg.tailTurns ?? 2` turns.
- Tail token budget: `clamp(usable * 0.25, cfg.minPreserveRecentTokens ?? 2_000, cfg.maxPreserveRecentTokens ?? 8_000)`.
- If the last `tailTurns` turns exceed the budget, the engine walks them oldest → newest and drops whole turns from the head of that window until the rest fits. If a single turn alone exceeds the budget, the engine splits it at the first message boundary that fits, summarizing the prefix into the compaction and keeping the suffix in the tail.

#### Pruning (cheap path, no LLM)

Walk messages newest → oldest. Track cumulative tool-output token estimate. Once the cumulative count exceeds `cfg.pruneProtectTokens ?? 40_000`, mark every older `tool_call`-result text as `elided`. Skip protected tools (the engine ships with `skill` and `thread_read` protected by default; per-tool opt-in via `ToolDef.protectedFromPruning`).

The DAG entry is updated in place via `SessionStore.updateEntry` — `MessagePart` of type `tool_call` keeps `callId`, `toolName`, `args`, and `status`, but its `result` field is replaced with a placeholder `{ elided: true, reason: 'pruned' }` and `elided: true` is set on the part. LLM-context assembly skips elided results. The persistence is atomic per entry, not per part: the entire `MessageEntry` row is rewritten with the same id. Pruning only commits if it'd save at least `cfg.pruneMinimumTokens ?? 20_000` tokens; otherwise it's a no-op.

Pruning runs before compaction on the proactive path. Often pruning alone is enough.

#### Compaction (LLM path)

When pruning isn't enough (or after `cfg.pruneMinimumTokens` worth of tool output has already been elided), the engine summarizes the messages before the tail.

1. Compute the cut point per the tail-preservation rules above.
2. Assemble the head: the messages before the cut, with tool outputs truncated to `cfg.toolOutputMaxChars ?? 2_000` chars and image content stripped.
3. If the thread already has a `CompactionEntry`, load its `summary` as `previousSummary`. The new summarization is iterative — the prompt asks the summarizer to *update* the prior summary with new facts rather than write a fresh one.
4. Call a summarizer model (`cfg.summarizerModel ?? sessionModel`; typically a smaller cheaper model like Haiku) with a structured-markdown prompt:
   ```
   ## Goal · ## Constraints & Preferences
   ## Progress (Done / In Progress / Blocked) · ## Key Decisions
   ## Next Steps · ## Critical Context · ## Relevant Files
   ```
   This template is required, not advisory. The summary text is the source of truth for the LLM's view of pre-cut history; using a structured form prevents the summary from drifting into prose that crowds out specific facts (paths, error strings, identifiers).
5. Persist a `CompactionEntry` in the DAG with:
   - `summary`: the markdown produced by step 4.
   - `coveredEntryIds`: every entry id from the DAG head that this summary represents.
   - `tokenCountBefore` / `tokenCountAfter`: token counts of the head before and the summary after, for observability.
   - `fileContext`: extracted paths from `read`/`write`/`edit` tool calls in the head, classified `read` vs `modified` (helps the agent re-orient on resume).
6. Emit `compaction_start` then `compaction_end` events with the entry id.

The `CompactionEntry` is positioned at the cut point in the DAG; `parentId` links it to the last covered entry. Subsequent `MessageEntry`s parent to the `CompactionEntry`. Branching/replay still works: walking from leaf via `parentId` produces a valid history, with the summary standing in for everything older.

#### Applying compaction to LLM context

The engine's `convertToLlm` pipeline (the function fed to pi-agent-core's `Agent` to translate persisted DAG entries into LLM messages) does the rewrite at request time:

1. Load DAG entries for the thread.
2. Find the most recent `CompactionEntry`. If none, pass entries through unchanged.
3. Drop every entry whose id is in the active compaction's `coveredEntryIds`.
4. Replace them with a single user message containing the summary text, framed as `<previous-context>{summary}</previous-context>`.
5. Apply pruning's elision: any kept entry's tool-call parts whose `result.elided === true` get a placeholder `[output elided to save context]` in the LLM-visible content.
6. Yield the resulting `Message[]` to the agent loop.

This is also the rehydration path on `restoreSession` — there is no separate "rebuild context after compaction" code path.

#### Auto-continue after compaction

After a successful proactive compaction (i.e., one we ran on our own initiative, not in response to the user's prompt), if the thread is mid-task the engine injects a synthetic user message before yielding back to the next queue item:

> "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

The synthetic message is tagged with `metadata: { compaction_continue: true }` so client UIs can render it differently or hide it. Reactive (overflow) compactions don't auto-continue — they just retry the original turn that triggered the overflow.

#### Compaction hooks

Application services participate in compaction through a named lifecycle hook registered per session. This is a first-class engine contract: the orchestrator's memory system depends on it to shape the summary and to mandate a post-compaction knowledge flush.

```typescript
interface CompactionHook {
  /**
   * Called before the summarizer runs. Returned fragments are appended to
   * the summarizer's context (e.g. "preserve an ## Active Work section",
   * "your first post-compaction action must be a mem_patch journal write").
   */
  beforeCompact?(ctx: CompactionHookContext): Promise<{ summarizerContext?: string[] }> | { summarizerContext?: string[] };
  /** Called after the CompactionEntry is persisted, before auto-continue. */
  afterCompact?(ctx: CompactionHookContext & { compactionEntryId: string }): Promise<void> | void;
}

interface CompactionHookContext {
  sessionId: string;
  threadId: string;
  reason: 'proactive' | 'overflow';
  tokensBefore: number;
}
```

Hooks are registered via `CreateSessionOptions` (`compactionHooks?: CompactionHook[]`) and run in registration order. Hook failures are logged and skipped — a broken hook must never block compaction, because compaction failure is context exhaustion.

#### Configuration

| Key | Default | Notes |
|---|---|---|
| `cfg.compactionEnabled` | `true` | per-thread switch |
| `cfg.reserveTokens` | `min(20_000, maxOutput)` | head-room subtracted from contextWindow |
| `cfg.tailTurns` | `2` | last N turns never touched |
| `cfg.minPreserveRecentTokens` | `2_000` | floor on tail token budget |
| `cfg.maxPreserveRecentTokens` | `8_000` | ceiling on tail token budget |
| `cfg.pruneProtectTokens` | `40_000` | recent tool-output bytes never pruned |
| `cfg.pruneMinimumTokens` | `20_000` | only commit prune if it saves ≥ this much |
| `cfg.toolOutputMaxChars` | `2_000` | when feeding head to summarizer |
| `cfg.summarizerModel` | `sessionModel` | dedicated summarizer is cheaper |
| `cfg.protectedTools` | `['skill', 'thread_read']` | per-tool opt-out from pruning; `ToolDef.protectedFromPruning` adds to this set |
| `cfg.autoContinue` | `true` | inject the auto-continue prompt after proactive compaction |

### Per-Thread Prompt Queue

Each thread owns its own prompt queue. Threads execute independently and concurrently within a session.

**Concurrency model:**
- Each thread processes one prompt at a time (serialized within a thread)
- Multiple threads can be active simultaneously (parallel across threads)
- Sandbox access is shared: concurrent file ops and shell commands from different threads hit the same filesystem
- Tool execution is thread-safe by contract: tool authors handle their own concurrency if needed

**Queue modes** (per-thread, switchable at runtime):

- **Followup** (default) — prompts queue in FIFO order. When the current prompt completes, the next one starts. If the thread is idle, the prompt executes immediately.
- **Steer** — the new prompt supersedes the in-flight prompt *and every queued item admitted before it* (all settle `superseded`), becoming the thread's new head. Superseded partial work remains in the thread history. See "Steer supersession is transactional" under Durable Execution.
- **Collect** — prompts buffer for a configurable window (default 5 seconds). Buffered prompts are **durably admitted immediately** with status `collecting` (their `dispatchId` dedup applies at admission, so webhook retries are absorbed even mid-window). When the window closes, the engine creates one merged submission referencing the constituent ids and CAS-settles each constituent with outcome `merged` pointing at it; `awaitResult` on a constituent resolves with the merged item's result. `collecting` items are not claimable and do not block FIFO head-claim. A collect window whose deadline passed while the engine was down is flushed by reconciliation.

**Prompt metadata:** Each prompt carries `threadId`, `channelType`, `channelId`, `authorId`, optional attachments, and optional model override.

**Routing semantics:** Queueing is keyed by thread, not by transport. `channelType` / `channelId` are routing metadata used for attribution, reply delivery, and decision gate resolution. They do not create extra isolation beyond the owning thread.

**Steer semantics:** `steer` supersedes work only on the targeted thread. It must not affect other active threads in the session. Partial work already emitted by superseded turns remains in history.

**Collect semantics:** `collect` buffers by thread. Adapters may additionally preserve origin-channel metadata for each buffered prompt so the merged prompt can still attribute its constituent messages correctly.

**Pending decision semantics:** When a thread is blocked on a pending decision gate, it is considered busy but interruptible. Behavior by mode:

- `followup` — new prompts queue behind the blocked turn.
- `collect` — new prompts continue buffering and later queue behind the blocked turn.
- `steer` — new prompt cancels the blocked turn and expires or withdraws the outstanding decision gate before starting immediately.

The engine must never allow an old gate resolution to resume a turn that was already superseded by `steer`. This is guaranteed durably, not just in memory: steer stamps `supersededByItemId` transactionally at admission, and the reconciliation tree settles superseded items before it ever considers gate replay.

**Persisted runtime state:** A thread with a pending decision gate remains the active processing item in queue state, but with a distinct suspended status. Thread-level queue state distinguishes `idle`, `queued`, `running`, `blocked_on_decision_gate`, and `paused`; item-level lifecycle (`queued` → `running` → `terminalizing` → `settled`, with `blocked_on_decision_gate` as a suspended running state) is defined by the durable submission contract below.

When a thread enters `blocked_on_decision_gate`, the engine persists a `SuspendedTurnState` checkpoint containing enough information to safely resume after restart:

- session ID / thread ID / active queue item ID
- current model
- active leaf message ID
- pending gate ID (derived from `gate:${sessionId}:${threadId}:${queueItemId}:${resumeKey}:${ordinal}`)
- pending tool call ID, tool name, and original tool args (used to invoke the tool by name during replay)
- the `resumeKey` the tool supplied plus the engine-assigned `ordinal` (used to recompute the gate ID on replay and confirm a match)

On restore, the engine reloads the blocked thread, reloads the decision gate, and waits for either resolution, expiry, or cancellation. Once resolved, the engine reconstructs the turn from the checkpoint and re-drives execution.

**Persistence:** Every queue item is a durable submission (see Durable Execution below). Admission, claim, progress markers, and settlement are all persisted through SessionStore, so queue state survives process restarts, host replacement, and crashes mid-turn. On engine startup, reconciliation (not blind re-dispatch) decides what happens to each unsettled submission.

**Controls:**
- `thread.abort()` — abort current prompt on this thread, clear this thread's queue
- `thread.pause()` / `thread.resume()` — freeze/unfreeze this thread's queue
- `session.abort()` — abort all threads
- `session.pause()` / `session.resume()` — freeze/unfreeze all thread queues
- Session-wide idle = all threads idle

### Durable Execution

A prompt accepted by the engine is a **submission**: a durable record with an explicit lifecycle. The submission machinery is what makes the engine safe to run on any host — a Durable Object that gets evicted, a Kubernetes pod that gets rescheduled, a process that crashes mid-tool-call. Accepted work is never lost, never silently duplicated, and never leaves the transcript in an ambiguous state.

#### Submission lifecycle

```
collecting ─┐
            ▼
queued → running → terminalizing → settled
            ↑ ↓
  blocked_on_decision_gate
```

- **collecting** — durably admitted into an open collect window. Not claimable and does not block FIFO head-claim; settles `merged` when the window closes (see Collect under queue modes).
- **queued** — durably admitted, waiting its turn in the thread's FIFO. Admission is idempotent by `dispatchId` (same id + same payload → original receipt; same id + different payload → conflict).
- **running** — claimed by exactly one engine instance via a compare-and-set transition, recording an `attemptId`, `ownerId`, and lease. Two concurrent claims for the same submission must never both succeed. Only the oldest non-superseded unsettled submission of a thread is claimable (per-thread FIFO gating); `steer` supersedes the items ahead of it rather than jumping the queue.
- **blocked_on_decision_gate** — the claimed turn is suspended on a pending gate. The claim is retained; the lease continues to renew while the process holding it is alive.
- **terminalizing** — the terminal outcome has been decided and durably reserved, but post-settlement repairs (transcript rest-state, gate withdrawal, event emission) may still be in flight.
- **settled** — terminal, with an outcome: `completed`, `failed`, `aborted`, `superseded` (replaced by a `steer` prompt), or `merged` (absorbed into a collect-window merge). The first terminal write wins; later attempts to settle differently are conflicts.

Durability parameters are per-submission with engine defaults: `maxAttempts` (default 10), `timeoutAt` (default admission + 1 hour), lease duration 30 seconds with heartbeat renewal.

#### Ownership and leases

Exactly one live engine instance owns a session at a time. How exclusivity is achieved differs by platform, but the durable claim/lease protocol is uniform so the store contract is identical:

- **Cloudflare** — the per-session Durable Object is a natural single writer; claims still record `ownerId` + lease so recovery logic is platform-independent.
- **Kubernetes** — session affinity routes requests to the owning pod as an optimization, but **leases are the correctness mechanism**. A pod claims submissions, heartbeats its leases (renew every ~10s against a 30s lease), and a replacement pod reclaims expired leases after the old owner dies. This supports restart and host-replacement recovery; it is not active-active — a session never has two live owners.

**Attempt markers** are durable evidence that an attempt started executing. A fresh marker means "this attempt may still be running — do not reconcile it as interrupted." The store exposes this to the reconciler as `hasAttemptMarker(itemId, attemptId)`, which the engine combines with the lease: an attempt counts as *live* (action `wait`) only when its marker exists **and** its lease is unexpired. Markers are deleted on clean settlement; a stale marker plus an expired lease is the signal that reconciliation may proceed.

#### Reconciliation

On engine startup, and whenever an expired lease is reclaimed, each unsettled submission passes through a fixed decision tree. Order matters and is normative:

**Startup is an ownership assertion, not a probe.** `restoreSession` establishes this instance as the session's single live owner (the platform guarantees exclusivity — DO single-writer, or pod lease affinity). So on the *startup* pass an unexpired prior lease is **not** treated as evidence of a live attempt: the previous owner is gone by contract, and the reconciler reclaims eagerly rather than waiting out the 30s lease. Correctness does not rest on that assumption being perfectly timed — the fresh attempt's fence makes any late write from a slow zombie predecessor fail (see Effect fencing), so eager takeover is always safe. On the periodic sweep (a live owner reclaiming its own expired-lease items) only already-expired-lease items reach the tree, so the same reclaim applies.

1. **Finished work settles first.** If a persisted assistant entry carries this submission's `queueItemId` with `stopReason: 'end_turn'`, settle `completed` unconditionally — retry budgets and timeouts never discard finished work. The transcript linkage is the test; there is no heuristic "looks finished" fallback.
2. **Abort wins next.** If `abortRequestedAt` is set, settle `aborted`. A crash-interrupted abort is never resurrected as a retry.
3. **Supersession.** If `supersededByItemId` is set (stamped transactionally by a `steer` admission — see below), settle `superseded`. In particular, a gate resolution arriving for a superseded submission's gate is acknowledged but never resumes it, regardless of when the crash landed.
4. **Blocked on a gate.** If the submission was `blocked_on_decision_gate` and a `SuspendedTurnState` checkpoint exists, re-arm the gate wait (or replay immediately if the gate resolved while the engine was down) per the restart-safe gate contract. **Gate-blocked submissions are exempt from `timeoutAt`** — the human-wait bound is the gate's own `expiresAt`, not the execution timeout; a submission must never fail by timeout while legitimately parked on a pending gate.
5. **Retry budget.** If `attemptCount >= maxAttempts`, settle `failed` with a retry-exhausted error.
6. **Timeout.** If now ≥ `timeoutAt`, settle `failed` with a timeout error.
7. **Otherwise, resume.** Atomically replace the attempt (CAS: new `attemptId`, incremented `attemptCount`, fresh lease) *before* appending any recovery output. Then apply the same rest-state repair as terminalization: any trailing assistant `tool_call` part with no persisted result is updated in place to `status: 'error'` with an interrupted marker — never re-executed — because LLM providers reject a context containing an unanswered tool call. Only then continue the turn from persisted history.

`abort()` stamps `abortRequestedAt` on unsettled submissions durably but is **not** itself a terminal transition — settlement always flows through the claim/reconcile path so a canonical terminal record exists even when abort races a crash.

**Steer supersession is transactional.** A `steer` admission durably, in one step: admits the steer item, stamps `supersededByItemId` on the running item *and every queued item admitted before it* on that thread, and withdraws their pending gates (reason `steer`). The steer item is thereby the oldest non-superseded unsettled item and claims under the normal FIFO rule — steer never bypasses head-claim, it *redefines the head*. Superseded items settle `superseded` through the normal settlement path.

#### Effect fencing

Leases arbitrate who may *claim*; fencing arbitrates whose *writes land*. Every store write performed inside a claimed turn, every EventStream append, and every sandbox operation carries the writing attempt's identity, and the receiving side MUST reject writes from superseded attempts:

```typescript
interface WriteFence {
  itemId: string;     // the claimed submission
  attemptId: string;  // the attempt performing the write
}
```

- `appendEntries`, `updateEntry`, `saveSuspendedTurn`/`clearSuspendedTurn`, `reserveSettlement`, and `finalizeSettlement` take a `WriteFence`; the store rejects the write with a structured stale-attempt error when the fence does not name the submission's current attempt. Admission, claim, and read methods need no fence.
- EventStream appends carry the appending attempt alongside `BusEvent.queueItemId`; a superseded attempt's append is refused. [Implementation status (Phase 3): live-execution event appends are now attempt-fenced — `EventStream.append(event, eventKey, fence?)` rejects with `StaleAttemptError` when `fence.attemptId` no longer names the item's current attempt, on both `InMemoryEventStream` (via a wired `fenceCheck`) and `SqliteEventStream` (in-transaction `engine_queue_items` check). `Thread` passes its turn fence on `message_start`, `message_update`, `message_end`, `tool_start`, `tool_end`, in-turn `status`, `turn_end`, and in-turn `error`; `Session.emit` rethrows `StaleAttemptError` for a fenced append (the zombie's stop signal) while every other append failure stays log-and-continue. Settlement and gate-lifecycle events keep their deterministic eventKeys and remain unfenced, as before.]
- Sandbox operations are fenced by the attachment epoch (sandbox runtime spec) — the policy wrapper discards results from superseded epochs.

A zombie owner — alive but slow past lease expiry, reclaimed by a successor — therefore cannot fork the transcript, double-emit events, or land stale side effects into session state: its first fenced write fails, which is its signal to stop. On Cloudflare the DO's single-writer execution makes stale writes rare in practice, but the fence is still recorded and checked so the store contract and its conformance suite are identical on every platform.

**Stuck-head alarm:** because FIFO head-claim means a crash-looping head submission blocks every queued item behind it, the engine emits an escalation-grade attention event when a submission's `attemptCount` crosses a threshold (default 3) or it remains unsettled past a wall-clock bound (default 15 minutes, gate-blocked time excluded) — routed through the application's attention router and visible on the operator submissions surface. A wedged thread must page someone before the 1-hour timeout silently fails it.

#### Terminalization

Before any submission settles on a terminal path (completion, failure, abort, supersession), the engine settles the transcript to a **deterministic rest state**:

- Any trailing assistant `tool_call` part with no persisted result is updated in place to `status: 'error'` with an explicit interrupted marker. **Interrupted tool calls are never re-executed** — a tool whose result was lost gets a visible error outcome, and the model decides whether to retry on the next turn. (The one deliberate exception is decision-gate replay, which re-runs the suspended tool under its own re-entrancy contract with deterministic gate identity.)
- Repairs use deterministic entry updates so the attempt path and the terminal path converge idempotently — running terminalization twice produces the same transcript.
- No tool call is ever left permanently unresolved in persisted history.

Settlement is two-phase: `running → terminalizing` durably reserves the exact terminal record, then `terminalizing → settled` finalizes it. A crash between the phases is repaired by re-running finalization, which is idempotent.

### Decision Gates

Decision gates are first-class engine primitives for "pause here and wait for an external human decision". Engine, adapter, SDK, API, client, and channel contracts use `DecisionGate` naming and payloads consistently.

V1 uses one unified mechanism for:

- tool approvals
- agent questions
- credential acquisition / re-authorization

This replaces ad hoc transport- or adapter-specific waiting behavior. A gate is persisted, emits events, may be delivered to external channels by the adapter, and resumes or fails the waiting operation when resolved, expired, or withdrawn.

**Gate model:**

```typescript
interface DecisionGate {
  id: string;
  sessionId: string;
  threadId: string;
  type: 'approval' | 'question' | 'credential_request';
  title: string;
  body?: string;
  actions: DecisionAction[];
  expiresAt?: number;
  status: 'pending' | 'resolved' | 'expired' | 'withdrawn';
  context?: Record<string, unknown>;
  origin?: {
    channelType?: string;
    channelId?: string;
    messageId?: string;
  };
  refs?: Array<{
    channelType: string;
    ref: DecisionGateRef;
  }>;
}

interface DecisionAction {
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

interface DecisionResolution {
  actionId?: string;
  value?: string;
  resolvedBy: string;
  resolvedAt: number;
  source?: {
    channelType?: string;
    channelId?: string;
    messageId?: string;
  };
}

type DecisionWithdrawReason = 'steer' | 'abort' | 'cancel';

interface DecisionGateRef {
  messageId: string;
  channelId: string;
  threadId?: string;
  [key: string]: unknown;
}

interface DecisionGateEntry {
  type: 'decision_gate';
  id: string;
  parentId: string | null;
  createdAt: number;
  gate: DecisionGate;
  resolvedAt?: number;
  resolution?: DecisionResolution;
  withdrawnReason?: DecisionWithdrawReason;
}
```

**Gate types:**

- `approval`: asks whether a tool or command may proceed. Required actions are `approve` and `deny` unless a custom action list is supplied.
- `question`: asks the user for an answer. May include option actions or accept free text when `actions` is empty.
- `credential_request`: asks the user to connect or re-authorize a service. Required context fields are `service`, `reason`, and optional `scopes`.

**Expiry defaults:** `credential_request` gates default `expiresAt` to 24 hours — the user may need to be reached on another channel and complete an OAuth flow, so a minutes-scale default is guaranteed failure for anyone offline. `approval` and `question` gates default to 72 hours. All defaults are configurable per gate via `expiresAt`. Expiry emits the standard `decision_gate_expired` event and fails the suspended operation with a structured error.

**Gate delivery contract:**

1. Engine creates and persists the gate with `status = 'pending'`.
2. Engine appends or updates the corresponding `DecisionGateEntry` in the thread DAG.
3. Engine publishes `decision_gate`.
4. Adapter delivers the gate to web clients and any matching channel targets.
5. Each channel delivery returns a `DecisionGateRef`; the adapter persists refs back through `SessionStore.saveDecisionGateRef`.
6. The first valid resolution wins.
7. Adapter calls `session.resolveDecision(gateId, resolution)`.
8. Engine updates gate status, updates the DAG entry, clears suspended state, and resumes or fails the blocked turn.
9. Adapter updates delivered channel messages via stored refs.

The engine must treat missing channel delivery as non-fatal. A gate that cannot be delivered externally remains visible through the web/client event stream and API.

**Execution semantics:**

- A tool or agent loop may create a gate and suspend the waiting operation.
- Suspension is scoped to the waiting thread/turn, not the whole session.
- Other threads in the same session may continue running while one thread is blocked on a gate.
- Resolution resumes the suspended operation with typed input.
- Expiry fails the suspended operation with a structured error.
- Withdrawal cancels the suspended operation without permitting later resolution to resume it.

The `DecisionGateEntry.id` should be the canonical DAG entry ID for the gate, while `DecisionGate.id` is the stable runtime identity used by transports, queue state, and suspended-turn checkpoints. In V1 these may be the same value for simplicity.

**Deterministic gate identity:** A gate created from a tool execution must use a stable ID for that suspension point within the active turn. This is what allows the engine to re-run the tool after restart and have `requestDecision(...)` match the existing persisted gate instead of creating a duplicate.

The V1 derivation is:

```
gateId = `gate:${sessionId}:${threadId}:${queueItemId}:${resumeKey}:${ordinal}`
```

`resumeKey` is **required** on `DecisionGateRequest` (not optional). Tool authors choose a key that uniquely identifies the suspension point given the tool's inputs — typically a function of the tool's args (e.g. `"github.create_pr:owner/repo:head→base"`). The `ordinal` is engine-maintained per `(queueItemId, resumeKey)`, and it is what keeps crash-replay dedup from leaking into live execution:

- **Live semantics:** a `requestDecision(...)` call whose `(resumeKey)` has no gate, or whose current gate is *pending*, uses the current ordinal (joining the pending gate). A call arriving after the current gate is **terminal** (resolved/expired/withdrawn) opens a **fresh gate with the next ordinal**. A model that retries an identical action after a denial — or after an approval — always gets a new human decision; a stored resolution is never silently reused for a genuinely new invocation.
- **Replay semantics:** `SuspendedTurnState` records the ordinal, so a replayed execution reaching the same call site recomputes the same `(resumeKey, ordinal)` and matches the SAME persisted gate — the short-circuit works exactly as before.

```typescript
interface DecisionGateRequest {
  type: 'approval' | 'question' | 'credential_request';
  title: string;
  body?: string;
  actions?: DecisionAction[];
  expiresAt?: number;
  context?: Record<string, unknown>;
  origin?: { channelType?: string; channelId?: string; messageId?: string };
  resumeKey: string; // REQUIRED for restart-safe gates
}
```

**Resolution paths:**

- explicit action selection (`approve`, `deny`, option buttons)
- free-text reply from the web UI
- free-text reply from an external channel thread when the adapter matches the stored origin target

The engine owns the gate lifecycle and persistence; adapters own delivery details for Slack, Telegram, web, etc.

**Conflict handling:**

- Resolving a non-pending gate returns `decision_gate_conflict` unless the supplied resolution exactly matches the stored resolution.
- Expiry and withdrawal are terminal states.
- A `steer` prompt on the same thread withdraws pending gates created by the superseded turn with reason `steer`.
- `thread.abort()` withdraws pending gates on that thread with reason `abort`.
- `session.abort()` withdraws all pending gates in the session with reason `abort`.
- Resolutions received after withdrawal or expiry must be acknowledged to the transport but must not resume execution.

### Roles and Skills

**Roles** — Markdown files with optional YAML frontmatter (`name`, `description`, `model`). Applied as system prompt overlays. Precedence: prompt-level > thread-level > session-level. If a role declares a `model`, it overrides the session's default model for that prompt.

**Skills** — Markdown files discovered from the sandbox filesystem or a configured directory. Invoked explicitly via `thread.skill(name, { args })`. The skill's instructions become a focused prompt with the given arguments. Skill files use frontmatter (`name`, `description`) and support `{{variable}}` template syntax for argument injection.

Both are loaded at runtime, not baked into the engine build.

```typescript
interface RoleSpec {
  name: string;
  description?: string;
  model?: string;
  content: string;
  source?: 'session' | 'thread' | 'prompt' | 'plugin' | 'sandbox';
}

interface SkillSource {
  name: string;
  description?: string;
  content: string;
  argsSchema?: TSchema;
  source?: 'plugin' | 'sandbox' | 'repo' | 'user';
}

interface SkillInvokeOptions {
  args?: Record<string, unknown>;
  model?: string;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  resultSchema?: TSchema;
}
```

Role and skill loading errors are non-fatal at session creation only when the source is optional. Prompt-level role or skill resolution errors fail the prompt before model invocation.

### Event System

The engine emits typed events through a callback. Platform adapters subscribe and relay events to clients via their transport (WebSocket, SSE, etc.).

```typescript
type EngineEvent =
  | { type: 'message_start'; threadId: string; messageId: string; role: 'assistant' | 'system' }
  | { type: 'text_delta'; threadId: string; text: string }
  | { type: 'message_update'; threadId: string; messageId: string; parts: MessagePart[]; content?: string }
  | { type: 'message_end'; threadId: string; messageId: string; reason: 'end_turn' | 'error' | 'abort' }
  | { type: 'tool_start'; threadId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_end'; threadId: string; tool: string; result: string; isError: boolean }
  | { type: 'turn_end'; threadId: string; reason: 'end_turn' | 'error' | 'abort' }
  | { type: 'thread_start'; threadId: string; parentThreadId?: string }
  | { type: 'queue_state'; threadId: string; state: QueueState }
  | { type: 'compaction_start' | 'compaction_end'; threadId: string }
  | { type: 'task_start' | 'task_end'; childSessionId: string; threadId: string }
  | { type: 'status'; threadId: string; status: 'idle' | 'queued' | 'thinking' | 'tool_calling' | 'streaming' | 'blocked_on_decision_gate' }
  | { type: 'sandbox_status'; sandboxId?: string; state: 'provisioning' | 'ready' | 'idle' | 'snapshotting' | 'released' | 'error'; estimateMs?: number }
  | { type: 'error'; threadId?: string; code: string; error: string; recoverable: boolean }
  | { type: 'decision_gate'; threadId: string; gate: DecisionGate }
  | { type: 'decision_gate_resolved'; threadId: string; gateId: string; resolution: DecisionResolution }
  | { type: 'decision_gate_expired'; threadId: string; gateId: string }
  | { type: 'decision_gate_withdrawn'; threadId: string; gateId: string; reason: 'steer' | 'abort' | 'cancel' }
  | { type: 'model_switched'; threadId: string; fromModel: string; toModel: string; reason: string }
```

The engine does not know about WebSockets, SSE, or any transport. It emits events; the adapter decides delivery.

Durable emission is the engine's own job: the engine appends events to the EventStream itself, with idempotent eventKeys (see EventStream). `Engine.onEvent` is an in-process tap invoked AFTER the durable append, for host-local concerns — client fan-out, metrics, logging. Adapters MUST NOT append engine events to the stream themselves; a second appender would double-emit and break eventKey idempotency.

### Client Event Contract

Clients consume decision-gate events directly. Adapters may deliver these events over WebSocket or SSE, but payloads are identical.

```typescript
type ClientEvent =
  | { type: 'init'; session: SessionData; threads: ThreadData[]; queue: QueueState[]; pendingDecisionGates: DecisionGate[] }
  | { type: 'message'; sessionId: string; threadId: string; entry: MessageEntry }
  | { type: 'message.updated'; sessionId: string; threadId: string; entryId: string; patch: Partial<MessageEntry> }
  | { type: 'chunk'; sessionId: string; threadId: string; messageId: string; content: string }
  | { type: 'agentStatus'; sessionId: string; threadId: string; status: EngineEventStatus; detail?: string }
  | { type: 'queue.state'; sessionId: string; threadId: string; queue: QueueState }
  | { type: 'decision_gate'; sessionId: string; threadId: string; gate: DecisionGate }
  | { type: 'decision_gate_resolved'; sessionId: string; threadId: string; gateId: string; resolution: DecisionResolution }
  | { type: 'decision_gate_expired'; sessionId: string; threadId: string; gateId: string }
  | { type: 'decision_gate_withdrawn'; sessionId: string; threadId: string; gateId: string; reason: DecisionWithdrawReason }
  | { type: 'error'; sessionId?: string; threadId?: string; code: string; message: string; recoverable: boolean };

type EngineEventStatus =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'tool_calling'
  | 'streaming'
  | 'blocked_on_decision_gate'
  | 'error';
```

Clients resolve a gate by calling the decision API route, not by sending transport-specific answer messages:

```http
POST /api/sessions/:sessionId/decision-gates/:gateId/resolve
POST /api/sessions/:sessionId/decision-gates/:gateId/withdraw
```

Adapters must include all pending decision gates in the initial connection payload so reconnecting clients can render outstanding approvals, questions, and credential requests without waiting for a replayed event.

**Offset-based resume:** every delivered *durable* client event carries the durable stream `offset`. On (re)connect, a client supplies its last seen offset; the adapter replays durable events from that offset via `EventStream.read` and then switches to live delivery, deduplicating by offset at the boundary. A client with no offset receives `init` (metadata-only) and loads message history through the REST API. Live-only delta events carry **no offset** and are never replayed — the persisted entries are their durable record, and clients must not advance their resume offset on a delta.

### Structured Results

Optional schema-validated output extraction. Any prompt or skill invocation can pass a result schema (Valibot or TypeBox). The engine instructs the LLM to emit a result in a delimited block, extracts it, and validates against the schema.

- Delimiters: `---RESULT_START---` and `---RESULT_END---`
- If validation fails and no delimiters found: auto-retry with a follow-up prompt
- Returns typed data matching the schema

### Workflow Caller Contract

Workflow execution (definition format, DAG interpretation, triggers, version history) lives outside the engine. Its portable execution substrate — a checkpointed interpreter over a minimal `RunHost` port — is specified in [`docs/specs/2026-07-11-workflow-run-host-design.md`](2026-07-11-workflow-run-host-design.md). The engine's obligation is the primitive set workflow steps consume, and it must be identical on both platforms:

1. **Session creation** — `engine.createSession(...)` with `purpose: 'workflow'` and caller-supplied `id` for idempotent creation under step replay.
2. **Durable prompt submission** — `thread.prompt(...)` returning a durable `queueItemId`. Idempotency comes from the submission contract (`dispatchId` derived from `workflow:{runId}:{nodeId}[:{iteration}]`), not from workflow-step memoization. A replayed step re-submits with the same dispatchId and receives the original receipt.
3. **Result-await** — `thread.awaitResult(queueItemId, { resultSchema })`. Replaces poll-until-idle loops: no status polling, no backoff tuning against step budgets, no divergent DO-vs-database transcript read paths. After a workflow instance hibernates and replays, it re-awaits the same submission id and gets the settled result.
4. **Settled/idle events** — workflow-visible progress (`turn_end`, submission settlement, `queue_state`) is read from the durable event stream when a workflow needs observation finer than terminal results.
5. **Transcript read** — `SessionStore.getEntries(...)` is the single history read path for all session kinds (interactive, orchestrator, workflow-spawned). Structured-output extraction and repair against a node's `outputSchema` may remain a workflow-layer concern layered over `awaitResult`.

**Approvals — one pending-decision model, two resume targets.** An approval raised *inside* an engine session (a tool's decision gate) suspends a submission and resumes through `resolveDecision` → the submission lifecycle. An approval raised *by the workflow itself* (an approval node, a tool-policy hold) suspends the workflow instance and resumes through the workflow substrate's signal mechanism. Both surface to users as the same pending-decision record; the resolver dispatches on which durable waiter owns the pause. The engine owns the session-side target; the adapter owns workflow-instance signaling; the application layer owns the unified record and the stuck-approval sweep that recovers lost signals.

**Settlement-driven signals are deterministic.** Cross-session signals emitted by a settling submission (`child.settled` to a parent, workflow-wake notifications) use dispatchIds derived from the settling item (`child.settled:{childSessionId}:{queueItemId}`) and are emitted **inside the idempotent finalization step**. A re-run finalization re-emits the same dispatchId — admission dedup absorbs it — and a crash before emission is repaired by re-running finalization. Freshly generated "unique per message" ids are wrong for settlement-driven signals: they defeat the dedup exactly when the emitter re-runs.

## Provider Interfaces

These are the contracts that platform adapters implement. The engine depends only on these interfaces.

### SandboxProvider

Creates and manages sandbox compute. The engine calls this to get a Sandbox handle, then uses it for all file and process operations.

#### Lifecycle decoupling

The session and the sandbox are **two independent state machines with different cost profiles**, and the engine never couples them:

- **Session lifecycle** is cheap. State lives entirely in SessionStore; restoring a hibernated session is one load. A prompt to a cold session is durably admitted and the turn starts immediately — there is no user-visible "agent waking up" state.
- **Sandbox lifecycle** is expensive and asynchronous: `detached → provisioning → ready → idle → snapshotting/released`. A session owns a **sandbox attachment** that may be cold. When a prompt arrives against a cold attachment, the engine starts the turn and kicks the provider's warm path in parallel.

The joint is the lazy handle: `ToolContext.sandbox` is not guaranteed ready. The first sandbox-requiring operation awaits attachment readiness, subject to a configurable timeout, after which it fails with a structured `workspace_provisioning` tool error. Tools with no sandbox dependency (memory, plugin API calls, `thread_read`, decision gates) never wait. Orchestrator turns that touch no files respond instantly regardless of sandbox state.

Two required behaviors around cold attachments:

- The engine emits `sandbox_status` events so clients render workspace readiness as ambient state, not a blocking spinner.
- When a turn starts against a cold attachment, the engine injects a short system-context note ("workspace is provisioning, ~Ns; sequence non-filesystem work first" — using the provider's `coldStartEstimateMs`) so the model reorders work instead of stalling on its first tool call.

A dead or crashed sandbox mid-turn is a failed tool call plus a background re-provision — never a session error. The invariant the engine enforces is stated at workspace level: **the workspace survives; the sandbox is disposable.** How the workspace survives is provider-specific (memory snapshot, persistent volume, re-materialization).

Idle management runs on independent timers: the engine host idles aggressively (DO hibernation / pool eviction within minutes — free and invisible), while the sandbox idles on its own schedule keyed to the last sandbox *operation*, not the last prompt (stay warm for snappy tool calls, then snapshot or release per capabilities; per-org tunable, cost-driven).

#### Provider contract

```typescript
interface SandboxProvider {
  readonly backend: string;   // 'modal' | 'daytona' | 'k8s' | 'docker' | 'local' | 'virtual' | ...
  capabilities(): SandboxCapabilities;
  create(opts: SandboxCreateOpts): Promise<Sandbox>;
  restore(id: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  status(id: string): Promise<SandboxStatus>;
}

interface SandboxCapabilities {
  /** How a released sandbox comes back: memory snapshot, filesystem snapshot, or recreate-only. */
  snapshot: 'memory' | 'filesystem' | 'none';
  /** Workspace storage survives sandbox destruction (volume, mount). */
  persistentWorkspace: boolean;
  tunnels: boolean;
  warmPool: boolean;
  /** Feeds the cold-attachment model hint and client UI. */
  coldStartEstimateMs?: number;
}

interface SandboxCreateOpts {
  /** Provider selection when multiple backends are registered; defaults per org/repo policy. */
  backend?: string;
  image?: string;
  workspace?: string;
  env?: Record<string, string>;
  timeout?: number;
  resources?: { cpu?: number; memory?: string };
  metadata?: Record<string, unknown>;
}

interface Sandbox {
  id: string;

  // Filesystem
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;

  // Process execution
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;

  // Lifecycle
  snapshot(): Promise<string>;
  tunnels(): Promise<Record<string, string>>;
  destroy(): Promise<void>;
}

interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
}

interface SandboxStatus {
  id: string;
  state: 'provisioning' | 'ready' | 'idle' | 'snapshotting' | 'released' | 'error';
  startedAt?: number;
  error?: string;
}
```

**Cancellation contract (two-tier):** `timeout` is the **primary** cancellation mechanism — providers forward it to their native process-timeout facility, and this is how the `bash` tool enforces deadlines. `signal` is **best-effort**: most remote sandbox SDKs cannot interrupt an in-flight call, so implementations are only required to honor it where the underlying platform supports it. The engine compensates uniformly.

**Policy wrapper:** provider implementations stay thin because the engine wraps every `Sandbox` in a single policy layer that centralizes the cross-cutting semantics: pre-dispatch and post-completion `signal.aborted` checks (so aborts are observed at operation boundaries even when the provider can't interrupt), path resolution against the workspace cwd, output-limit enforcement, and write-with-parent-creation (attempt the write; on failure `mkdir -p` the parent and retry once — one round-trip on the happy path). A provider implements only the raw file/exec primitives; it never re-implements abort, path, or limit policy.

**Implementations:**
- `ModalSandbox` — wraps Modal's Python SDK (called via HTTP to the Modal backend); `snapshot: 'memory'`
- `DaytonaSandbox` — Daytona workspace API; capabilities per their snapshot/volume support
- `K8sPodSandbox` — creates a K8s pod, exec via K8s API; `snapshot: 'none'`, `persistentWorkspace: true` (PVC)
- `DockerSandbox` — local Docker container (dev/testing); `snapshot: 'filesystem'`
- `LocalSandbox` — host filesystem + child_process (CI, local dev)
- `VirtualSandbox` — in-memory filesystem + just-bash (lightweight agents, no container)

Providers register in a registry keyed by `backend`; sessions select via `SandboxCreateOpts.backend` with per-org/per-repo defaults, so one deployment can run Modal in production, Docker locally, and evaluate a new backend without a fork. A provider is supported when it passes the **sandbox provider conformance suite**: filesystem semantics, exec timeout forwarding, the two-tier cancellation contract, structured `workspace_provisioning` errors, and workspace survival across destroy/recreate. A `snapshot: 'none'` provider is fully valid — its restore path is recreate-plus-reattach, which the asynchronous attachment model absorbs as background warming rather than user-facing latency.

#### Sandbox RPC Contract

Remote sandbox implementations expose an authenticated HTTP RPC surface to the adapter. The engine still calls the `Sandbox` TypeScript interface; this RPC is the required adapter-to-sandbox protocol for Modal and Kubernetes implementations.

All requests include `Authorization: Bearer <sandbox-rpc-token>`. Tokens are scoped to one session and one sandbox ID and embed the attachment epoch (sandbox runtime spec); requests bearing a superseded-epoch token are rejected. Paths are relative to the sandbox workspace unless explicitly absolute and allowed by adapter policy.

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/health` | none | `{ ok, sandboxId, version, profile, services?, workspace: { state } }` |
| `GET` | `/files/stat?path=` | none | `{ isFile, isDirectory, size, mtimeMs }` |
| `GET` | `/files/read?path=&encoding=utf8` | none | `{ content, encoding }` |
| `GET` | `/files/read-binary?path=` | none | binary stream |
| `PUT` | `/files/write` | `{ path, content, encoding?: 'utf8' }` | `{ ok: true }` |
| `PUT` | `/files/write-binary?path=` | binary body | `{ ok: true }` |
| `GET` | `/files/list?path=` | none | `{ entries: Array<{ name, type, size }> }` |
| `POST` | `/files/mkdir` | `{ path, recursive?: boolean }` | `{ ok: true }` |
| `DELETE` | `/files` | `{ path, recursive?: boolean }` | `{ ok: true }` |
| `POST` | `/exec` | `{ command, cwd?, env?, stdin?, timeout?, maxOutputBytes?, mode?: 'job' }` | `ExecResult` \| `{ execId }` (job mode) |
| `GET` | `/exec/:execId?offset=N` | none | `{ status: 'running' \| 'done' \| 'failed', exitCode?, output, nextOffset }` |
| `DELETE` | `/exec/:execId` | none | `{ ok: true }` (cancel; two-tier cancellation contract) |
| `PUT` | `/auth/keys` | JWKS key set | `{ ok: true }` (gateway JWT rotation; auth = RPC bearer) — **superseded**, see below |
| `POST` | `/snapshot` | none | `{ snapshotId }` |
| `GET` | `/tunnels` | none | `{ tunnels: Record<string, string> }` |

**`/auth/keys` superseded:** the JWKS/`kid` key-set rotation sketch this row describes was dropped by `docs/specs/2026-07-15-sandbox-auth-gateway-design.md` decision 2/6 in favor of the HS256 per-session-secret model (`VALET_SANDBOX_JWT_SECRET`, no key set, no rotation RPC — rotation means re-provisioning). No `/auth/keys` route was implemented.

RPC implementations must enforce output limits, command timeouts, workspace path policy, and token/epoch validation. Sync `exec` is non-interactive; the engine's bash tool uses job mode past a timeout threshold (default 60s) so long execs survive intermediary idle timeouts (sandbox runtime spec, Long-Running Exec). Interactive terminal sessions remain a sandbox UI concern exposed through tunnels, not an engine tool protocol.

### SessionStore

Persists session state, thread state, message history, queue state, and submission lifecycle. Used by both the engine (writes) and the API layer (reads). One implementation per database backend, shared by engine and API. There is one uniform contract for every backend — no capability tiers — and an implementation is correct when it passes the executable contract suites (see Conformance). Backends satisfy the atomicity invariants (CAS claims, unique dispatch admission, two-phase settlement) with their native primitives: transactions and conditional updates on SQL, single-writer serialization on DO SQLite.

```typescript
interface SessionStore {
  // === Engine writes ===
  saveSession(session: SessionData): Promise<void>;
  saveThread(sessionId: string, thread: ThreadData): Promise<void>;
  /**
   * Fenced (see Effect fencing): rejects a write whose fence names a superseded
   * attempt with StaleAttemptError. The fence is OPTIONAL — during the durable
   * submission transition the engine passes one from inside every claimed turn,
   * while out-of-turn writers (seed helpers, pre-claim setup) omit it. The store
   * still rejects a *stale* fence whenever one is supplied.
   */
  appendEntries(sessionId: string, threadId: string, entries: SessionEntry[], fence?: WriteFence): Promise<void>;
  /**
   * Replace an existing entry in place. Required so pruning during
   * compaction can persist tool-result elision; also useful for any
   * other in-place mutation (gate refs, attachment updates).
   * Throws NotFoundError if no entry with this id exists in (sessionId, threadId).
   * Fenced when called inside a claimed turn.
   */
  updateEntry(sessionId: string, threadId: string, entry: SessionEntry, fence?: WriteFence): Promise<void>;

  // === Submission lifecycle (durable execution) ===
  /**
   * Idempotent admission. Same dispatchId + deep-equal content returns the
   * existing item with admitted=false; same dispatchId + different content
   * throws ConflictError. Items without a dispatchId always admit. `steer:true`
   * additionally stamps supersededByItemId on every unsettled item of the
   * thread admitted before this one, in the same atomic step, and returns their
   * ids in `supersededItemIds`.
   */
  admitSubmission(
    sessionId: string,
    threadId: string,
    item: QueueItem,
    opts?: { steer?: boolean },
  ): Promise<{ item: QueueItem; admitted: boolean; supersededItemIds: string[] }>;
  /**
   * CAS transition queued→running for the oldest unsettled, non-superseded item
   * of the thread. Records attemptId, ownerId, and lease; increments
   * attemptCount. Returns null when the item is not the runnable head or is
   * already claimed. Two concurrent claims must never both succeed.
   */
  claimSubmission(claim: SubmissionClaim): Promise<QueueItem | null>;
  /**
   * CAS: install a new attempt on a running/blocked item during reconciliation.
   * `expectedAttemptId` is the dead attempt being replaced; the CAS loses
   * (returns null) if another reclaimer already moved the item's attempt on
   * (double-reclaim race). Increments attemptCount.
   */
  replaceSubmissionAttempt(
    sessionId: string,
    threadId: string,
    itemId: string,
    claim: SubmissionClaim,
    opts: { expectedAttemptId: string },
  ): Promise<QueueItem | null>;
  insertAttemptMarker(itemId: string, attemptId: string): Promise<void>;
  deleteAttemptMarker(itemId: string, attemptId: string): Promise<void>;
  /**
   * True when an attempt-marker row exists for (itemId, attemptId). Durable
   * evidence the attempt began executing; reconciliation combines it with the
   * lease to distinguish "may still be running" from "safe to reclaim".
   */
  hasAttemptMarker(itemId: string, attemptId: string): Promise<boolean>;
  renewLeases(ownerId: string, itemIds: string[]): Promise<void>;
  listExpiredSubmissions(now: number): Promise<QueueItem[]>;
  /** All unsettled submissions of a session — reconciliation and awaitResult scan this. */
  listUnsettledSubmissions(sessionId: string): Promise<QueueItem[]>;
  getQueueItem(sessionId: string, itemId: string): Promise<QueueItem | null>;
  /** Stamp abortRequestedAt on all unsettled submissions in scope. First write wins; not terminal. */
  requestAbort(sessionId: string, threadId?: string): Promise<void>;
  /** Two-phase settlement: reserve records the exact terminal outcome (running|blocked→terminalizing). Fenced. */
  reserveSettlement(sessionId: string, threadId: string, itemId: string, outcome: SubmissionOutcome, fence: WriteFence): Promise<void>;
  /** Finalize terminalizing→settled. Idempotent; safe to re-run after a crash. Fenced. */
  finalizeSettlement(sessionId: string, threadId: string, itemId: string, fence: WriteFence): Promise<void>;
  /**
   * CAS settle for never-claimed items: succeeds only when status is
   * 'collecting' or 'queued' (returns false otherwise, e.g. a running item).
   * Used for superseded / merged / aborted-while-queued outcomes;
   * mergedIntoItemId is stamped when outcome is 'merged'. No fence — an
   * unclaimed item has no attempt to fence against.
   */
  settleUnclaimed(
    sessionId: string,
    threadId: string,
    itemId: string,
    outcome: SubmissionOutcome,
    opts?: { mergedIntoItemId?: string },
  ): Promise<boolean>;
  /** Fenced: running↔blocked_on_decision_gate transition for the claimed turn. */
  setSubmissionBlocked(sessionId: string, threadId: string, itemId: string, blocked: boolean, fence: WriteFence): Promise<void>;

  saveDecisionGate(sessionId: string, threadId: string, gate: DecisionGate): Promise<void>;
  saveDecisionGateRef(sessionId: string, threadId: string, gateId: string, ref: { channelType: string; ref: DecisionGateRef }): Promise<void>;
  updateDecisionGateEntry(sessionId: string, threadId: string, gateId: string, patch: Partial<DecisionGateEntry>): Promise<void>;
  /** Fenced: only the current attempt may write or clear its checkpoint. */
  saveSuspendedTurn(sessionId: string, threadId: string, suspended: SuspendedTurnState, fence?: WriteFence): Promise<void>;
  clearSuspendedTurn(sessionId: string, threadId: string, fence?: WriteFence): Promise<void>;
  updateSessionStatus(id: string, status: string, metadata?: Partial<SessionData>): Promise<void>;
  flush?(): Promise<void>;

  // === API reads ===
  getSession(id: string): Promise<SessionData | null>;
  /** List by owning principal; a user's full view is a union over user:{id} plus their teams' principals. */
  listSessions(owner: Principal, opts?: ListOpts): Promise<SessionData[]>;
  getThread(sessionId: string, threadId: string): Promise<ThreadData | null>;
  listThreads(sessionId: string): Promise<ThreadData[]>;
  getEntries(sessionId: string, threadId: string, opts?: MessageQuery): Promise<SessionEntry[]>;
  listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]>;
  getSuspendedTurn(sessionId: string, threadId: string): Promise<SuspendedTurnState | null>;

  // === Shared ===
  deleteSession(id: string): Promise<void>;
}
```

```typescript
interface SuspendedTurnState {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  gateId: string;
  model: string;
  leafMessageId?: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resumeKey: string;
  /** Engine-maintained per (queueItemId, resumeKey); replay matches the SAME gate via (resumeKey, ordinal). */
  ordinal: number;
  attempt: number;
  createdAt: number;
}
```

```typescript
/** Ownership principal, shared with the application layer. Serialized `${type}:${id}`. */
interface Principal {
  type: 'user' | 'team' | 'org';
  id: string;
}

interface SessionData {
  id: string;
  /** Who the session belongs to; access to team/org-owned sessions follows membership. */
  owner: Principal;
  /** Actor: the human whose action created or triggered the session. */
  userId: string;
  /** Denormalized org context; MUST equal owner.id when owner.type === 'org'. Sessions are always org-scoped regardless of owner kind. */
  orgId: string;
  workspace: string;
  purpose: 'interactive' | 'orchestrator' | 'workflow' | 'child';
  status: 'initializing' | 'running' | 'paused' | 'hibernated' | 'terminated' | 'error';
  sandboxId?: string;
  snapshotId?: string;
  parentSessionId?: string;
  parentThreadId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface ThreadData {
  id: string;
  sessionId: string;
  key: string;
  status: 'active' | 'paused' | 'archived';
  activeLeafEntryId?: string;
  queueMode: QueueMode;
  /** Persisted pause flag — the only stored piece of queue state; everything else in QueueState derives from durable queue items. */
  paused?: boolean;
  model?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/**
 * QueueState is a DERIVED view, not a stored entity: computed from durable
 * queue items plus ThreadData.paused. `collectBuffer` is the items with
 * status 'collecting'; `blockedGateId` derives from the suspended turn.
 * This is the shape used in `queue_state` events and API payloads.
 */
interface QueueState {
  threadId: string;
  mode: QueueMode;
  status: 'idle' | 'queued' | 'running' | 'blocked_on_decision_gate' | 'paused';
  activeItemId?: string;
  pending: QueueItem[];
  collectBuffer?: QueueItem[];
  blockedGateId?: string;
}

interface QueueItem {
  id: string;
  threadId: string;
  /** Idempotent admission key (provider event id). Unique per session when present. */
  dispatchId?: string;
  content: PromptContent;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  model?: string;
  metadata?: Record<string, unknown>;

  // Durable execution lifecycle
  status: 'collecting' | 'queued' | 'running' | 'blocked_on_decision_gate' | 'terminalizing' | 'settled';
  outcome?: SubmissionOutcome;
  /** Stamped transactionally by a steer admission; reconciliation settles the item 'superseded'. */
  supersededByItemId?: string;
  /** Set on constituents when a collect window closes; awaitResult delegates to this item. */
  mergedIntoItemId?: string;
  attemptId?: string;
  attemptCount: number;
  maxAttempts: number;        // default 10
  timeoutAt: number;          // default createdAt + 1h; not enforced while blocked_on_decision_gate
  abortRequestedAt?: number;
  ownerId?: string;
  leaseExpiresAt?: number;

  createdAt: number;
}

interface SubmissionClaim {
  sessionId: string;
  threadId: string;
  itemId: string;
  attemptId: string;
  ownerId: string;
  leaseDurationMs?: number;   // default 30_000
}

interface SubmissionOutcome {
  outcome: 'completed' | 'failed' | 'aborted' | 'superseded' | 'merged';
  error?: string;
}

type SessionEntry =
  | MessageEntry
  | DecisionGateEntry
  | CompactionEntry
  | BranchSummaryEntry;
```

**Data flow:** The engine writes through SessionStore during execution. The API layer reads through SessionStore for client queries (session lists, message history, etc.). Both hit the same underlying database. The engine is the writer, the API is the reader, the database is the shared state.

On Cloudflare, the SessionHostDO's embedded SQLite **is** the SessionStore: transactional CAS, zero-latency writes, and no subrequest-budget exposure (DO storage operations are not subrequests). An asynchronous projector mirrors summary rows — sessions, threads, settled-submission summaries — to D1 for cross-session queries (`listSessions`, admin views, org ceilings). The staleness rule is normative: every correctness-bearing read (reconciliation, `awaitResult`, gate resolution, claim state) reads the authoritative DO store; only cross-session listing and aggregate queries may read the D1 projection, which is eventually consistent. The `flush()` method is called by the engine on session shutdown, giving the store a chance to drain any internal buffers — on Cloudflare, pending projection writes.

**Implementations:**
- `DOSessionStore` — DO-embedded SQLite via Drizzle (Cloudflare), authoritative, with the async D1 projection described above
- `PostgresSessionStore` — PostgreSQL via Drizzle
- `InMemorySessionStore` — for tests and ephemeral agents

#### Required Tables

The engine schema owns these tables outright — they are the only storage the engine reads or writes (see Clean-Slate Schema).

| Table | Purpose | Key fields |
|---|---|---|
| `engine_sessions` | Canonical engine session state | `id`, `owner_type`, `owner_id` (indexed), `user_id`, `org_id`, `workspace`, `purpose`, `status`, `sandbox_id`, `snapshot_id`, `parent_session_id`, `parent_thread_id`, `metadata`, timestamps |
| `engine_threads` | Thread metadata and active leaf | `id`, `session_id`, `key`, `status`, `active_leaf_entry_id`, `queue_mode`, `model`, `summary`, `metadata` |
| `engine_entries` | DAG history | `id`, `session_id`, `thread_id`, `parent_id`, `queue_item_id` (indexed — the transcript↔submission linkage), `entry_type`, `role`, `stop_reason`, `content`, `parts`, `metadata`, `created_at` |
| `engine_queue_items` | Durable submissions (per-thread queue + execution lifecycle) | `id`, `session_id`, `thread_id`, `dispatch_id` (unique per session when set), `status`, `outcome`, `error`, `mode`, `content`, `author`, `channel`, `reply_target`, `model`, `attempt_id`, `attempt_count`, `max_attempts`, `timeout_at`, `abort_requested_at`, `owner_id`, `lease_expires_at`, `metadata`, timestamps |
| `engine_attempt_markers` | Durable evidence an attempt started (crash-recovery gating) | `item_id`, `attempt_id`, `created_at` — PK `(item_id, attempt_id)` |
| `engine_events` | Offset-addressed durable event stream — SQL-backed stores only (SQLite dev, Postgres on k8s). On Cloudflare the event log lives in per-session DO storage instead, satisfying the same EventStream contract without this table | `session_id`, `seq` (INTEGER, exposed as a zero-padded offset string), `event_key`, `thread_id`, `queue_item_id`, `user_id`, `event_type`, `payload`, `timestamp` — PK `(session_id, seq)`, UNIQUE `(session_id, event_key)` (appendOnce idempotency), INDEX `(session_id, queue_item_id)` (per-submission retention prune) |
| `engine_meta` | Store metadata | key/value; key `schema_version` stamped at creation |
| `engine_decision_gates` | Pending and terminal gate state | `id`, `session_id`, `thread_id`, `type`, `status`, `title`, `body`, `actions`, `origin`, `context`, `resolution`, `expires_at`, timestamps |
| `engine_decision_gate_refs` | Delivered channel refs | `id`, `gate_id`, `channel_type`, `ref`, `created_at`, `updated_at` |
| `engine_suspended_turns` | Restart-safe blocked turn checkpoints | `session_id`, `thread_id`, `queue_item_id`, `gate_id`, `model`, `leaf_entry_id`, `tool_call_id`, `tool_name`, `tool_args`, `resume_key`, `ordinal`, `attempt`, `created_at` |
| `engine_credentials` | Stored credentials when adapter uses engine schema | `id`, `owner_type`, `owner_id`, `service`, `credential_type`, `encrypted_data`, `scopes`, `expires_at`, timestamps |
| `engine_oauth_states` | OAuth handshake state | `state`, `user_id`, `service`, `redirect_uri`, `code_verifier`, `metadata`, `expires_at` |

Indexes are required on `(session_id, thread_id, created_at)` for entries, `(session_id, thread_id, status)` for queue items and gates, `(owner_type, owner_id)` for sessions, and `(owner_type, owner_id, service)` for credentials.

Entries, gates, and suspended-turn checkpoints follow the session's retention: they are deleted with the session, and terminal sessions are archivable per org retention policy.

### EventStream

Engine events are an **offset-addressed durable log per session**, not a fire-and-forget broadcast. The engine appends; adapters and clients read from an offset and subscribe live. Reconnection is a resume from the last seen offset — no replay buffer bolted onto a transport, no refetch-and-reconcile dance.

```typescript
interface EventStream {
  /**
   * Durably append and fan out to live subscribers. Returns the assigned
   * offset. `eventKey` is a caller-supplied idempotency key, unique per
   * session: an append whose eventKey already exists is a no-op returning
   * the original offset (appendOnce semantics).
   */
  append(event: BusEvent, eventKey: string): Promise<{ offset: string }>;
  /** Read durable events strictly after `fromOffset` (exclusive), in offset order. */
  read(sessionId: string, opts?: { fromOffset?: string; limit?: number }): Promise<{ events: StoredBusEvent[]; nextOffset: string }>;
  /** Live subscription. Delivery order matches offset order for a given session. */
  subscribe(filter: EventFilter, callback: (event: StoredBusEvent) => void): Unsubscribe;
}

interface BusEvent {
  sessionId: string;
  threadId?: string;
  /** The submission whose turn produced this event. Required for retention and truncation decisions. */
  queueItemId?: string;
  userId?: string;
  event: EngineEvent;
  timestamp: number;
}

interface StoredBusEvent extends BusEvent {
  /** Opaque, lexicographically ordered, monotonic per session. */
  offset: string;
}

interface EventFilter {
  sessionId?: string;
  userId?: string;
  eventTypes?: string[];
}

type Unsubscribe = () => void;
```

**Deterministic keys for re-runnable emitters:** any event emitted from an idempotent repair path — settlement events from re-runnable finalization, terminalization repairs — MUST use a deterministic eventKey (e.g. `settled:{queueItemId}`), so a repair re-run cannot double-emit. Events emitted once from live execution may use a fresh unique key.

**Access control:** stream access is session access. Adapters MUST authorize every `read` and `subscribe` against the target session's access control — the same owner-principal membership check that gates the session's API routes, re-evaluated per operation. Filters without a `sessionId` (cross-session firehoses) are internal operator surfaces only and are never exposed to clients; a client subscription is always scoped to sessions the caller can access.

**Gap handling:** live fan-out transports may be lossy (Redis pub/sub is at-most-once). A subscriber that observes a live event whose offset is not contiguous with its last delivered offset MUST re-read the durable log from that offset before delivering — adapters using lossy fan-out are required to implement this refetch, which is what makes "delivery order matches offset order" true end-to-end rather than merely asserted.

**Delta handling:** high-frequency streaming events (`text_delta`) are live-only — they fan out to subscribers but are not durably appended and **carry no offset** (the durable record of streamed text is the persisted `MessageEntry`, delivered via `message_update`/`message_end`). All discrete events (message lifecycle, tool start/end, queue state, decision gates, status, errors) are durable. This keeps the log linear in conversation size rather than quadratic in streamed bytes.

**Retention:** a session's stream is truncatable after the session reaches a terminal status plus a configurable retention window. For **permanent sessions** (orchestrators never terminate), retention applies per submission instead: events whose `queueItemId` references a submission settled longer than the retention window ago are truncatable while the session lives — the transcript entries remain the durable record. Truncation never removes events whose `queueItemId` references an unsettled submission; the linkage field is what makes both rules computable.

**Implementations:**
- `DOEventStream` — the log lives in the SessionHostDO's own SQLite storage, co-located with the engine; fan-out to connected clients happens from that DO's WebSockets. There is no singleton event DO. (Cloudflare)
- `PostgresEventStream` / `RedisEventStream` — table- or stream-backed log with pub/sub fan-out (Kubernetes)
- `InMemoryEventStream` — array-backed (single-process, tests)

### Channel Transports

Channel transports live at the adapter boundary. The engine does not render Slack or Telegram payloads directly, but it defines the full contract transports implement: verified ingress, conversation identity, outbound delivery, and decision-gate delivery.

A transport has four responsibilities:

1. **Verified ingress** — signature verification over the exact raw request bytes (HMAC, Ed25519, or shared secret per provider) before any parsing or application code runs. Payload parsing yields typed, provider-native shapes; normalization into engine types happens at the resolution layer, not by flattening provider fields into a lossy common shape.
2. **Conversation identity** — a bijective codec between provider conversation references and stable string keys: `conversationKey(ref)` / `parseConversationKey(key)`. Keys are versioned and namespaced (`slack:v1:{teamId}:{channelId}:{threadTs}`, `telegram:v1:{chatId}:{messageThreadId}`), URL-safe, and round-trip exactly — `parseConversationKey` re-serializes and rejects non-canonical input. **A conversation key is an identifier, not an authorization capability**; nothing may be admitted on the strength of a key alone.
3. **Outbound delivery** — `sendMessage` / `updateMessage` rendering engine output into provider payloads.
4. **Decision-gate delivery** — `sendDecisionGate` / `updateDecisionGate` / `parseInboundDecision`, so gates reach approvers on their channel and resolutions flow back.

**Ingress pipeline (tenancy resolution):** inbound events pass through a fixed pipeline before reaching the engine:

```
webhook → verifySignature (raw bytes)
        → parseInbound (typed provider event)
        → conversationKey (stable identity)
        → channel-binding resolution: key → { owner: Principal, actorUserId?, sessionId, threadKey }
          (authorization check — is this conversation bound, and to whom?)
        → thread.prompt(SignalContent, { dispatchId: providerEventId, channel, author })
```

The channel-binding table is owned by the application layer (it is a tenancy concern), but the pipeline shape is normative: verification before parsing, resolution before admission, and admission always as a `SignalContent` with `dispatchId` set to the provider's stable event id so at-least-once webhook delivery is idempotent. Unbound conversations route to the org orchestrator's unattributed-event handling or are rejected, per application policy — never silently admitted.

```typescript
interface ChannelTransport {
  readonly channelType: string;

  verifySignature?(headers: Record<string, string>, rawBody: string, secret?: string): boolean | Promise<boolean>;
  parseInbound?(headers: Record<string, string>, rawBody: string, ctx: ChannelTransportContext): Promise<InboundChannelEvent | null>;

  conversationKey(ref: Record<string, string>): string;
  parseConversationKey(key: string): Record<string, string>;

  sendMessage(target: ChannelTarget, message: OutboundMessage, ctx: ChannelTransportContext): Promise<ChannelMessageRef | null>;
  updateMessage?(target: ChannelTarget, ref: ChannelMessageRef, message: OutboundMessage, ctx: ChannelTransportContext): Promise<void>;

  sendDecisionGate?(target: ChannelTarget, gate: DecisionGate, ctx: ChannelTransportContext): Promise<DecisionGateRef | null>;
  updateDecisionGate?(target: ChannelTarget, ref: DecisionGateRef, update: DecisionGateUpdate, ctx: ChannelTransportContext): Promise<void>;

  parseInboundDecision?(payload: unknown, ctx: ChannelTransportContext): Promise<{
    gateId: string;
    actionId?: string;
    value?: string;
    actorExternalId?: string;
  } | null>;
}

interface ChannelTarget {
  channelType: string;
  channelId: string;
  threadId?: string;
}

interface ChannelTransportContext {
  userId: string;
  orgId: string;
  sessionId: string;
  threadId?: string;
  token?: string;
  botToken?: string;
  persona?: {
    name?: string;
    avatar?: string;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

interface OutboundMessage {
  text?: string;
  markdown?: string;
  attachments?: Array<{
    type: 'image' | 'file';
    url: string;
    mimeType: string;
    name?: string;
    caption?: string;
  }>;
  replyTo?: ChannelMessageRef;
  metadata?: Record<string, unknown>;
}

interface ChannelMessageRef {
  messageId: string;
  channelId: string;
  threadId?: string;
  [key: string]: unknown;
}

type DecisionGateUpdate =
  | { status: 'resolved'; resolution: DecisionResolution }
  | { status: 'expired' }
  | { status: 'withdrawn'; reason: DecisionWithdrawReason };

type InboundChannelEvent =
  | { type: 'message'; target: ChannelTarget; text: string; actor: ChannelActor; messageId?: string; attachments?: PromptAttachment[] }
  | { type: 'decision'; gateId: string; actionId?: string; value?: string; actor: ChannelActor; target?: ChannelTarget; messageId?: string };

interface ChannelActor {
  id: string;
  displayName?: string;
  email?: string;
}
```

**Slack is the required reference transport for V1.** The V1 implementation must define:

- how a Slack thread maps to `channelType = 'slack'` and a stable `channelId`
- how Slack button clicks map back to `gateId` / `actionId`
- how free-text thread replies resolve pending decision gates when the stored origin matches
- how previously sent Slack decision gates are updated on resolution, expiry, or withdrawal

Other transports may follow the same contract later, but Slack is the minimum transport that must be fully specified and implemented for V1.

Slack `channelId` is canonicalized as `teamId:channelId:threadTs` for thread replies and `teamId:channelId` for channel-level messages. The transport may store native Slack fields (`ts`, `thread_ts`, `response_url`) inside `DecisionGateRef`, but engine-visible routing always uses the canonical `ChannelTarget`.

### BlobStore

File attachments, images, artifacts. Simple key-value with streaming.

```typescript
interface BlobStore {
  put(key: string, data: Uint8Array | ReadableStream, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<{ data: ReadableStream; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}
```

**Implementations:**
- `R2BlobStore` — Cloudflare R2
- `S3BlobStore` — AWS S3 / MinIO

### CredentialStore

Stores OAuth tokens and API keys per user per service. Handles encryption transparently within the implementation: the engine passes an encryption key via adapter config, the store encrypts/decrypts tokens internally. The engine and tools never see encrypted blobs.

```typescript
interface CredentialStore {
  get(owner: CredentialOwner, service: string): Promise<StoredCredential | null>;
  save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void>;
  delete(owner: CredentialOwner, service: string): Promise<void>;
  list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]>;
}

interface CredentialOwner {
  type: 'user' | 'team' | 'org' | 'session';
  id: string;
}

interface StoredCredential {
  type: 'oauth2' | 'api_key' | 'bot_token' | 'service_account' | 'app_install';
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}
```

**Token refresh:** When a credential's `expiresAt` is in the past (or within a configurable buffer), the CredentialProvider wrapper in the engine auto-refreshes using the OAuth provider's token endpoint before returning the token to the tool. This requires OAuthProviderConfig for the service (token URL, client credentials). Transparent to the tool.

**OAuth flow:** OAuth connection flows (user initiates "Connect GitHub" from the UI) live in the API layer. The API handles redirect, callback, and token exchange, then stores the credential via CredentialStore. The engine consumes stored credentials at tool execution time.

**OAuth provider registry:** Plugin packages export their OAuth configuration alongside their tools:

```typescript
interface OAuthProviderConfig {
  service: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  refreshable: boolean;
}
```

The API layer collects these at startup to power the OAuth connection UI and callback handling.

Credential lookup order is tool-defined but must be explicit. The default order is parameterized by the session's owner kind: **user-owned** sessions resolve session → user → org; **team-owned** sessions resolve session → team ONLY — never falling through to the acting user's personal credential; a missing team credential fails visibly (per the orchestrator spec's sourced-reference model) rather than silently borrowing a personal token; **org-owned** sessions resolve session → org. If no credential is found and the tool requires one, `CredentialProvider.request()` creates a `DecisionGate` of type `credential_request`.

## Schema and Migrations

The engine owns the canonical database schema. Schema definitions live in the engine package as Drizzle TypeScript schemas. Migration files are generated per dialect (SQLite for D1, PostgreSQL for PG) and ship with the engine package.

```
packages/engine/
  src/schema/              ← Drizzle schema definitions (source of truth)
  migrations/
    sqlite/                ← generated by drizzle-kit for D1
    postgresql/            ← generated by drizzle-kit for PG
```

**Schema coverage:** The engine schema defines tables for sessions, threads, message entries, queue state, decision gates, suspended turns, credentials, and OAuth states. This is the same schema the SessionStore and CredentialStore implementations read from and write to.

**Workflow for adding a field:**
1. Update the Drizzle schema in `packages/engine/src/schema/`
2. Run `drizzle-kit generate` for each dialect — produces migration SQL
3. Migration files ship with the engine package
4. On deploy, each platform applies migrations through its normal mechanism:
   - Cloudflare: `wrangler d1 migrations apply`
   - Kubernetes: init container or migration job running `drizzle-kit migrate`

The SessionStore interface has no `migrate()` method. Migrations are a deployment concern, not a runtime interface. The engine is a library; it does not own the deployment lifecycle.

**Schema version enforcement:** the engine schema carries an integer version (`ENGINE_SCHEMA_VERSION`). Every store durably records the version it was created at (the `engine_meta` table, key `schema_version`) and, on open, **fails loudly before reading or writing any data** when the recorded version is unknown, newer than the code supports, or absent from a populated database. A version mismatch is a deployment error surfaced at startup — never a silent runtime corruption. Migrations bring the store to the current version and re-stamp it in the same transaction where the backend supports transactional DDL.

### Clean-Slate Schema

The v2 database is designed from scratch — engine tables and application tables alike. There is **no coexistence, no mirroring, and no legacy reader compatibility**: the engine never reads or writes legacy tables, the v2 API serves only the v2 schema, and no v2 table inherits shape constraints from the current implementation. Names may coincide with legacy tables where the fresh design lands in the same place; no compatibility is implied by that.

State transfer between the stacks is **export/import bundles, not schema migration**:

- **Memory** — the existing OKF export/import bundles (`include=all|shareable`) are the transfer mechanism, already shipped.
- **Credentials, identity links, bindings** — exported/re-established at cutover through their own bundle formats or re-connection flows; secrets re-encrypt under the v2 credential store.
- **Conversation history** — does not migrate. The legacy system remains readable until sunset; v2 sessions start clean. An optional import (legacy transcript → `engine_entries`) may be built if demand warrants, as an importer against the export format — never as a dual-schema bridge.

DO storage in the v2 Cloudflare adapter is limited to hosting concerns (hibernation state, WebSocket bookkeeping); it is never a data store the schema must accommodate.

## Platform Adapters

A platform adapter wires the engine to a specific deployment target. It does three things:

1. Instantiates provider implementations (SessionStore, SandboxProvider, EventStream, BlobStore, CredentialStore)
2. Hosts the engine process (DO on CF, long-running process on K8s)
3. Provides the HTTP/WebSocket entrypoint for clients and API routes

### Shared API Routes (`packages/api/`)

API route handlers are written once and shared across platforms. They are Hono route factories parameterized by provider implementations:

```typescript
export function sessionRoutes(store: SessionStore, engine: EngineManager) {
  const router = new Hono();
  router.get('/:id', async (c) => {
    const session = await store.getSession(c.req.param('id'));
    return c.json(session);
  });
  router.post('/:id/threads/:threadId/prompt', async (c) => {
    const body = await c.req.json();
    await engine.getSession(c.req.param('id'))
      .thread(c.req.param('threadId'))
      .prompt(body.content);
    return c.json({ ok: true });
  });
  return router;
}
```

Each adapter imports these factories and injects its providers. The route logic is written once.

#### Required API Surface

The shared API package owns route behavior. Adapters own authentication middleware, provider construction, and request context injection.

| Method | Route | Behavior |
|---|---|---|
| `POST` | `/api/sessions` | Create a session and return session metadata plus client stream URL |
| `GET` | `/api/sessions/:sessionId` | Read session metadata and live status |
| `DELETE` | `/api/sessions/:sessionId` | Terminate and delete/archival-mark a session |
| `POST` | `/api/sessions/:sessionId/prompt` | Prompt the default thread |
| `GET` | `/api/sessions/:sessionId/threads` | List threads |
| `POST` | `/api/sessions/:sessionId/threads` | Create a thread |
| `GET` | `/api/sessions/:sessionId/threads/:threadId` | Read thread metadata and entries |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/prompt` | Prompt a specific thread |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/abort` | Abort current turn and clear this thread queue |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/pause` | Pause this thread |
| `POST` | `/api/sessions/:sessionId/threads/:threadId/resume` | Resume this thread |
| `GET` | `/api/sessions/:sessionId/decision-gates` | List pending and recent terminal gates |
| `POST` | `/api/sessions/:sessionId/decision-gates/:gateId/resolve` | Resolve a pending gate |
| `POST` | `/api/sessions/:sessionId/decision-gates/:gateId/withdraw` | Withdraw a pending gate |
| `GET` | `/api/sessions/:sessionId/events` | SSE stream for client events |
| `GET` | `/api/sessions/:sessionId/ws` | WebSocket stream for client events and optional prompt/control messages |
| `GET` | `/api/sessions/:sessionId/tunnels` | Return sandbox tunnel URLs |
| `POST` | `/api/sessions/:sessionId/snapshot` | Snapshot session sandbox and persist snapshot ID |
| `GET` | `/api/sessions/:sessionId/blobs/:key` | Fetch a stored blob (attachments, artifacts) — authorized by session access |
| `GET`/`POST` | `/api/admin/submissions...` | Operator surface (required for V1): list submissions with lifecycle state, force-settle a wedged submission, inspect leases |

Prompt routes accept the same `PromptOptions` shape as the engine API. WebSocket prompt/control messages are optional conveniences over the same route semantics; they must not define separate behavior.

### Cloudflare Adapter (`packages/adapter-cloudflare/`)

```
Cloudflare Worker (Hono)
  ├── API routes (shared from packages/api/)
  │     ├── cross-session queries → D1 projection (eventually consistent)
  │     └── per-session reads/writes → SessionHostDO (authoritative)
  │
  ├── WebSocket upgrade → forwarded to SessionHostDO (hibernatable client sockets)
  │
  └── Session operations → SessionHostDO
        │
        SessionHostDO (thin shell)
          ├── creates Engine instance on first request
          ├── injects: DOSessionStore (embedded SQLite), ModalSandbox, DOEventStream (same DO storage), R2BlobStore
          ├── holds client WebSockets; fans events out from its own durable log
          ├── multiplexes its single DO alarm across all timer consumers
          ├── forwards prompt/abort/pause/resume to engine
          └── engine runs agent loop, emits events, writes state
```

The SessionHostDO is a thin shell. It creates an engine instance with CF provider implementations, forwards incoming requests, and uses DO hibernation so idle sessions don't consume compute. On wake, it restores the engine from SessionStore state.

**Eviction and replay are the steady state, not a recovery edge case.** Every deploy evicts every DO, and a gate that stays pending for hours guarantees the hosting DO is evicted before resolution arrives. The restart-safe replay contract — reconciliation, suspended-turn checkpoints, deterministic gate identity — is therefore the normal execution model on Cloudflare, exercised many times a day, not a rare crash path. Consequence: the tool re-entrancy discipline (idempotent pre-gate prefixes; see the restart-safe tool suspension contract) is a mandatory audit item for every tool ported to the engine, not best-practice advice.

**Alarm multiplexing.** A DO has one alarm. The SessionHostDO multiplexes it across every timer consumer — lease heartbeat, gate `expiresAt`, submission `timeoutAt`, collect windows — by re-arming to the minimum next deadline after every event. When the alarm fires, the host dispatches every due timer and re-arms to the new minimum. The alarm is also what re-drives interrupted submissions after eviction: the DO wakes on the next inbound request or its alarm, whichever comes first, and runs reconciliation.

**Subrequest budget.** Because the SessionStore and EventStream live in the DO's own storage, per-turn persistence — entry appends, queue transitions, event appends, checkpoints — consumes none of the ~1000-subrequest budget; DO storage operations are not subrequests. The budget constrains only LLM fetches and sandbox RPCs, and a single turn's worth of both fits comfortably.

### Kubernetes Adapter (`packages/adapter-k8s/`)

```
K8s Service (Hono/Node)
  ├── API routes (shared from packages/api/)
  │     └── reads/writes via PostgresSessionStore
  │
  ├── WebSocket upgrade → subscribes to RedisEventStream → relays to client
  │
  └── Session operations → SessionPool
        │
        SessionPool (process manager)
          ├── spawns/reuses engine instances per session
          ├── injects: PostgresSessionStore, ModalSandbox, RedisEventStream, S3BlobStore
          ├── forwards prompt/abort/pause/resume to engine
          └── engine runs in-process
```

The SessionPool manages engine instances in-process. Idle instances are evicted after a timeout (equivalent to DO hibernation). Session affinity via K8s ingress routes requests for the same session to the same pod.

### Local Host (development topology)

The local development host is the Kubernetes shape at N=1 with local providers, and it is a first-class supported topology — every contract in this spec must hold on it, because it is where the conformance suites and the end-to-end dogfood run:

- One Node process (`packages/api`): Hono routes + a single-process SessionPool.
- `SqliteSessionStore` (better-sqlite3) as the authoritative store; `SqliteEventStream` over the same database as the durable, offset-addressed event log (in-process fan-out — the reference EventStream implementation). The store opens with `journal_mode=WAL`, `busy_timeout=5000`, and `synchronous=FULL` — FULL (not NORMAL) is deliberate: this subsystem's premise is durability, and NORMAL can lose the last committed transaction on host power loss, which is exactly the write a kill-mid-turn must survive.
- `DockerSandbox` / `LocalSandbox` as in-process `Sandbox` implementations under the policy wrapper (no sandboxd required locally).
- The same claim/lease/fence machinery runs even though there is exactly one owner — a locally killed-and-restarted process exercises the identical reconciliation paths the DO and pod hosts rely on. Kill-mid-turn recovery is a local test, not a production-only behavior.
- Workflow runs use the same leased-worker RunHost in-process; channel ingress uses long-polling transports (e.g. Telegram) so no public webhook is needed.

### What Each Adapter Provides

| Interface | Cloudflare | Kubernetes |
|---|---|---|
| SessionStore | DO-embedded SQLite + async D1 projection | PostgreSQL via Drizzle |
| SandboxProvider | Modal SDK | Modal SDK / K8s Pod API |
| EventStream | per-session DO storage | Redis pub/sub |
| BlobStore | R2 | S3 / MinIO |
| CredentialStore | D1 (encrypted) | PostgreSQL (encrypted) |
| Channel transports | Worker-integrated (Slack required for V1) | Service-integrated (Slack required for V1) |
| Engine host | SessionHostDO | SessionPool (in-process) |

### Adapter Host Contract

Every adapter must provide:

- Request authentication and authorization before calling shared API route handlers.
- Provider construction for the current deployment target.
- Engine instance lookup by session ID.
- Session affinity so prompts, decision resolutions, and aborts for one session reach the same active engine instance. Affinity is a routing optimization; **exclusive ownership is enforced by the durable submission claim/lease protocol**, so a mis-routed or racing request degrades to a failed claim, never a double execution.
- Lease heartbeats for claimed submissions and a periodic expired-lease scan that routes reclaimed submissions through reconciliation.
- Event subscription and client delivery over WebSocket and/or SSE.
- Startup restoration of queued, running, and blocked threads from `SessionStore` via `engine.restoreSession({ sessionId, options })`. The adapter is responsible for reconstructing `options` (tools, sandbox handle, model, system prompt, role/skill sources) from its own configuration — the engine itself does not persist creation options.
- Idle eviction/hibernation that calls `store.flush()` and leaves enough persisted state to resume. Specifically: any thread with status `running` or `blocked_on_decision_gate`, plus its active queue item and (for blocked threads) its `SuspendedTurnState`, must be readable on wake. Host idle timers are independent of sandbox idle timers — evicting the engine host must not release a warm sandbox, and releasing an idle sandbox must not evict the host.
- Fatal error handling that marks the session `error`, publishes a client `error` event, and prevents silent queue accumulation.

Cloudflare V1 uses one `SessionHostDO` per session ID. Kubernetes may use a process-local `SessionPool`, but must provide equivalent session affinity and restore behavior.

## Tool Implementation and Integration Framework

### Plugin Package Structure

Plugin packages live in `packages/plugin-*/`. Each exports tools as `ToolDef[]` and optionally exports OAuth configuration.

```typescript
// packages/plugin-github/src/tools.ts
import type { ToolDef } from '@valet/engine';

export const tools: ToolDef[] = [
  {
    name: 'github.create_pr',
    description: 'Create a pull request on GitHub',
    parameters: Type.Object({
      repo: Type.String(),
      title: Type.String(),
      body: Type.String(),
      head: Type.String(),
      base: Type.String(),
    }),
    execute: async (args, ctx) => {
      let cred = await ctx.credentials.get('github');
      if (!cred) {
        // Opens a credential_request gate; resolves with the connected credential.
        cred = await ctx.credentials.request('github', 'Need GitHub access to create a PR');
      }
      const res = await fetch(`https://api.github.com/repos/${args.repo}/pulls`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.token}` },
        body: JSON.stringify(args),
      });
      const pr = await res.json();
      return { text: `Created PR #${pr.number}: ${pr.html_url}` };
    },
  },
];

// packages/plugin-github/src/oauth.ts
import type { OAuthProviderConfig } from '@valet/engine';

export const oauth: OAuthProviderConfig = {
  service: 'github',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  scopes: ['repo', 'read:org'],
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  refreshable: false,
};
```

### Tool Registration

Tools from plugin packages are registered at session creation. The adapter collects tools from all enabled plugins and passes them to the engine:

```typescript
import { tools as githubTools } from '@valet/plugin-github';
import { tools as slackTools } from '@valet/plugin-slack';
import { tools as linearTools } from '@valet/plugin-linear';

const session = await engine.createSession({
  sandbox: await sandboxProvider.create({ image, workspace }),
  tools: [...githubTools, ...slackTools, ...linearTools],
  // ...
});
```

The engine merges plugin tools with built-in tools. Name conflicts between plugins are caught at registration time. Per-thread tool overrides are merged at prompt time (thread-level wins on name conflict).

### Engine-to-Tool Data Flow

```
Engine receives tool call from LLM
  → looks up ToolDef by name
  → constructs ToolContext { userId, orgId, sessionId, threadId, channel metadata, repo context, credentials, sandbox, signal }
  → calls toolDef.execute(args, ctx)
  → tool uses ctx.credentials.get('service') for API auth
  → tool uses ctx.sandbox.exec() / readFile() if it needs sandbox access
  → tool may call ctx.requestDecision(...) for gated human input
  → tool returns ToolResult { text, attachments? }
  → engine handles attachments per type (vision, blob store, inline)
  → engine feeds result back to LLM via pi-agent-core
```

## Observability and Error Contract

The engine distinguishes user-visible recoverable errors from fatal session errors.

```typescript
interface EngineError {
  code: string;
  message: string;
  recoverable: boolean;
  sessionId?: string;
  threadId?: string;
  queueItemId?: string;
  gateId?: string;
  cause?: unknown;
}

interface RuntimeMetric {
  type:
    | 'llm_call'
    | 'tool_exec'
    | 'queue_wait'
    | 'turn_complete'
    | 'decision_gate_wait'
    | 'sandbox_exec'
    | 'model_failover'
    | 'compaction'
    | 'reconciliation'
    | 'lease_reclaim'
    | 'settlement'
    | 'attempt_replaced';
  sessionId: string;
  threadId?: string;
  durationMs?: number;
  model?: string;
  toolName?: string;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
  properties?: Record<string, unknown>;
}
```

Required behavior:

- Recoverable thread errors emit an `error` event and mark the active queue item complete or failed.
- Fatal session errors update session status to `error`, flush state, and prevent new prompts until restored or restarted.
- Every model call emits token/cost metadata when available.
- Every tool call emits duration and success/failure metadata.
- Every reconciliation decision emits an event naming the branch taken (steps 1–7 of the decision tree) and its outcome.
- Decision gates measure wait duration from creation to terminal state.
- Audit events are the durable record of privileged actions — gate resolutions, credential access, admin operations — emitted through the EventStream with deterministic eventKeys.
- An operator/admin API surface is required for V1: list submissions with their lifecycle state, force-settle a wedged submission, and inspect leases (see Required API Surface).
- Logs may contain IDs and high-level errors, but must not contain secrets, OAuth tokens, command environment secrets, or full credential payloads.

## Conformance

The prose in this spec defines intent; executable contract suites define conformance. The engine ships reusable test suites that any provider implementation must pass:

- **SessionStore contract** — entity round-trips, `updateEntry` in-place transitions, entry/queue/gate persistence.
- **Submission lifecycle contract** — idempotent admission, single-claim exclusivity, lease expiry and reclaim, attempt replacement, **write-fence rejection of superseded attempts**, transactional steer supersession, collect-window durability and merge settlement, two-phase settlement, abort stamping, reconciliation outcomes (including gate-blocked timeout exemption).
- **Restart-safe gate contract** — suspended-turn checkpointing, gate re-arming, deterministic gate identity on replay.
- **EventStream contract** — monotonic offsets, replay-from-offset, live subscription ordering, eventKey-idempotent append, gap-refetch on lossy fan-out.

A backend (SQLite, D1, PostgreSQL) is supported when its store passes these suites, not when it has been manually verified. New invariants added to this spec must land with a corresponding contract test in the same change.
