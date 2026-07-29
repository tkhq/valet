# @valet/engine

The portable agent runtime. It runs the agent loop (over pi-agent-core),
owns session/thread state, executes tools, persists a durable transcript,
and emits typed events. Hosts inject every platform concern through a
`ProviderBundle` — this package has zero platform dependencies and never
imports Hono or knows HTTP.

`packages/api` is the production host. The design spec is
[`docs/specs/2026-05-02-portable-runtime-engine-design.md`](../../docs/specs/2026-05-02-portable-runtime-engine-design.md);
later dated specs in `docs/specs/` extend it (orchestrator, sandbox
runtime v2, engine traces).

## Capabilities

- **Public API**: `createSession`, `restoreSession`, `getSession`,
  `deleteSession`; `Session.prompt`, `.thread()`, `.resolveDecision`,
  `.withdrawDecision`, `.abort/pause/resume`, `.setModel`, `.setStartRef`.
- **Threads**: each thread owns its own pi-agent-core `Agent`, queue, and
  DAG history. Threads run concurrently and share the session's sandbox.
  Queue modes: `followup` (FIFO), `steer` (supersede + start), `collect`
  (buffered window).
- **Durable submissions**: idempotent admission by `dispatchId`, CAS
  claiming, leases with expiry takeover, attempt markers, abort stamps,
  and fenced two-phase settlement. Boot-time reconciliation resumes every
  session with unsettled work — a crash never loses an accepted prompt.
- **Decision gates**: a tool calls `ctx.requestDecision(...)` and the turn
  suspends durably. Gate IDs are deterministic
  (`gate:{sessionId}:{threadId}:{queueItemId}:{resumeKey}`), so a restart
  re-arms pending gates and replays the suspended tool with
  `ctx.suspendedDecision` populated. Gates expire on a timer and withdraw
  on steer or abort.
- **Tools**: built-ins `read`, `write`, `edit`, `bash` (with job mode for
  long commands), `thread_read`. Plugin actions bridge into the same
  `ToolDef` shape via `tool-bridge.ts`.
- **Compaction**: proactive and reactive context compression with a
  pruning pass, summary entries, and file-context extraction.
- **Model resolution**: a host `resolveModel` seam resolves the session's
  canonical model spec to a wire model + per-turn API key on every turn.
  `NoCredentialsError` releases the claim for bounded keyless retries.
- **Sandbox attachment**: a lazy state machine (`PolicySandbox` +
  `SandboxAttachment`) that provisions on first touch, runs the host
  `prepareSandbox` hook once per epoch, degrades on transport failure, and
  supports hibernation on capable backends.
- **Traces**: per-turn usage/cost persisted on assistant entries, session
  start-refs, settle-time patch capture to the `BlobStore`, and direct
  OpenTelemetry instrumentation (`@opentelemetry/api` only — a no-op until
  a host registers an SDK).
- **In-memory providers**: `InMemorySessionStore`, `InMemoryEventStream`,
  `InMemoryBlobStore`, `InMemoryCredentialStore`, `VirtualSandbox` /
  `VirtualSandboxProvider`. These double as test fixtures.

## Providers

The host supplies a `ProviderBundle`:

| Provider | Interface | Production impl |
|----------|-----------|-----------------|
| `store` | `SessionStore` | `PgSessionStore` (`@valet/store-postgres`) |
| `stream` | `EventStream` | `PgEventStream` (`@valet/store-postgres`) |
| `sandboxProvider` | `SandboxProvider` | docker / kubernetes / local |
| `credentials` | `CredentialStore` | the api's encrypted credentials table |
| `blobs` | `BlobStore` (optional) | filesystem blob store |

Store implementations must pass the exported contract suites
(`runSessionStoreContract`, `runEventStreamContract`, plus the concurrency
and restart-safe-gates contracts). `InMemorySessionStore` and
`PgSessionStore` both do.

## Tests

```sh
pnpm --filter @valet/engine test
```

The suite covers the happy path, decision gates (including kill-and-restart
replay), queue modes, multi-thread, reconciliation, compaction, model and
credential resolver seams, sandbox attachment and hibernation, tracing,
and the store contracts against both backends.
