# Sandbox Runtime v2

> Defines what runs inside a v2 sandbox: the data-plane transport options (in-sandbox daemon vs provider-SDK adapter), service profiles, the auth gateway, boot sequence, tunnels, and secrets handling. The agent loop does not live here.

## Scope

This spec covers:

- What the v2 sandbox is and is not (post-Runner, post-OpenCode)
- Data-plane transports: `sandboxd` (in-sandbox daemon) and provider-SDK adapters
- Service profiles: `full` (dev environment) vs `headless`
- The auth gateway for dev services (VS Code, VNC, terminal)
- Boot sequence and readiness semantics (feeding the engine's lazy attachment)
- Tunnels, health, and secrets handling
- Per-backend notes (Modal, Kubernetes, Docker, local)

### Boundary Rules

- This spec does NOT cover the `Sandbox`/`SandboxProvider` engine contracts, capabilities, or attachment lifecycle — engine spec (`2026-05-02-portable-runtime-engine-design.md`). This spec implements them.
- This spec does NOT cover image building (Dockerfiles, Modal image definitions, version pinning, warm pools) — `sandbox-images.md` territory; v2 images get their own successor doc when implementation starts.
- This spec does NOT cover the agent loop, tools, or prompt handling — none of it runs in the sandbox.

## What the Sandbox Is Now

The v2 sandbox is a **workbench with an optional workshop window**: a filesystem and shell the engine operates remotely, plus (for interactive sessions) user-visible dev services. Deleted relative to the legacy sandbox:

| Legacy component | Fate |
|---|---|
| Runner (~6000 lines: WS client, ChannelSession state machine, OpenCode lifecycle, model failover, resync) | Gone — the engine owns all of it, outside the sandbox |
| OpenCode server (agent loop, 73 tools, plugins) | Gone — engine loop; tools are engine-side ToolDefs |
| Runner↔DO WebSocket protocol | Gone — the sandbox initiates no connections |
| Gateway memory/spawn/channel-reply callbacks (`/api/memory*`, `/api/spawn-child`, `/api/channel-reply`) | Gone — those tools execute in the engine and call the app API directly |
| Persona/skill file delivery into the sandbox | Gone — roles/skills are engine-side sources |
| In-sandbox provider API keys (`ANTHROPIC_API_KEY`, …) | Gone — model calls happen in the engine |

The sandbox is a **pure server**: the engine calls in; nothing calls out. It holds no session state, no secrets beyond its own auth material, and no knowledge of users, channels, or models. A sandbox that dies loses only uncommitted workspace changes not yet covered by the provider's workspace-survival mechanism.

## Data-Plane Transports

The engine sees only the `Sandbox` interface; how operations reach the container is a per-provider implementation choice. Two sanctioned transports:

### 1. `sandboxd` — the in-sandbox daemon (standard)

A single small process (Bun, one static entry) baked into Valet images, serving the engine's Sandbox RPC contract (the route table in the engine spec: files, exec, snapshot hooks, tunnels, health) over HTTP on one port. Auth is a bearer token scoped to `(sessionId, sandboxId)`, minted per attachment and rotated on re-attachment.

Why it's the standard for Valet images:

- **Uniform semantics across backends** — one conformance target for exec timeout behavior, output limits, path policy, binary handling; no per-provider quirks (argv-only exec, missing native `stat`, stream-draining) leaking upward.
- **It has to exist anyway for `full` profile** — the auth gateway (below) is an in-sandbox process; folding the data plane into the same process adds one route group, not one component.
- **Lower per-operation latency** than provider control-plane round-trips once the sandbox is warm, which matters for read/edit-heavy coding loops.

### 2. Provider-SDK adapter (sanctioned alternative)

A `Sandbox` implementation that calls the provider's own SDK directly — exec through the provider's exec API (shell-wrapped where argv-only), filesystem via native APIs where they exist and coreutils shell-outs where they don't. No Valet code runs inside the container; any image with `bash` + coreutils works.

Appropriate when: the image is not Valet-controlled (user-supplied images, third-party backends under evaluation), or the session profile is `headless` and the provider's SDK surface is sufficient. The engine's policy wrapper (abort checks, path resolution, write-retry) sits above either transport identically, and both must pass the same sandbox provider conformance suite — transport is invisible above the `Sandbox` seam.

## Service Profiles

Sessions declare a profile in `SandboxCreateOpts.metadata.profile`:

| | `headless` | `full` |
|---|---|---|
| Runs | `sandboxd` only (or nothing, with an SDK adapter) | `sandboxd` + code-server + Xvfb/x11vnc/noVNC + ttyd |
| Used by | orchestrator sandboxes, workflow children, CI-style runs | interactive coding sessions |
| Readiness | `sandboxd /health` OK | `sandboxd /health` OK — dev services warm in background |
| Boot target | < 2s past container start | < 2s to ready; dev services follow |

Dev services are **never** on the readiness path. Readiness means the data plane answers; a user clicking the VS Code tab a second after session start may see a brief service-warming state, but the agent's tool calls never wait on code-server.

## Auth Gateway

In `full` profile, `sandboxd` also serves the gateway role on its single exposed port:

- Routes `/vscode/*` → code-server, `/vnc/*` → noVNC, `/ttyd/*` → ttyd (loopback-bound internal services; only the gateway port is exposed).
- Browser access authenticates with a short-lived JWT (issued by the app layer, validated against a public key delivered at sandbox create) carrying `sessionId` + user identity; the RPC route group accepts only the attachment bearer token. The two credential planes never cross.
- WebSocket upgrade pass-through for all three services.
- Tunnel registry: `GET /tunnels` reports provider tunnel URLs plus any dev-server ports the agent registered for user preview.

## Boot Sequence

```
container start
  → sandboxd starts, binds gateway port, loads auth material from env
  → /health returns ready                      ← engine attachment becomes 'ready'
  → (full profile) dev services spawn in background, supervised
  → workspace materialization if provider-driven (clone, volume mount) runs
    as a sandboxd-supervised job, reported via /health detail
```

`start.sh` reduces to: exec `sandboxd`. Supervision (dev-service restart on crash, zombie reaping) is `sandboxd`'s job — there is no process manager beside it. Workspace materialization strategy is provider/capability-driven per the engine spec's workspace-survival invariant; `sandboxd` only reports its progress.

## Secrets

- The sandbox's env at boot contains only: its RPC bearer token (or the material to derive it), the JWT validation public key, and workspace materialization credentials (e.g. a scoped git token) when the provider strategy needs them.
- Command-tool secrets are injected **per exec request** in the RPC body and applied to that process's environment only — never written to disk, never in the container's ambient env, never echoed in results.
- The engine's observability contract (no secrets in logs/events) extends to `sandboxd`: request logging redacts env maps wholesale.

## Health and Failure

- `GET /health` → `{ ok, sandboxId, version, profile, services: { vscode?, vnc?, ttyd? }, workspace: { state } }`.
- The engine's attachment monitor treats a failed/timed-out health check as attachment degradation: in-flight sandbox operations fail with structured errors; re-provision proceeds in the background per the engine's lifecycle-decoupling contract. `sandboxd` itself performs no orchestration — it reports, the engine decides.
- Dev-service crashes are restarted by `sandboxd` and reported in `/health`; they never affect data-plane readiness.

## Per-Backend Notes

- **Modal** — Valet image with `sandboxd`; engine reaches the gateway port via Modal tunnels. Snapshot/restore is provider lifecycle (capabilities `snapshot: 'memory'`); `sandboxd` needs no snapshot awareness beyond being restartable. The provider-SDK adapter (Modal JS SDK exec + coreutils shell-outs) is the sanctioned fallback for non-Valet images.
- **Kubernetes** — pod with the Valet image, gateway port via Service; `persistentWorkspace: true` (PVC), `snapshot: 'none'` — restore is recreate + remount, absorbed as background warming.
- **Docker (dev)** — same image locally, port-mapped.
- **Local / Virtual** — no sandbox runtime at all; these implement `Sandbox` in-process (host fs / in-memory) and exist below this spec.

## Conformance

The sandbox provider conformance suite (engine spec) runs against a live `sandboxd` in CI on every image change: filesystem semantics, exec timeout forwarding and output limits, two-tier cancellation, per-request env injection and redaction, auth rejection paths, health shape, and workspace survival across destroy/recreate. The provider-SDK adapters run the same suite; passing it — not manual verification — is what makes a transport supported.
