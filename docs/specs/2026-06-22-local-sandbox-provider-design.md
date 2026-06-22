# Local Sandbox Provider — Design

**Date:** 2026-06-22
**Status:** Draft — proposal for discussion (do not implement yet)
**Author:** Xiangan

## Problem

You can develop most of Valet locally, but you **cannot run a real session locally**, and the failure is silent-ish and abrupt.

Valet splits cleanly into two halves:

- **Cloudflare half — runs fully locally.** Worker + the three Durable Objects + D1 + R2 (`make dev-worker`/`wrangler dev`), the React client (`pnpm dev`), the OpenCode container (`make dev-opencode`), and even the Bun runner as a standalone process (`packages/runner/src/bin.ts --opencode-url …`). All of this is laptop-friendly today.
- **Modal half — cloud-only.** The Python backend (`backend/app.py`) that spawns the per-session **sandbox** is deploy-to-Modal only (no `modal serve` path wired), and a real sandbox (the Debian container running the auth gateway, code-server, noVNC, TTYD, and OpenCode) is inherently Modal infrastructure.

The seam between the halves is `MODAL_BACKEND_URL`. Locally it defaults to `http://localhost:9999/{label}` (`packages/worker/.dev.vars`, `wrangler.local.toml`), **but nothing in the repo listens on `:9999`.** So when a local worker creates a session, `SessionLifecycle.spawnSandbox()` (`packages/worker/src/durable-objects/session-lifecycle.ts`) does `fetch('http://localhost:9999/create-session')`, the connection is refused, and the session transitions straight to `error`. There is no mock, no fallback, and no graceful degradation.

**Net:** session-lifecycle code, the session UI flow, and anything that needs a live agent can only be exercised against cloud Modal.

## Goal

Make it possible to develop and test the **whole** session flow locally, and make the sandbox backend pluggable so Modal is one provider rather than a hard dependency.

## Non-goals

- Replacing Modal in production. Modal stays the prod provider.
- 1:1 production parity for the local provider (snapshots/hibernation may degrade locally — see Open Questions).
- Changing the worker's session state machine. The worker is already provider-agnostic (see below); it should not need to change.

## Key observation: the seam is already an HTTP contract

The worker never imports Modal. It only speaks HTTP to a backend that returns `{ sandboxId, tunnelUrls }`. From `session-lifecycle.ts` + `backend/app.py`, the contract is:

| Operation | Request | Response |
|---|---|---|
| `create-session` | session/config | `{ sandboxId, tunnelUrls: Record<string,string> }` |
| `restore-session` | `{ sandboxId, … }` | `{ sandboxId, tunnelUrls }` |
| `terminate-session` | `{ sandboxId }` | ok |
| `hibernate-session` | `{ sandboxId }` | snapshot ref |
| `session-status` | `{ sandboxId }` | status |
| `delete-workspace` | `{ … }` | ok |

`tunnelUrls` maps a service name → URL (auth gateway `:9000`, code-server, noVNC, TTYD, OpenCode `:4096`). **Anything that implements these six endpoints and returns reachable `tunnelUrls` is a valid sandbox backend** — Modal is just today's implementation. That is exactly the abstraction Conner is reaching for; it mostly already exists at the HTTP boundary.

## Proposed approach — phased

### Phase 0 — Hybrid: local control plane → dev Modal (works *today*, zero build)
Point `MODAL_BACKEND_URL` at the **deployed dev** Modal backend (`https://<workspace>--dev-{label}.modal.run`) and run worker + DOs + D1 + R2 + client locally. Sessions spin up real sandboxes in the cloud; everything else is local with hot reload. This is the realistic dev loop right now — it just needs documenting (and ideally a `make dev-hybrid` that wires the env var). Minimal cloud dependency: a Modal account + the dev backend + `ANTHROPIC_API_KEY`.

### Phase 1 — Local stub backend on `:9999`
A tiny Bun/Node service (`packages/local-sandbox/` or `scripts/`) implementing the six endpoints with **canned** responses (fake `sandboxId`, `tunnelUrls` pointing at localhost). It does not run a real agent — it lets the worker/DO/UI exercise the full lifecycle state machine (`initializing → running → hibernating → restoring → terminated`) and lets integration tests cover session flows without Modal. Closes the "session immediately errors locally" gap and makes the `:9999` placeholder real.

### Phase 2 — Local Docker provider (the real fix)
Flesh the stub into a provider that drives **local Docker** using the existing `docker/Dockerfile.sandbox` image:
- `create` → `docker run` the sandbox image, publish its service ports to localhost, return them as `tunnelUrls`.
- `terminate` → `docker rm -f`.
- `restore`/`hibernate` → `docker commit` + restart, or a warm no-op locally (see Open Questions).

This yields **real end-to-end sessions on a laptop** — the agent, IDE, terminal, and VNC all running in local Docker — with no Modal. This is Conner's "better sandbox abstraction with a local docker provider."

### Phase 3 — Formalize the provider abstraction
Extract a `SandboxProvider` interface (`create/restore/terminate/hibernate/status/deleteWorkspace`) so Modal and Docker are pluggable implementations, and generalize the env var (`MODAL_BACKEND_URL` → `SANDBOX_BACKEND_URL`, with a back-compat alias). The worker stays unchanged.

## Open questions / risks

- **Hibernate/restore:** Modal has native memory snapshots; Docker has no equivalent. Local options: `docker commit` + cold restart, or keep local sessions warm and make hibernate a no-op. Pick acceptable local semantics.
- **Tunnel URLs + auth gateway:** Modal returns public HTTPS tunnels; local Docker returns `localhost:PORT`. The auth-gateway JWT/origin checks and the client's VNC/TTYD iframe embedding likely need a local-origin allowance.
- **Image weight:** `Dockerfile.sandbox` is heavy (Xvfb + VNC + code-server + OpenCode). A full sandbox per session is laptop-intensive — consider a slimmer headless local profile. Keep `IMAGE_BUILD_VERSION` parity with Modal.
- **Secrets:** a real local agent still needs `ANTHROPIC_API_KEY` (and integration OAuth/secrets) regardless of provider.

## Scope of this PR

**Design only** — align on direction before building. If the phasing lands, the first concrete deliverables are: (1) document + `make dev-hybrid` for Phase 0, and (2) the Phase 1 `:9999` stub. Phases 2–3 are follow-ups.
