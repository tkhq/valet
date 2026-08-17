# Sandbox Auth Gateway Design — terminal + VS Code behind service JWTs

**Date:** 2026-07-15
**Status:** Implemented
**Scope:** The in-sandbox auth gateway that consumes the service-JWT primitives auth v2 shipped: a `full` sandbox image profile carrying ttyd + code-server + a gateway daemon, a browser→sandbox reachability path (api reverse-proxy over a per-sandbox Service), and the web UI surfaces (Terminal / VS Code tabs). VNC/browser display is deferred; headless sandboxes are unchanged.

## Context

Auth v2 built and tested the credential chain but shipped no consumer (`docs/specs/2026-07-14-auth-v2-design.md:181` — explicit non-goal):

- `POST /api/sessions/:id/sandbox-jwt` mints a 10-minute HS256 JWT `{sub, sid, iat, exp}` (session-access-gated); the per-session secret `HMAC-SHA256(master, sessionId)` is already injected into every sandbox as `VALET_SANDBOX_JWT_SECRET` (`packages/api/src/auth/sandbox-tokens.ts`, `engine/host.ts mintSandboxEnv`).
- The v2 sandbox image (`docker/Dockerfile.sandbox-k8s`) is **agent-only**: no code-server, no ttyd, no exposed ports. All engine↔sandbox traffic rides `pods/exec`; there is **no** browser→pod path of any kind (no per-sandbox Service — `buildSandboxManifest` doesn't set `spec.service` — no ingress, no proxy route).
- The web UI has no VS Code/terminal embedding and never calls the sandbox-jwt route.
- The legacy `:9000` runner gateway (`packages/runner/src/gateway.ts`) is the working precedent: JWT via `?token=`/bearer → short-lived cookie → reverse-proxy to loopback services.

So this pass is three things at once: bring interactive services back into the v2 image, create the reachability path, and wire the auth chain end-to-end.

## Decisions (locked)

1. **Services this pass: ttyd + code-server.** The sandbox-runtime-v2 spec's two profiles become real:
   - `headless` (default, unchanged): the current agent-only image. Orchestrators and workflow children stay headless.
   - `full`: adds **ttyd** (loopback `:7681`), **code-server** (loopback `:8765`), and the gateway daemon on the single exposed port **`:9000`**. Profile selection rides `SandboxCreateOpts` (interactive coding sessions request `full`); the image is one image with both service sets, started or not by the entrypoint per a `VALET_SANDBOX_PROFILE` env var — two images would double the k8s build/cache cost for no isolation gain.
   - VNC (Xvfb/x11vnc/noVNC) is explicitly deferred — heaviest layer, least used.

2. **Gateway daemon: new package `packages/sandbox-gateway`.** Small Hono app (Node), baked into the image, replacing the legacy runner gateway for v2 (the runner is legacy-frozen; lift its proxy/cookie logic where it fits):
   - Routes: `/ttyd/*` → `127.0.0.1:7681`, `/vscode/*` → `127.0.0.1:8765`, `/health` (unauthenticated liveness). HTTP + WebSocket proxying (both targets are WS-dependent).
   - **Auth model: the implemented HS256 per-session-secret contract** — verify `{sub, sid, exp}` against `VALET_SANDBOX_JWT_SECRET`, reject expired and cross-session (`sid` must equal the sandbox's own session id, delivered as `VALET_SESSION_ID` env — new, injected alongside the existing sandbox env). The sandbox-runtime-v2 spec's JWKS/`kid` key-set sketch is superseded; that spec gets amended in this pass's commit.
   - First valid `?token=` (or bearer) mints an in-memory gateway session cookie (15-minute TTL, `SameSite=None; Secure`) so iframe assets and WS upgrades don't carry the JWT. Token expiry after cookie mint is fine — the cookie is the session; re-entry after cookie expiry re-fetches a JWT (the UI handles it).
   - No unauthenticated internal `/api/*` surface (the legacy gateway's callback routes are v1-only; v2 in-sandbox → api calls use `VALET_SANDBOX_TOKEN` against the api directly — and this pass makes `VALET_API_URL` finally consumed, by the gateway's boot log/health detail if nothing else; the real in-sandbox api client remains follow-up).

3. **Reachability: api reverse-proxy over a per-sandbox Service.** New route `ALL /api/sessions/:id/gateway/*` in `packages/api`:
   - **Session-access-gated** (same check as the sandbox-jwt route) — layer one of two: the api verifies the browser's cookie/session may access this session, then the sandbox gateway independently verifies the JWT. A leaked proxy URL without a valet session gets 401 at the api; a valet session without a fresh JWT gets 401 at the gateway.
   - Proxies HTTP **and WebSocket** to the sandbox's gateway endpoint, path-rewritten (`/api/sessions/:id/gateway/ttyd/…` → `/ttyd/…`). WS proxying uses the same `@hono/node-ws`-adjacent upgrade handling the api already runs for its own socket — the proxy hop is bidirectional pipe after upgrade.
   - **Provider seam (engine contract change — adversarial review required):** `Sandbox` handle gains optional `gatewayEndpoint?(): Promise<{ host: string; port: number } | null>` (null = headless/no gateway). Kubernetes: `buildSandboxManifest` sets `spec.service: true` for `full`-profile sandboxes and the provider returns `status.serviceFQDN:9000`. Docker: the container publishes 9000 to an ephemeral host port; the provider returns `127.0.0.1:<mapped>`. Local provider: null. Providers not implementing the method behave as null — byte-unchanged for existing paths.
   - RBAC: the api's Role needs no new verbs for the proxy itself (it dials the Service DNS, not the k8s API); `services` get/list is added only if the FQDN isn't carried in CR status at the time of need.

4. **Web UI: Terminal and VS Code tabs in the session view.** Each tab renders an iframe pointed at the proxy path. Open flow: fetch `POST /api/sessions/:id/sandbox-jwt` → set iframe src `/api/sessions/:id/gateway/vscode/?token=<jwt>` (gateway swaps it for the cookie). Tab states: hidden for headless sessions (profile known from session metadata), "starting" while `gatewayEndpoint` is null/unready, error panel with retry on 502. No new auth UI — the browser's existing valet session covers the api hop.

5. **Session/profile plumbing.** `SandboxCreateOpts` gains `profile?: "headless" | "full"` (default headless). Interactive sessions created from the web default to `full`; orchestrator and workflow-spawned sessions stay headless. The profile is captured at session build like the rest of the sandbox env (same once-per-build semantics as `mintSandboxEnv`).

   *Amended 2026-08-17.* The profile is a session setting, not a creation-time constant. `PATCH /api/sessions/:id` accepts `profile`, so a person can turn the terminal and the VS Code server on for a session that started headless — the assistant session most of all, which had no other way to reach the tabs. The defaults above are unchanged: nothing is raised to `full` on its own.

   The once-per-build capture still holds, and it is what makes the change non-trivial. A built session froze the profile into its `SandboxCreateOpts`, and `SandboxAttachment` reuses that object on every re-provision. So the route persists the new value, evicts the cached session, and replaces a running sandbox. The workspace survives the replacement; an open terminal does not, so the request is refused while a turn is unsettled, and the web asks for confirmation first.

   `buildAssistantSession` reads the profile from the `agent_sessions` row rather than from its caller's meta. An assistant session is woken by the web, by a channel message, and by a workflow, and only the first waker's build is cached — reading the row is what stops a Slack message from pinning the session back to headless.

6. **Failure behavior.** Gateway up but service down → gateway returns a minimal 502 page naming the service (ttyd/code-server) — the iframe shows it as-is. Sandbox hibernated/unprovisioned → the proxy route returns 409 with a wake hint and the UI triggers the normal ensureReady path (compatible with the hibernation spec's wake-on-touch). JWT expired mid-session → cookie carries on; a fully expired cookie surfaces as the gateway's 401 page and the UI silently re-mints + reloads the iframe once.

## Exit criteria (the dogfood)

On the live Rancher Desktop k3s deployment: start an interactive session (full profile), open the Terminal tab through `localhost:8080` port-forward — get a working shell in `/workspace`; open the VS Code tab — edit a file, confirm via the agent that the edit is visible; verify a second user without session access gets 401 at the proxy; verify a hand-crafted request straight to the pod's Service with no/expired JWT gets 401 at the gateway; `kubectl delete pod` mid-session → tabs recover after controller heal without re-login. On `make dev-local` (docker backend): both tabs work against the mapped port.

## Testing

- **Gateway unit** (`packages/sandbox-gateway`): JWT accept/expired/cross-session-`sid`/bad-signature; cookie mint + TTL; proxy path rewrite; WS upgrade proxying (echo fixture); 502-on-dead-backend.
- **Auth contract:** a JWT minted by `mintSandboxJwt` verifies inside the gateway against the derived secret (extends the existing pinned contract test in the api).
- **Proxy route integration** (api): session-access 401/404 behavior, path rewrite, WS round-trip against a fixture gateway, 409 when no endpoint.
- **Provider:** `gatewayEndpoint` conformance addition (k8s returns FQDN when `spec.service` set; docker returns mapped port; absent method → null path pinned so docker/local/virtual stay byte-unchanged where unimplemented).
- **Image:** `full`-profile boot smoke — all three processes up, headless boot starts none of them.

## Non-goals

- VNC/browser display (Xvfb stack) — next profile increment.
- Per-sandbox ingress hosts (`<session>.sandbox.…`) — documented production upgrade path, not built; the api proxy is the shipped path.
- The general in-sandbox api client / agent-side consumption of `VALET_SANDBOX_TOKEN` beyond what exists (memory routes) — separate follow-up.
- Gateway-managed tunnels (legacy `/t/:name` routes) and cloudflared.
- Rotating the per-session JWT secret mid-session (rotation = re-provision; the RPC-rotation idea from the runtime-v2 sketch is dropped with the JWKS model).
- Auth for `pods/exec` (already cluster-RBAC'd; unrelated to browser traffic).

## Deviations

Implementation choices where the shipped code diverges from this spec's text (Tasks 1-7, commits `d606d0d1..a0adfe89`):

- **The api's WS proxy hop is an outbound `ws`-client pump, not a raw socket pipe.** `@hono/node-ws` never exposes the underlying TCP socket, so `packages/api/src/routes/gateway-proxy.ts` dials the sandbox gateway with a `ws` client, buffers frames sent before that connection opens (pre-open buffering), and pumps `onMessage` in both directions rather than piping raw sockets together as decision 3's "bidirectional pipe after upgrade" phrasing implies.
- **ttyd binds `127.0.0.1` explicitly (`ttyd -W -i 127.0.0.1 -p 7681`)** in `docker/start-full.sh`, a deliberate hardening step vs. the legacy runner gateway's ttyd invocation (which bound all interfaces and relied on the container network boundary alone).
- **The gateway is bundled into the image via a `pnpm --filter @valet/sandbox-gateway deploy --prod /out/gateway` Docker build stage**, not esbuild. `docker/Dockerfile.sandbox-k8s`'s `gateway-build` stage runs `pnpm run build` (tsc) then `pnpm deploy --prod`, producing a pruned, workspace-resolved `node_modules` — the gateway's deps (hono, `@hono/node-server`, `@hono/node-ws`, `ws`) are plain CJS/ESM packages with no native addons, so this matches how `@valet/api` itself is already shipped rather than adding a bundler config.
- **`docker/start-full.sh` backgrounds all three services (code-server, ttyd, gateway) and traps `SIGTERM`/`SIGINT`** to forward to all three PIDs, then re-waits on the gateway PID in a loop so its exit code becomes the script's. The spec/plan sketch of exec'ing the gateway as PID 1 with the OS forwarding signals directly doesn't hold when three processes need to shut down together as PID 1 — nothing forwards signals to backgrounded children by default, so an explicit trap was required (see `18f3be35`, filed as a same-day fix to `112bc430`).
- **The api reads the live sandbox handle via a new engine getter, `SandboxAttachment.current()` (`packages/engine/src/sandbox/attachment.ts`), not `Session.sandbox`.** `Session.sandbox` is `PolicySandbox`-backed and force-provisions on access; the proxy route (and its 409 `{wake:true}` semantics) must be able to observe "no sandbox attached" without triggering a cold start. `current()` is a read-only peek: `null` unless the attachment state is already `ready`, never kicks `ensureReady`.
- **HTTP header forwarding to the sandbox is an explicit allowlist plus a `gateway_session`-only cookie filter** (`packages/api/src/routes/gateway-proxy.ts`, `createProxyHeaders`/`filteredGatewaySessionCookie`), not the blanket copy decision 3 leaves ambiguous — the browser's real valet auth cookies/headers (`x-api-key`, `x-valet-test-user-id`, session cookies) must never cross into the semi-trusted sandbox.
- **Web tabs precede the iframe `src` set with a same-origin `fetch` status check** (`packages/web/src/components/session/sandbox-tabs.tsx`) rather than relying on the iframe alone, since an iframe has no way to report the HTTP status of what it loaded. A 401 from that precheck triggers one silent JWT re-mint + retry (matching decision 6's "UI silently re-mints + reloads the iframe once"); a 502 renders inline as the "service down" error state.

Verified against `git log --oneline d606d0d1^..a0adfe89` and the corresponding diffs; no additional undocumented deviations found beyond the above.
