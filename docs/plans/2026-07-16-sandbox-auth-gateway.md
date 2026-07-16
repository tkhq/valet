# Sandbox Auth Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring interactive services (ttyd terminal + code-server VS Code) into the v2 sandbox behind a per-session JWT auth gateway, reachable from the browser through an api reverse-proxy, surfaced as Terminal/VS Code tabs in the web session view.

**Architecture:** A new Node/Hono daemon `packages/sandbox-gateway` runs on `:9000` inside `full`-profile sandboxes, verifying the HS256 per-session-secret JWTs auth v2 already mints and reverse-proxying (HTTP + WS) to loopback ttyd/code-server. Providers gain an optional `gatewayEndpoint()` seam; the api gains a session-access-gated `ALL /api/sessions/:id/gateway/*` reverse proxy over that endpoint. Two independent auth layers: the api verifies the browser's valet session; the sandbox gateway independently verifies the JWT.

**Tech Stack:** TypeScript (strict, no `any`), Hono 4, `@hono/node-server`, `@hono/node-ws` + `ws`, Drizzle/Postgres (PGlite dev), vitest, Kubernetes (agent-sandbox CRD v0.5.1), Docker CLI.

**Spec:** `docs/specs/2026-07-15-sandbox-auth-gateway-design.md` — its "Decisions (locked)" section is binding; non-goals (VNC, per-sandbox ingress, in-sandbox api client, cloudflared tunnels, JWT-secret rotation) are real.

## Global Constraints

- Every shell command runs under Node 22: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && <cmd>`.
- **Engine contract touchpoint:** Task 1 (`Sandbox.gatewayEndpoint?()` + `SandboxCreateOpts.profile?`) is a shared-contract change — it REQUIRES adversarial review (opus). Providers that don't implement `gatewayEndpoint` and callers passing no `profile` MUST behave byte-identically to today (regression pinned in Task 1; the `release?` optional-method precedent at `packages/engine/src/types.ts:631-651` is the template).
- **Pre-1.0 migrations:** schema changes edit `packages/api/migrations/pg/0000_app.sql` in place + matching Drizzle tables in `packages/api/src/schema/index.ts`. NO numbered migrations. After editing: `rm -rf ~/.valet/pg`.
- PGlite: ONE instance per process — API tests use `freshTestPgDb()` / `bootTestApi`; never a second PGlite.
- Type safety: no `any`, no `as unknown as T`, no `@ts-ignore`.
- Root `pnpm typecheck` does NOT cover `packages/web` — run `cd packages/web && pnpm typecheck` separately.
- No Co-Authored-By trailers.
- **Kubernetes context safety (BINDING):** the ambient kubectl context is a PROD GKE cluster. Every cluster op pins `--context rancher-desktop`. Cluster tests/dogfood only; never touch the ambient context.
- **JWT contract (verbatim from auth v2, `packages/api/src/auth/sandbox-tokens.ts`):** secret = `HMAC-SHA256(master, sessionId)` hex; JWT is HS256 `{sub: userId, sid: sessionId, iat, exp}`, base64url, `exp` in unix seconds. The gateway verifies with `timingSafeEqual` (reuse `verifySandboxJwt` semantics, NOT the legacy WebCrypto `verifyJWT`) AND additionally requires `sid === VALET_SESSION_ID`.
- **Gateway env contract:** `full` sandboxes receive `VALET_SANDBOX_JWT_SECRET` (already injected), plus NEW `VALET_SESSION_ID` and `VALET_SANDBOX_PROFILE`. Services bind loopback only: ttyd `127.0.0.1:7681`, code-server `127.0.0.1:8765`, gateway exposed `:9000`.
- **Cookie contract:** name `gateway_session`, 15-min TTL, `Path=/; SameSite=None; Secure`, in-memory session map.

---

### Task 1: Engine contract — `gatewayEndpoint?()` + `SandboxCreateOpts.profile?`

**Files:**
- Modify: `packages/engine/src/types.ts` (`Sandbox`, `SandboxCreateOpts`)
- Modify: `packages/engine/src/test-helpers/sandbox-contract.ts` (optional conformance case)
- Test: `packages/engine/test/` — a focused type/contract test, plus the existing provider conformance runners (virtual path).

**Interfaces:**
- Produces (consumed by Tasks 3, 5, 6): `Sandbox.gatewayEndpoint?(): Promise<GatewayEndpoint | null>` where `GatewayEndpoint = { host: string; port: number }`; `SandboxCreateOpts.profile?: "headless" | "full"`.
- Conformance: `SandboxContractContext` gains `gatewayEndpoint?: "service-fqdn" | "mapped-port" | "null"` describing the expected shape; the suite adds one optional case gated on it.

- [ ] **Step 1: Write the failing conformance/type test**

In `packages/engine/test/` add `sandbox-gateway-contract.test.ts` driving `VirtualSandboxProvider` (which must expose no `gatewayEndpoint` → the absent-method path):

```ts
import { describe, expect, it } from "vitest";
import { VirtualSandboxProvider } from "../src/index.js";

