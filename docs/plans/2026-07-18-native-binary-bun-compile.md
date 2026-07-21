# Implementation Plan — Native single-file binary via Bun `compile`

**Spec:** `docs/specs/2026-07-15-single-binary-cli-design.md` (decision 4; Deviations owed "native binary")
**Branch:** `feat/single-binary-cli` (extends the spec #5 PR — resolves its #1 deviation)
**Follow-up to:** `docs/plans/2026-07-17-single-binary-cli.md` (the bundle shipped; this adds the binary)

## Spike verdict (2026-07-18) — GO for Bun

The T11 spike deferred native binaries because `@hono/node-ws` WS upgrade failed under `bun build --compile`. Two isolated re-spikes on a compiled Bun binary now clear the two unknowns:

- **Gate (b) WebSocket — PASS.** A compiled binary using `Bun.serve` + `hono/bun`'s `createBunWebSocket()` does a real `101` upgrade and streams frames + closes cleanly. The route handlers already take an injected `upgradeWebSocket` (Hono WSContext API, identical between `@hono/node-ws` and `hono/bun`), so only the adapter construction changes.
- **Gate (c) PGlite durability — PASS.** PGlite wasm/data EMBEDDED in a 76MB compiled binary (via Bun `import … with { type: "file" }`), 500 rows written, process SIGKILLed mid-life, reopened → all 500 rows intact. The existing `pgliteWasmOptions()` seam (`assets/base.ts`) already hands PGlite explicit `{ pgliteWasmModule, initdbWasmModule, fsBundle }`; only the byte SOURCE changes (disk → embedded).
- Gate (a) better-auth (scrypt + HMAC cookies) already PASSED under Bun in the original spike.

All three gates pass → build the binary; no Node SEA fallback needed.

## Pieces

### P1 — Server-adapter seam (Node vs Bun)
Isolate the two Node-adapter couplings so the runtime picks Node or Bun:
- `packages/api/src/app.ts` (~201): construct `createNodeWebSocket({ app })` OR `createBunWebSocket()` behind a runtime check (`typeof Bun !== "undefined"` — or a build-time define). Return the right `upgradeWebSocket` plus a `wsAttach` value the server step consumes (Node: `injectWebSocket`; Bun: the `websocket` handler object).
- `packages/api/src/main.ts` (~238, 261): under Node keep `serve({fetch,port})` + `injectWebSocket(server)`; under Bun use `Bun.serve({ fetch, port, websocket })` (no inject step). Unify graceful shutdown (`server.close()` vs Bun `server.stop()`).
- Route files (`routes/ws.ts`, `routes/gateway-proxy.ts`) unchanged — already adapter-agnostic.
- Keep the Node path byte-identical for `make dev-local` / the node bundle. Tests: the existing WS suites must stay green under Node; add a compiled-binary WS smoke to P3.

### P2 — Embedded asset loader (compiled-binary mode)
Under a compiled Bun binary the sibling `assets/` + `import.meta.url` reads collapse. Add an embedded loader to `packages/api/src/assets/base.ts` selected when running as a compiled binary:
- **PGlite (3 files):** `import … with { type: "file" }` for `pglite.wasm`/`initdb.wasm`/`pglite.data`; feed `Bun.file(path).arrayBuffer()` into the existing `pgliteWasmOptions()` shape. (Proven in the spike.)
- **Migrations + plugin markdown:** route the T1 explicit reads + plugin `readFileSync` through the embedded loader (embed each `.sql`/`.md` via `with { type: "file" }`, or a generated manifest).
- **Web SPA (58 files, 3.0MB):** embed as ONE artifact — a build-time `web.tar` embedded via `with { type: "file" }`, extracted in-memory at boot into a `Map<urlPath, {bytes, contentType}>`; `static-web.ts` serves from the map under the binary, from the dir under node/dev. (Minimal in-memory tar reader, no new dep — or a generated import manifest.)
- Gate the whole embedded path so node/dev/bundle behavior is unchanged.

### P3 — Compile script + gate verification + CI cross-compile
- `packages/api/build/compile.mjs` (or a script): `bun build <entry> --compile --target=<t> --outfile valet-<platform>`; embed assets per P2. Verify the compiled binary: health + a WS round-trip + a PGlite kill-test (adapt the spike) as a smoke gate.
- Extend `.github/workflows/release-cli.yml`: matrix `bun-darwin-arm64`, `bun-linux-x64`, `bun-linux-arm64`; attach binaries to the Release alongside (or instead of) the node bundle. Windows = WSL note.
- Update the spec Deviations: native binary now shipped; note residual limits.

## Constraints
Node 22 for node tests; Bun for compile. No `any`/`as unknown as`/`@ts-ignore`. No Co-Authored-By. Per-piece implementer→review→commit, mirroring the main arc.
