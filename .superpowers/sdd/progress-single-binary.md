# Progress Ledger — Single Binary + CLI (spec #5)

Branch: `feat/single-binary-cli` (worktree). Plan: `docs/plans/2026-07-17-single-binary-cli.md`.

## Status legend
- [ ] not started · [~] in progress · [x] done (reviewed green) · [!] blocked/owed

## Tasks
- [x] Plan written + committed
- [x] T1 — Uniform asset-read seam (kill migration readdir) — commit 53c870cc; both reviews PASS
- [x] T2 — esbuild bundle + inline/copy assets + bundle guard — commit 25ca43d2; both PASS; full single-file bundle (18.4mb) boots under plain node; note: pglite wasm compile needs ~15s at boot (raise sleeps in integration tests)
- [x] T3 — CLI scaffold + config/profiles + precedence — commit cf03a1e7; both PASS. Minor owed: coerce/validate nested config values (serve.port could be a string from hand-edited config) — T5 should coerce when reading.
  Interfaces: dispatch table Record<string,()=>Promise<CommandModule>>; CommandModule.run(args, ctx)->number; CliContext{command,config}; ExitCode{OK=0,Usage=2,GatePending=3,TurnError=4,AuthFailure=5,Unreachable=6}; CliError hierarchy (ConfigError,ProfileNotFoundError,NoInstanceError,AuthError,UnreachableError,ApiError); config loadConfig/saveConfig/configPath; resolvePort/resolveSandbox/resolveDataDir/resolveInstance; output parseGlobalFlags/printJson/printLine/printErr/emitNdjson.
- [x] T4 — HTTP/WS InstanceClient library — commit 8b752114; both PASS.
  Interfaces: new InstanceClient({url,apiKey?}) with health/me/ensureOrchestrator/listSessions/getSession/createSession/listMessages(id,{threadId?,cursor?,limit?})/sendPrompt/listThreads/listDecisions/resolveDecision; streamSession({url,apiKey?,sessionId,fromOffset?,signal?})->AsyncGenerator<WireEvent> (auto-reconnect on last offset); httpToWsUrl. HealthResponse{ok,service,ts,version?} added to wire/types.ts.
- [x] T5 — `valet serve` command + sandbox detect + implicit local profile — both reviews PASS (spec PASS; quality PASS-WITH-FIXES). Fixed the one Important finding (serve.lock check-and-claim was a TOCTOU — replaced with atomic `claimServeLock` using O_EXCL `flag:"wx"`; stale/malformed locks reclaimed) plus 2 minor lock nits (exit handler registered before boot so an in-boot process.exit still drops the lock; removeLock only deletes a parseable lock that is ours). 33 unit tests pass; api typecheck clean.
  Interfaces: `startServer(): Promise<ServerHandle>` in main.ts (no import side effects; direct-entry guard `import.meta.url===entryHref && /\/main\.(ts|js|mjs)$/` — false in bundle where cli.ts is entry); ServerHandle{close(),port,backend}. serve.ts exports resolveServeSettings(input)->ServeSettings, upsertLocalProfile(config,port), parseLock/isLiveLock/claimServeLock, ServeLock. docker-detect.ts: detectDockerDaemon(probe?)->bool, spawnDockerProbe. Dockerfile.api ENTRYPOINT → `tsx src/cli.ts serve`. serve default port 8788.
  Deviations (minor, recorded): (1) config.serve.authMode is declared but unused — serve derives auth solely from BETTER_AUTH_SECRET; either wire or drop in a later pass. (2) Dockerfile default backend silently flipped docker→local for an UNCONFIGURED container (auto-detect finds no daemon inside); real deploys (k8s chart) always set the backend explicitly, so unaffected.
- [x] T6 — Scriptable commands (sessions/send/gates/status) + health version — both reviews PASS. 45 new tests; api typecheck clean. `/api/health` gains `version`(=VALET_VERSION) + `sandboxBackend` (append-only HealthResponse; no auth/engine change). Commands wired in cli.ts. Each `run` is a thin shell delegating to a pure exported `runX(client, flags)` taking a NARROW client interface (SessionsClient/SendClient/GatesClient/StatusClient) — stubs in tests, no double-casts. `send` injects StreamFn for testable WS. Exit map (send `outcomeToExit`): completed/merged→OK; failed/aborted/superseded→TurnError; decision_gate on our thread→GatePending; stream-ends-before-settle→TurnError. Correlation submission.settled.queueItemId===messageId; delta/gate render filtered by echoed threadId.
  Accepted minor/nit (none blocking, deferred): send has no overall turn-timeout (hang only if the wire contract is violated); health reads env backend not the resolved provider (accurate post-boot); parseSandboxBackend throw-path on health (unreachable — boot fails first on a bad value); send --json dumps all wire events unfiltered by thread (raw dump, deliberate); gates resolve accepts both positional actionId AND --value without a guard. T9 integration validates the real send round-trip.
- [x] T7 — Profile admin (login/logout/instance/config) + reset — both reviews PASS/PASS. 65 new tests (src/cli 180 passed/0 failed); typecheck clean. login verifies via me() BEFORE any write (bad key→AuthFailure, no config written); hidden input via node:readline muted Writable (key never echoed/logged), --api-key flag + non-TTY stdin paths, injectable LoginDeps{makeClient,readSecret}. logout repoints default→sorted-first remaining or clears. instance list --json masks keys to hasKey; use sets default. config scoped to serve.* dot-path only (port int / sandbox / authMode enum coercion; unknown→Usage; never touches profiles). reset reuses serve.ts parseLock+isLiveLock to refuse a LIVE owner (before --yes), --yes bypass, non-TTY-without-yes refuses (no hang).
  Deliberate divergence (safer, documented): reset does a SCOPED wipe — clears pg/, serve.lock, runtime dirs but PRESERVES config.json so `valet login` profiles aren't silently destroyed (plan literal said "wipes dataDir"). Accepted nits: reset.ts re-declares serve.ts's private defaultIsPidAlive (drift-prone; could export+reuse); config port coercion via Number accepts hex/exp (parity with serve.ts coercePort); login --name skips URL validation (fails later at me() as UnreachableError). chat/mcp still notImpl.
- [ ] T8 — `valet chat` TUI (lazy deps) + pty smoke
- [ ] T9 — CLI integration suite (spawned serve)
- [ ] T10 — `valet mcp setup`
- [ ] T11 — Bun compile spike (3-part gate) — verdict may be fallback
- [ ] T12 — CI distribution (may be owed)

## Decisions / deviations log
- Phase A does NOT string-inline `.md`/`.sql`; ships them as on-disk sibling assets under `dist/assets/**` resolved via `assetBase()` when `VALET_BUNDLED=1`. True inlining deferred to Phase C (binary). Rationale: tractable, still kills tsx + slims image.
- `GET /api/health` gains `version` (+ maybe `sandboxBackend`) — only api surface change; no engine/auth change.

## Test evidence
(to be filled per task)