describe("Sandbox.gatewayEndpoint contract", () => {
  it("is absent on providers that don't implement it (byte-identical null path)", async () => {
    const provider = new VirtualSandboxProvider();
    const sandbox = await provider.create({ workspace: "/w" });
    expect(sandbox.gatewayEndpoint).toBeUndefined();
  });

  it("SandboxCreateOpts accepts a profile without affecting virtual create", async () => {
    const provider = new VirtualSandboxProvider();
    const headless = await provider.create({ workspace: "/a", profile: "headless" });
    const full = await provider.create({ workspace: "/b", profile: "full" });
    // virtual ignores profile; both are usable sandboxes with no gateway
    expect(headless.gatewayEndpoint).toBeUndefined();
    expect(full.gatewayEndpoint).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/engine test -- sandbox-gateway-contract`
Expected: FAIL — `profile` not assignable to `SandboxCreateOpts` (tsc error) or the test file doesn't compile.

- [ ] **Step 3: Add the contract types**

In `packages/engine/src/types.ts`, add above the `Sandbox` interface:

```ts
export interface GatewayEndpoint {
  host: string;
  port: number;
}
```

Add to `Sandbox` (after `cancelJob?`, mirroring the optional-method style):

```ts
  /**
   * The in-sandbox auth gateway's reachable endpoint, or null when this
   * sandbox has no gateway (headless profile / providers without interactive
   * services). Absent method === always null — existing paths unchanged.
   */
  gatewayEndpoint?(): Promise<GatewayEndpoint | null>;
```

Add to `SandboxCreateOpts` (after `metadata?`):

```ts
  /** Interactive-service profile. Default "headless" (agent-only). "full"
   * additionally runs ttyd + code-server + the auth gateway. */
  profile?: "headless" | "full";
```

- [ ] **Step 4: Add the optional conformance case**

In `packages/engine/src/test-helpers/sandbox-contract.ts`, add `gatewayEndpoint?: "service-fqdn" | "mapped-port" | "null"` to `SandboxContractContext`, and a case:

```ts
if (ctx.gatewayEndpoint) {
  it("gatewayEndpoint reflects the provider's reachability model", async () => {
    const { sandbox, cleanup } = await ctx.factory();
    try {
      if (ctx.gatewayEndpoint === "null") {
        // absent method or null return, both acceptable
        const ep = sandbox.gatewayEndpoint ? await sandbox.gatewayEndpoint() : null;
        expect(ep).toBeNull();
      } else {
        if (!sandbox.gatewayEndpoint) throw new Error("expected gatewayEndpoint implemented");
        const ep = await sandbox.gatewayEndpoint();
        expect(ep).not.toBeNull();
        expect(typeof ep?.host).toBe("string");
        expect(ep?.port).toBeGreaterThan(0);
      }
    } finally {
      await cleanup?.();
    }
  });
}
```

Existing conformance callers pass no `gatewayEndpoint` → the case is skipped → byte-identical.

- [ ] **Step 5: Run tests + full engine suite (byte-identical pin)**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/engine test && pnpm typecheck`
Expected: all pass; the pre-existing conformance suites (virtual/local/docker) unchanged and green = the absent-method regression pin.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/types.ts packages/engine/src/test-helpers/sandbox-contract.ts packages/engine/test/sandbox-gateway-contract.test.ts
git commit -m "feat(engine): Sandbox.gatewayEndpoint seam + SandboxCreateOpts.profile"
```

---

### Task 2: `packages/sandbox-gateway` — the daemon

**Files:**
- Create: `packages/sandbox-gateway/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/sandbox-gateway/src/jwt.ts` (verify — lift the Node-crypto contract, NOT the legacy WebCrypto version)
- Create: `packages/sandbox-gateway/src/gateway.ts` (Hono app: auth, HTTP proxy, /health, 502)
- Create: `packages/sandbox-gateway/src/ws-proxy.ts` (WS bidirectional pipe over `@hono/node-ws` + `ws`)
- Create: `packages/sandbox-gateway/src/bin.ts` (Node entrypoint: read env, start server, injectWebSocket)
- Create: `packages/sandbox-gateway/test/fake-backend.ts` (loopback ttyd/code-server fixtures — HTTP + WS echo)
- Test: `packages/sandbox-gateway/src/jwt.test.ts`, `gateway.test.ts`, `ws-proxy.test.ts`

**Interfaces:**
- Produces: `startGateway(opts: { port: number; sessionId: string; jwtSecret: string; targets: { ttyd: number; vscode: number } }): { server: import("node:http").Server; close(): Promise<void> }`. `verifyGatewayJwt(secret, token, expectedSid): { sub: string; sid: string } | null`. Route table: `/health` (no auth), `/ttyd/*` → `127.0.0.1:{ttyd}`, `/vscode/*` → `127.0.0.1:{vscode}`.
- Consumes: nothing from other tasks (self-contained; JWT contract is the Global Constraints copy).

- [ ] **Step 1: Package scaffolding**

`packages/sandbox-gateway/package.json`:

```json
{
  "name": "@valet/sandbox-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/bin.js",
  "types": "./dist/bin.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc -p tsconfig.test.json --noEmit",
    "test": "vitest run",
    "start": "node ./dist/bin.js"
  },
  "dependencies": {
    "hono": "^4.3.0",
    "@hono/node-server": "^1.13.0",
    "@hono/node-ws": "^1.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.1",
    "typescript": "^5.3.3",
    "vitest": "^4.0.18"
  }
}
```

(Copy exact hono/@hono versions from `packages/api/package.json`.) Add `tsconfig.json` (src-only build, `rootDir: "./src"`, `include: ["src/**/*"]`, `exclude: ["src/**/*.test.ts"]`) and `tsconfig.test.json` (`rootDir: "."`, `include: ["src/**/*", "test/**/*"]`, `noEmit: true`) mirroring `packages/plugin-telegram`'s split (learned in the telegram arc — prevents `dist/` nesting). `vitest.config.ts`: `{ test: { environment: "node", include: ["src/**/*.test.ts", "test/**/*.test.ts"] } }`. Add to root `tsconfig.json` references and run `pnpm install`.

- [ ] **Step 2: JWT verify — failing test**

`packages/sandbox-gateway/src/jwt.test.ts`:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGatewayJwt } from "./jwt.js";

function mint(secret: string, payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signingInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${sig}`;
}

const SECRET = "deadbeef";
const now = Math.floor(Date.now() / 1000);

describe("verifyGatewayJwt", () => {
  it("accepts a valid token whose sid matches", () => {
    const t = mint(SECRET, { sub: "u1", sid: "s1", iat: now, exp: now + 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toEqual({ sub: "u1", sid: "s1" });
  });
  it("rejects a cross-session sid", () => {
    const t = mint(SECRET, { sub: "u1", sid: "OTHER", iat: now, exp: now + 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toBeNull();
  });
  it("rejects an expired token", () => {
    const t = mint(SECRET, { sub: "u1", sid: "s1", iat: now - 1200, exp: now - 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toBeNull();
  });
  it("rejects a bad signature", () => {
    const t = mint("WRONG", { sub: "u1", sid: "s1", iat: now, exp: now + 600 });
    expect(verifyGatewayJwt(SECRET, t, "s1")).toBeNull();
  });
  it("rejects malformed input", () => {
    expect(verifyGatewayJwt(SECRET, "not.a.jwt.x", "s1")).toBeNull();
    expect(verifyGatewayJwt(SECRET, "onlyonepart", "s1")).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure, implement `jwt.ts`**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/sandbox-gateway test -- jwt`
Expected: FAIL — module not found.

`packages/sandbox-gateway/src/jwt.ts` — reuse the `verifySandboxJwt` algorithm from `packages/api/src/auth/sandbox-tokens.ts:144-166` verbatim (read it), adding the `expectedSid` gate:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

interface Payload { sub?: string; sid?: string; exp?: number }

export function verifyGatewayJwt(
  secret: string,
  token: string,
  expectedSid: string,
): { sub: string; sid: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload.sid !== expectedSid) return null;
  return { sub: payload.sub, sid: payload.sid };
}
```

Run the test → PASS.

- [ ] **Step 4: Fake backend fixture + HTTP proxy failing test**

`packages/sandbox-gateway/test/fake-backend.ts` — two Hono servers (or one on two ports) that echo: an HTTP route returning a marker per port, and a WS route that echoes frames (for Task step 6). Structure like the telegram `startFakeBotApi` fixture: `startFakeBackend(): Promise<{ ttydPort: number; vscodePort: number; close(): Promise<void> }>` using `@hono/node-server` `serve({ port: 0 })` + `createNodeWebSocket` for the WS echo.

`packages/sandbox-gateway/src/gateway.test.ts` (HTTP + auth):

```ts
// startGateway with sessionId "s1", jwtSecret SECRET, targets = fake backend ports.
// mint a valid JWT for s1.
// cases:
//  - GET /health with no auth → 200 { status: "ok" }
//  - GET /vscode/ with ?token=<jwt> → 200, body from the vscode fake, Set-Cookie gateway_session present
//  - GET /ttyd/ with the minted cookie (no token) → 200 from ttyd fake
//  - GET /vscode/ with no token and no cookie → 401
//  - GET /vscode/ with an expired token → 401
//  - backend down (point targets at a closed port) → 502 with a body naming the service
```

Write real assertions (fetch against `http://127.0.0.1:${gatewayPort}`, read Set-Cookie, reuse it on the second request).

- [ ] **Step 5: Run to verify failure, implement `gateway.ts`**

Lift from `packages/runner/src/gateway.ts` (read it) — the liftable pieces are `createProxyHeaders` (strips accept-encoding/hop-by-hop, forces `Accept-Encoding: identity`), `parseCookies`, the `fetch`-based HTTP proxy body, cookie constants. Rewrite for a clean Hono-on-Node app WITHOUT the legacy module-level `pendingSessionCookie` singleton (that race was flagged in the source; set the cookie via Hono's `c.header("Set-Cookie", …)` on the response directly). Auth: cookie-first (in-memory `Map<token, { sub; sid; expiresAt }>`), else `?token=`/`Bearer` → `verifyGatewayJwt(secret, token, sessionId)` → mint cookie. 502 body: `Response(\`${service} is not reachable\`, { status: 502 })`.

`startGateway` builds the Hono app, wires `createNodeWebSocket` (Task step 7), `serve({ fetch, port })`, `injectWebSocket`, returns `{ server, close }`.

Run gateway.test → PASS.

- [ ] **Step 6: WS proxy — failing test**

`packages/sandbox-gateway/src/ws-proxy.test.ts`: connect a `ws` client to `ws://127.0.0.1:{gateway}/ttyd/?token=<jwt>`, expect the frame to round-trip through to the fake ttyd echo and back; assert the `tty` subprotocol is forwarded for the ttyd target; assert an unauthenticated WS upgrade is rejected (close code). One case for `/vscode/` without the `tty` subprotocol.

- [ ] **Step 7: Implement `ws-proxy.ts`**

Rewrite the legacy Bun WS pipe (`gateway.ts:1993-2142`) for Node: the gateway registers `upgradeWebSocket` handlers for `/ttyd/*` and `/vscode/*`. In `onOpen`, authenticate (cookie or `?token=`), then open an outbound `new WebSocket("ws://127.0.0.1:{port}{rewrittenPath}", protocols)` from the `ws` package — `protocols = port === ttyd ? ["tty"] : undefined`, `binaryType = "arraybuffer"`. Buffer client→backend frames until the backend socket opens (pre-open buffer), then pipe both directions; mirror close codes. Strip `token` from the upstream URL. Errors close both sides.

Run ws-proxy.test → PASS.

- [ ] **Step 8: `bin.ts` entrypoint**

Reads `process.env`: `VALET_SESSION_ID` (→ expectedSid), `VALET_SANDBOX_JWT_SECRET`, ports (constants: ttyd 7681, vscode 8765, gateway 9000). Fails loudly (exit 1 + log) if `VALET_SESSION_ID` or `VALET_SANDBOX_JWT_SECRET` is missing. Calls `startGateway`, logs `VALET_API_URL` in the boot line (satisfies the spec's "VALET_API_URL finally consumed" note). No test needed beyond typecheck (thin wiring).

- [ ] **Step 9: Full package tests + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/sandbox-gateway test && pnpm --filter @valet/sandbox-gateway typecheck && pnpm --filter @valet/sandbox-gateway build && ls packages/sandbox-gateway/dist/bin.js`
Expected: green; `dist/bin.js` at top level.

- [ ] **Step 10: Commit**

```bash
git add packages/sandbox-gateway pnpm-lock.yaml tsconfig.json
git commit -m "feat(sandbox-gateway): JWT-gated ttyd/code-server reverse proxy daemon"
```

---

### Task 3: Provider `gatewayEndpoint()` + `full`-profile wiring

**Files:**
- Modify: `packages/sandbox-kubernetes/src/types.ts` (`SandboxCRSpec.service?`, `SandboxCRStatus.service?/serviceFQDN?`), `src/lifecycle.ts` (`parseStatus`), `src/manifest.ts` (`spec.service` + full-profile command), `src/provider.ts` (`KubernetesSandbox.gatewayEndpoint`)
- Modify: `packages/sandbox-docker/src/sandbox.ts` (`-p 127.0.0.1::9000` for full, `DockerSandbox.gatewayEndpoint` via inspect)
- Test: `packages/sandbox-kubernetes/src/manifest.test.ts` (or sibling), `packages/sandbox-docker/src/sandbox.test.ts`, + conformance opt-in.

**Interfaces:**
- Consumes: `GatewayEndpoint`, `SandboxCreateOpts.profile` (Task 1).
- Produces: k8s manifest sets `spec.service: true` and a services-starting command when `profile === "full"`; `parseStatus` surfaces `serviceFQDN`; `KubernetesSandbox.gatewayEndpoint()` returns `{ host: serviceFQDN, port: 9000 } | null`. Docker publishes `9000` to an ephemeral loopback port for `full`; `DockerSandbox.gatewayEndpoint()` returns `{ host: "127.0.0.1", port: mapped } | null`.

- [ ] **Step 1: k8s manifest + status — failing tests**

Add to the k8s manifest test file: `buildSandboxManifest` with `profile: "full"` sets `spec.service === true` and the container `command` starts services (assert command is NOT the bare `tail -f /dev/null`); with `profile` omitted/`"headless"`, `spec.service` is undefined and command is unchanged (byte-identical pin). Add a `parseStatus`/`parseSandboxCRRead` test: a CR read whose `status.serviceFQDN` is set surfaces it on the parsed status.

- [ ] **Step 2: Run to verify failure, implement k8s**

- `types.ts`: add `service?: boolean` to `SandboxCRSpec`; `service?: string` + `serviceFQDN?: string` to `SandboxCRStatus`.
- `lifecycle.ts` `parseStatus` (~283-292): read `status.serviceFQDN`/`status.service` off the raw object and carry them on the returned status.
- `manifest.ts` `buildSandboxManifest`: when `opts.profile === "full"`, set `spec.service = true` and replace the container `command` with one that runs the image's service-start entrypoint (the image ENTRYPOINT is bypassed by the explicit `command`; for full, use `command: ["/bin/bash", "/start-full.sh"]` — the entrypoint added in Task 4). Headless path unchanged.
- `provider.ts` `KubernetesSandbox.gatewayEndpoint()`: GET the CR (via `this.deps.objectsApi`/existing status read), return `{ host: serviceFQDN, port: 9000 }` when `spec.service` set and `serviceFQDN` present, else `null`.

Run → PASS.

- [ ] **Step 3: Docker — failing tests**

`packages/sandbox-docker/src/sandbox.test.ts`: assert `full` create includes `-p 127.0.0.1::9000` in the run args (extract the arg-builder into a pure exported helper `buildDockerRunArgs(opts)` so it's unit-testable without a live daemon — the telegram arc's "extract pure function" pattern); headless create includes no `-p` (byte-identical). A live-gated test (skip without Docker) can assert `gatewayEndpoint()` returns a mapped port after a real `full` create.

- [ ] **Step 4: Run to verify failure, implement docker**

- Extract `buildDockerRunArgs` pure helper; add `if (opts.profile === "full") runArgs.push("-p", "127.0.0.1::9000")`.
- `DockerSandbox.gatewayEndpoint()`: `docker inspect -f '{{(index (index .NetworkSettings.Ports "9000/tcp") 0).HostPort}}' {containerId}` → `{ host: "127.0.0.1", port: Number(out) }`; return `null` on empty/error (headless has no published port).
- Local + virtual providers: do NOT implement `gatewayEndpoint` (null path — no change needed; verify the conformance `gatewayEndpoint: "null"` case passes for them if wired).

Run → PASS.

- [ ] **Step 5: Wire conformance opt-in**

In the docker/k8s conformance test contexts, pass `gatewayEndpoint: "mapped-port"` / `"service-fqdn"` as appropriate (k8s cluster test only); local/virtual pass `"null"`. Run the conformance suites that don't need a live cluster.

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/sandbox-kubernetes test && pnpm --filter @valet/sandbox-docker test && pnpm --filter @valet/sandbox-local test && pnpm typecheck`
Expected: green (cluster-gated cases skip without a cluster).

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-kubernetes packages/sandbox-docker
git commit -m "feat(sandbox): gatewayEndpoint + full-profile service exposure (k8s Service, docker port)"
```

---

### Task 4: `full`-profile sandbox image + entrypoint

**Files:**
- Modify: `docker/Dockerfile.sandbox-k8s` (add ttyd + code-server + bundled gateway)
- Create: `docker/start-full.sh` (entrypoint: branch on `VALET_SANDBOX_PROFILE`)
- Modify: `Makefile` if the image build needs the gateway dist bundled (check `k8s-build`)

**Interfaces:**
- Consumes: the `command: ["/bin/bash", "/start-full.sh"]` the k8s full manifest sets (Task 3); `packages/sandbox-gateway` built output.
- Produces: an image where `full` profile starts ttyd (`127.0.0.1:7681`), code-server (`127.0.0.1:8765 --auth none`), and the gateway (`:9000`); `headless` starts nothing (agent-only, unchanged).

- [ ] **Step 1: Dockerfile additions**

Lift install steps from `docker/Dockerfile.sandbox` (read it): code-server via `curl -fsSL https://code-server.dev/install.sh | sh`; ttyd 1.7.7 static binary to `/usr/local/bin/ttyd`. Add a build stage that `pnpm --filter @valet/sandbox-gateway build`s and copies `dist/` + a pruned `node_modules` (or bundle with esbuild) to `/gateway`. Keep the base agent tooling. Do NOT set an ENTRYPOINT that breaks headless (the k8s headless path still overrides `command` with `tail -f /dev/null`).

- [ ] **Step 2: `docker/start-full.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
WORK_DIR=/workspace
mkdir -p "$WORK_DIR"
if [ "${VALET_SANDBOX_PROFILE:-headless}" = "full" ]; then
  code-server --bind-addr "127.0.0.1:8765" --auth none \
    --disable-telemetry --disable-update-check --welcome-text "Valet Workspace" "$WORK_DIR" &
  ttyd -W -i 127.0.0.1 -p 7681 bash -c "cd $WORK_DIR && exec bash -l" &
  exec node /gateway/dist/bin.js
else
  exec tail -f /dev/null
fi
```

(Note `-i 127.0.0.1` binds ttyd to loopback — the spec's hardening over the legacy all-interfaces bind.)

- [ ] **Step 3: Build smoke (documented, cluster-gated)**

Full image builds are ~15-20 min; do NOT run in the inner loop. Add a smoke note to the task: after `make k8s-build`, a `full`-profile pod should show all three processes (`ps` via exec: code-server, ttyd, node gateway); a headless pod shows none. This is verified in Task 8's dogfood, not here. For local iteration, `make dev-local`'s docker backend needs a `full`-capable image — document that `VALET_SANDBOX_IMAGE` must point at the full image when testing docker-backend gateway (and note the api wiring in Task 5 that passes the image).

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile.sandbox-k8s docker/start-full.sh Makefile
git commit -m "feat(docker): full-profile image with ttyd, code-server, bundled gateway"
```

---

### Task 5: Session profile plumbing (env, opts, schema, create route)

**Files:**
- Modify: `packages/api/src/engine/host.ts` (`mintSandboxEnv` emits `VALET_SESSION_ID` + `VALET_SANDBOX_PROFILE`; profile flows into `SandboxCreateOpts`)
- Modify: `packages/api/src/schema/index.ts` + `packages/api/migrations/pg/0000_app.sql` (`profile` column on `agent_sessions`)
- Modify: `packages/api/src/routes/sessions.ts` (create accepts `profile`; persist + return it)
- Modify: `packages/api/src/wire/types.ts` (`CreateSessionRequest.profile?`, `SessionDetail.profile`)
- Test: `packages/api/src/engine/host.test.ts` (or a focused test), `packages/api/src/routes/sessions.test.ts`

**Interfaces:**
- Consumes: `SandboxCreateOpts.profile` (Task 1).
- Produces (consumed by Tasks 6, 7): sessions persist `profile: "headless" | "full"` (default `headless`); `SessionDetail.profile` exposed; orchestrator/child/workflow sessions stay `headless`; interactive (web-created) sessions can request `full`. `mintSandboxEnv` returns `{ VALET_SANDBOX_TOKEN, VALET_API_URL, VALET_SANDBOX_JWT_SECRET, VALET_SESSION_ID, VALET_SANDBOX_PROFILE }`.

- [ ] **Step 1: Schema (Drizzle + SQL in place)**

Add to `agentSessions` in `packages/api/src/schema/index.ts`:

```ts
    profile: text("profile", { enum: ["headless", "full"] }).notNull().default("headless"),
```

Add the matching column to the `agent_sessions` CREATE TABLE in `0000_app.sql`:

```sql
	"profile" text DEFAULT 'headless' NOT NULL
```

Then `rm -rf ~/.valet/pg`.

- [ ] **Step 2: Failing tests**

`host.test.ts`: `mintSandboxEnv(sessionId, userId, orgId, "full")` includes `VALET_SESSION_ID === sessionId` and `VALET_SANDBOX_PROFILE === "full"`; the default/headless call yields `VALET_SANDBOX_PROFILE === "headless"`; the three pre-existing keys are unchanged (byte-identical pin on the existing shape). `sessions.test.ts` (via `bootTestApi`): `POST /api/sessions { workspace, profile: "full" }` persists and `GET` returns `profile: "full"`; omitting profile defaults to `"headless"`.

- [ ] **Step 3: Implement**

- `mintSandboxEnv` gains a `profile: "headless" | "full"` param; returns the two new keys alongside the existing three. Each build call site (`buildSession` create/restore, `buildOrchestratorSession`, `buildChildSession`, `buildWorkflowSession`) passes the session's profile — orchestrator/child/workflow hardcode `"headless"`; `buildSession` reads it from the session row (thread the `profile` through `sessionFor`/`buildSession` meta, defaulting `"headless"`). Add `profile` to the `SandboxCreateOpts` literal (`sandbox: { …, profile }`).
- `sessions.ts` create: read `body.profile` (validate `"headless"|"full"`, default `"headless"`), persist it, include in the response. `SessionDetail`/`SessionSummary` include `profile`; entry mappers set it.
- Wire types: `CreateSessionRequest.profile?: "headless" | "full"`, `SessionDetail.profile: "headless" | "full"`.

Where `sessionFor` doesn't currently carry profile: pass it via the meta object the route already builds (`{ userId, orgId, workspace }` → add `profile`), or have `buildSession` load the session row's profile. Pick the path with the least seam change; the route has the row in hand (`loadOwnedSession`), so pass `profile: row.profile`.

- [ ] **Step 4: Run + full api suite**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test && pnpm typecheck`
Expected: green except the 2 known `messages.abort` failures. No new failures.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src packages/api/migrations/pg/0000_app.sql
git commit -m "feat(api): session profile plumbing — env, opts, schema, create route"
```

---

### Task 6: API reverse-proxy route `ALL /api/sessions/:id/gateway/*`

**Files:**
- Create: `packages/api/src/routes/gateway-proxy.ts` (HTTP proxy handler)
- Modify: `packages/api/src/routes/ws.ts` (or a new ws registration) for the WS upgrade proxy
- Modify: `packages/api/src/app.ts` (mount; the proxy is authed like the rest — session-access gated inside)
- Modify: `packages/api/src/routes/sessions.sandbox-jwt.test.ts` (extend the pinned contract: a `mintSandboxJwt` token verifies against the derived secret using the gateway verifier)
- Test: `packages/api/src/routes/gateway-proxy.test.ts`

**Interfaces:**
- Consumes: `session.gatewayEndpoint()` via the engine session's sandbox handle; session-access gating (`loadOwnedSession`); `SandboxStatus` for the 409 path.
- Produces: `ALL /api/sessions/:id/gateway/*` — session-access-gated (404 for non-owner), path-rewritten (`/api/sessions/:id/gateway/ttyd/…` → `/ttyd/…`) HTTP proxy to `gatewayEndpoint()`; `GET` WS upgrades proxied bidirectionally; 409 `{ error, wake: true }` when the sandbox has no endpoint (unprovisioned/hibernated); 502 when the gateway is unreachable.

- [ ] **Step 1: Extend the pinned JWT contract test**

In `sessions.sandbox-jwt.test.ts`, add: a token minted by the route verifies via `verifyGatewayJwt(deriveSandboxJwtSecret(master, sessionId), token, sessionId)` (import from `@valet/sandbox-gateway`) — proving the api-minted JWT is accepted by the gateway verifier for the correct sid and rejected for a wrong sid. This pins the two-package contract.

- [ ] **Step 2: Proxy route — failing tests**

`gateway-proxy.test.ts` via `bootTestApi` + a fake in-process gateway (reuse `packages/sandbox-gateway`'s `startGateway` against fake ttyd/vscode backends, and a test engine session whose sandbox's `gatewayEndpoint()` returns that gateway's host/port — use `VirtualSandboxProvider` extended in-test, or a purpose-built fake provider). Cases:

- Owner GET `/api/sessions/:id/gateway/vscode/` → 200, body proxied, path rewritten to `/vscode/`.
- Non-owner (different `x-valet-test-user-id`) → 404.
- Session whose sandbox has no gateway (`gatewayEndpoint()` → null) → 409 `{ wake: true }`.
- Gateway endpoint set but unreachable (closed port) → 502.
- WS: a `ws` client to `/api/sessions/:id/gateway/ttyd/?token=<jwt>` round-trips a frame through the api hop to the fake ttyd echo (the api opens an outbound `ws` client to the sandbox gateway inside `onOpen` and pumps `onMessage` both ways — the pattern the legacy Bun gateway uses; the api cannot expose raw sockets via `@hono/node-ws`).

- [ ] **Step 3: Run to verify failure, implement**

- `gateway-proxy.ts`: resolve the owned session (`loadOwnedSession` → 404), get the engine session (`engineHost.sessionFor`), read its sandbox handle's `gatewayEndpoint()`. Null → 409 `{ error: "sandbox not ready", wake: true }` (the UI triggers ensureReady). Else `fetch` to `http://{host}:{port}{rewrittenPath}` (strip the `/api/sessions/:id/gateway` prefix), streaming request/response bodies, stripping hop-by-hop headers (reuse the `createProxyHeaders` approach). Backend error → 502.
- WS: register `app.get("/api/sessions/:id/gateway/*", upgradeWebSocket(...))` (before/alongside the HTTP `ALL`), authenticate ownership in `onOpen` (close 4040 for non-owner), resolve `gatewayEndpoint()`, open an outbound `new WebSocket("ws://{host}:{port}{rewrittenPath}")` (forward the query incl. `token`, and the `tty` subprotocol for ttyd), pump both directions with a pre-open buffer. Mount in `app.ts` under the authed `/api/*` gate (this route IS authed — unlike the telegram webhook, the browser carries its valet session).
- Note the HTTP `ALL` and the WS `GET` upgrade must coexist on the same path; register the WS `upgradeWebSocket` GET first (it only engages on `Upgrade: websocket`), then the HTTP `ALL`.

- [ ] **Step 4: Run + full api suite**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm --filter @valet/api test && pnpm typecheck`
Expected: green except the 2 known failures.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src packages/api/package.json pnpm-lock.yaml
git commit -m "feat(api): session gateway reverse-proxy (HTTP + WS), session-access gated"
```

(Add `@valet/sandbox-gateway` as a workspace dep of `packages/api` for the verifier import + test fixture.)

---

### Task 7: Web — Terminal and VS Code tabs

**Files:**
- Modify: `packages/web/src/components/session/session-view.tsx` (tab bar under the header)
- Create: `packages/web/src/components/session/sandbox-tabs.tsx` (Chat / Terminal / VS Code switch + iframes)
- Modify: `packages/web/src/routes/sessions.$sessionId.tsx` (`?tab=` search param)
- Modify: `packages/web/src/api/queries.ts` (a `useSandboxJwt(sessionId)` mutation hook if not present)
- Modify: `packages/web/src/components/new-session-dialog.tsx` (interactive sessions default `profile: "full"`)
- Test: `packages/web/src/components/session/-sandbox-tabs.test.tsx`, extend the new-session-dialog test.

**Interfaces:**
- Consumes: `SessionDetail.profile` (Task 5); `POST /api/sessions/:id/sandbox-jwt` → `{ token, expiresAt }`; the proxy path from Task 6; the WS `sandbox.status` stream for readiness.
- Produces: `/sessions/:id?tab=terminal|vscode|chat` — tabs hidden for `headless` sessions; "starting" state while the sandbox isn't `ready`; iframe `src = /api/sessions/:id/gateway/{vscode|ttyd}/?token=<jwt>`; error panel + retry on 502; silent JWT re-mint + reload on gateway 401.

- [ ] **Step 1: Failing component test**

`-sandbox-tabs.test.tsx` (mirror an existing session component test's render/mocking): headless session → no Terminal/VS Code tabs; full session + sandbox state `ready` → tabs present, selecting Terminal fetches a sandbox-jwt and renders an iframe whose `src` contains `/gateway/ttyd/?token=`; full session + state `provisioning` → "starting" placeholder, no iframe. New-session-dialog test: submitting from the interactive entry posts `profile: "full"`.

- [ ] **Step 2: Implement**

- `sandbox-tabs.tsx`: a tab bar (Chat | Terminal | VS Code) shown only when `session.profile === "full"`. On selecting Terminal/VS Code, call `useSandboxJwt(sessionId)` → set iframe `src`. Gate on the `sandbox.status` from the stream: not `ready` → "starting…" with the workspace chip; `ready` → iframe. On iframe error (detect via a 502/onError fallback or a retry button), show an error panel with retry. On a gateway 401 (cookie/JWT expired), re-mint the jwt and reload the iframe once.
- `session-view.tsx`: mount `sandbox-tabs.tsx` under the header; when a non-chat tab is active, render the iframe area instead of `MessageList`+`Composer`.
- `sessions.$sessionId.tsx`: add `tab?: "chat" | "terminal" | "vscode"` search param.
- `new-session-dialog.tsx`: pass `profile: "full"` in the create body (interactive sessions are `full`).
- `useSandboxJwt`: a mutation hook calling `POST /api/sessions/:id/sandbox-jwt`.

- [ ] **Step 3: Run web tests + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && cd packages/web && pnpm test && pnpm typecheck`
Expected: green / clean (root typecheck does NOT cover web — run here).

- [ ] **Step 4: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): Terminal + VS Code tabs behind the session gateway proxy"
```

---

### Task 8: Live dogfood + spec sync

**Files:**
- Modify: `docs/specs/2026-07-15-sandbox-auth-gateway-design.md` (Status Draft → Implemented; Deviations subsection); amend the sandbox-runtime-v2 spec's superseded JWKS/`kid` sketch as decision 2 requires (find it — likely `docs/specs/sandbox-runtime.md` or a runtime-v2 design doc; update the correct one).
- Modify: `CLAUDE.md` if a durable gotcha emerged (e.g. `VALET_SANDBOX_IMAGE` must be the full image for docker-backend gateway testing; `VALET_SANDBOX_PROFILE` env).

- [ ] **Step 1: Full battery**

```bash
source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && pnpm typecheck && pnpm --filter @valet/engine test && pnpm --filter @valet/sandbox-gateway test && pnpm --filter @valet/sandbox-kubernetes test && pnpm --filter @valet/sandbox-docker test && pnpm --filter @valet/api test && cd packages/web && pnpm typecheck && pnpm test
```

Expected: green except the 2 known `messages.abort` failures.

- [ ] **Step 2: Spec updates** — flip Status, add a Deviations subsection recording any implementation choices that diverged (e.g. the api WS hop being an outbound `ws`-client pump rather than a raw pipe, since `@hono/node-ws` exposes no raw socket; ttyd bound `-i 127.0.0.1`; whichever image-bundling approach was taken for the gateway). Amend the superseded JWKS/`kid` sketch in the runtime spec.

- [ ] **Step 3: Manual dogfood (exit criteria — human-in-the-loop, record in the PR/ledger):**
On live Rancher Desktop k3s (`make k8s-build` then redeploy; pin `--context rancher-desktop`): start an interactive (`full`) session, open Terminal through the `localhost:8080` port-forward → working shell in `/workspace`; open VS Code → edit a file, confirm via the agent the edit is visible; second user without session access → 401 at the proxy; hand-crafted request to the pod Service with no/expired JWT → 401 at the gateway; `kubectl delete pod` mid-session → tabs recover after controller heal without re-login. On `make dev-local` (docker backend, `VALET_SANDBOX_IMAGE` = full image): both tabs work against the mapped port.

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs(specs): sandbox auth gateway implemented; runtime-v2 JWKS sketch superseded"
```

---

## Self-review notes (already applied)

- **Spec coverage:** decisions 1–6 map to tasks — 1 (ttyd+code-server, full profile) → T4/T5; 2 (gateway daemon, JWT model) → T2; 3 (api reverse-proxy over per-sandbox Service, `gatewayEndpoint` seam) → T1/T3/T6; 4 (Terminal/VS Code tabs) → T7; 5 (SandboxCreateOpts.profile plumbing) → T5; 6 (failure behavior 502/409/401 re-mint) → T6/T7. Exit criteria → T8.
- **Engine touchpoint:** the single additive contract change (`gatewayEndpoint?()` + `profile?`) is Task 1, adversarial-reviewed, absent=null=byte-identical pinned — matching the handoff's requirement and the `release?` precedent.
- **Deferred correctly (non-goals):** VNC, per-sandbox ingress hosts, in-sandbox api client, cloudflared tunnels, JWT-secret rotation — none are planned.
- **Type consistency:** `GatewayEndpoint { host, port }`, `profile: "headless" | "full"`, gateway route prefix `/api/sessions/:id/gateway/{ttyd|vscode}/`, env keys `VALET_SESSION_ID`/`VALET_SANDBOX_PROFILE`, cookie `gateway_session`, ports ttyd 7681 / vscode 8765 / gateway 9000 — used identically across Tasks 1–7.
- **Known softness (flagged for implementers):** the api WS proxy hop must be an outbound `ws`-client pump (not a raw pipe) because `@hono/node-ws` doesn't expose the socket — Task 6 states this; the legacy Bun gateway's pipe is a conceptual reference only, not liftable verbatim. Full image builds are slow (~15-20 min) — Task 4 keeps them out of the inner loop; the boot smoke is Task 8's dogfood.
