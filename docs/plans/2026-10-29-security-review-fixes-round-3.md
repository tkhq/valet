# Security Review Fixes, Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 18 findings of the 2026-10-29 adversarial review of PR 523 (commit `f5fe8313c`) so the credential path has no unsanitized seam, the persona scope cannot be widened by the repo under review, and background work cannot park the runner.

**Architecture:** Each finding gets its fix at the single code path that owns the property it broke: the engine's prompt and tool-wrapper seams for sanitization, the shared validator for credential declarations, the plugin-security config parser for repo-declared tools, the schema repair for the stored constraint, and the runner driver for background-work deadlines. Tests are the reviewer's own repros where one was given.

**Tech Stack:** TypeScript, Hono, `@valet/engine`, Drizzle + PGlite, vitest.

**Spec:** `docs/specs/valet-security/spec/11-runtime-execution.md`, `docs/specs/valet-security/spec/12-credentials-via-1password.md`. The review text is at the scratchpad file `review-2026-10-29.md` and is quoted per task below.

## Global Constraints

- No `any`, no `as unknown as T`, no `@ts-ignore`. Minimize `as`.
- Every user-facing error message names the corrective action.
- Prose in ASD-STE100 style. No em or en dashes anywhere, including commit text and comments.
- Run tests with `GIT_CONFIG_GLOBAL=/dev/null` in front of every command, for example `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/api test security-runner-driver`. Never pass `--` before a vitest filter.
- Commit with `git -c commit.gpgsign=false commit`. Subjects 72 chars or fewer. No Co-Authored-by trailers.
- Update the spec in `docs/specs/valet-security/spec/` in the same task as the code it describes.
- Tripwire budget (review "Attacked and held"): scanning 256 KiB takes under 200 ms, and the benign corpus in `security-credential-tripwire.test.ts` passes.

## Review Focus

1. A signal body that a sanitizer replaces must be replaced in the submission row too, not only in the entry. Task 1 asserts on `listUnsettledSubmissions` content or the stored submission as well as the entry.
2. A persona tool that throws a non-Error value (a string) must still pass the sanitizer. Task 1 adds a `throw "failed: <MARKER>"` case.
3. A credential value that contains spaces must still match after `fold`. Task 2 registers `"pass word with spaces!"` and asserts the folded form blocks.
4. The memory refusal must not break a normal coding child that writes memory with the sandbox token. Task 3 asserts a non-security session's write still succeeds.
5. A handoff fix session must be denied again once its engagement is closed. Task 6 asserts `security-session-denied` for a handoff row whose engagement status is `complete`.

---

### Task 1: Engine seams, review items 1, 2 and 18

Review text: (1) "Output from background bash/watch reaches the model unsanitized ... `session.prompt({kind:"signal", signalType:"process.exited", body:"exit 0\n<MARKER>\n"})`. Result: STORED true, MODEL true, EVENTS true." (2) "A tool that throws skips the sanitizer, and the model sees the error text." (18) "`withOutputSanitizer` returns `{ text }` and drops `ok`/`usageOutcome`, so a blocked call is persisted as `completed`."

**Files:**
- Modify: `packages/engine/src/session.ts:1092` (`Session.prompt`)
- Modify: `packages/engine/src/thread.ts:6645` (`withOutputSanitizer`)
- Test: `packages/engine/test/credential-sanitizer-roundtrip.test.ts`

**Interfaces:**
- Consumes: `ProviderBundle.sanitizeToolOutput?: (sessionId: string, value: unknown) => unknown` (`types.ts:3342`), `isSignalContent` from `src/submission.ts`.
- Produces: no new exports. Behavior: every `kind: "signal"` prompt body passes the sanitizer before the submission is stored; a thrown tool error passes it; a replaced result carries `ok: false` and `usageOutcome.outcome: "error"`.

- [ ] **Step 1: Write the failing tests** in `credential-sanitizer-roundtrip.test.ts`, reusing `stubSanitizer`, `MARKER`, `BLOCKED` and the engine setup of the existing test:

```ts
it("sanitizes a signal body before it is stored, shown to the model, or emitted", async () => {
  // Faux model answers "ok" to the signal turn.
  await session.prompt({ kind: "signal", signalType: "process.exited", body: `exit 0\n${MARKER}\n`, attributes: {} });
  const entries = await store.getEntries(session.id, session.thread().id);
  const stored = JSON.stringify(entries);
  expect(stored).not.toContain(MARKER);
  expect(stored).toContain(BLOCKED);
  expect(JSON.stringify(events)).not.toContain(MARKER);
  expect(JSON.stringify(faux.requests())).not.toContain(MARKER); // the model request log; use the faux provider's recorded requests accessor
});

it("sanitizes a thrown tool error and persists the call as an error", async () => {
  // tool "boom" executes: throw new Error(`failed: ${MARKER}`)
  // second case: throw `failed: ${MARKER}` (a string)
  // Assert: model request log has no MARKER; stored tool_call part has status "error" or result text BLOCKED; events have no MARKER.
});

it("marks a replaced result ok:false with an error usageOutcome", async () => {
  // Reuse the "leak" tool. Read the persisted tool_call part's result and assert
  // result.ok === false and result.usageOutcome?.outcome === "error".
});
```

Check how the faux provider exposes the requests it received (search `registerFauxProvider` in `@earendil-works/pi-ai/compat` types); if there is no accessor, capture the model-visible text through the `message_start`/request bus events the existing test already inspects.

- [ ] **Step 2: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/engine test credential-sanitizer-roundtrip` and confirm the three new tests fail.

- [ ] **Step 3: Implement** in `Session.prompt`, before `resolveTargetThread`:

```ts
const sanitizer = this.providers.sanitizeToolOutput;
if (sanitizer && isSignalContent(content)) {
  const safe = sanitizer(this.id, content.body);
  if (safe !== content.body) content = { ...content, body: String(safe) };
}
```

Add a comment: a signal body is machine output (a process log, a watch line), so it takes the same seam as a tool result; a user prompt does not.

- [ ] **Step 4: Implement** in `withOutputSanitizer`:

```ts
execute: async (args, ctx) => {
  let result: ToolResult;
  try {
    result = await def.execute(args, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const safe = sanitizer(this.session.id, message);
    if (safe !== message) throw new Error(String(safe));
    throw err;
  }
  const safe = sanitizer(this.session.id, result);
  return safe === result
    ? result
    : { text: String(safe), ok: false, usageOutcome: { outcome: "error", errorCode: "output_blocked", name: def.name } };
},
```

Check `usageOutcome.name` semantics at `types.ts:764` and in `toAgentTool`; if `name` means something other than the tool name, omit it.

- [ ] **Step 5: Run** the engine suite: `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/engine test credential-sanitizer-roundtrip happy-path` and `pnpm typecheck`. Expected: pass.

- [ ] **Step 6: Commit** `engine: sanitize signal bodies and thrown tool errors`.

---

### Task 2: Tripwire encodings, short values, binary payloads, review items 8, 9 and 16

Review text: (8) "Only base64 forms are whitespace-compacted ... Each of these passes with alerts=0: xxd -p (lower and upper case), rev, tr a-z A-Z, fold -w7, sed 's/./& /g', \u JSON escapes, gzip piped to base64, HTML entities, and full %xx encoding." (9) "A whole-value match has no minimum length ... testData `admin` blocks `<a href=/admin>`. testData `1` blocks `total 12`." (16) "sanitizing a 2 MiB image result blocks the event loop for about 0.4 s."

**Files:**
- Modify: `packages/api/src/services/security-credential-tripwire.ts` (`encodings`, `registerSecurityCredentialValue`, `outputText`, `blocks`)
- Modify: `packages/api/src/services/security-seed.ts:632` (`shapeCheckByKind`)
- Modify: `docs/specs/valet-security/spec/12-credentials-via-1password.md` (tripwire residual paragraph, preflight shape rules)
- Test: `packages/api/src/services/security-credential-tripwire.test.ts`, `packages/api/src/services/security-seed.test.ts`

**Interfaces:**
- Produces: `registerSecurityCredentialValue` ignores a value shorter than `MIN_CREDENTIAL_FRAGMENT` (8). Exported constant stays.

- [ ] **Step 1: Write failing tripwire tests.** For value `sk_live_9fQ2xLmP7rTz4KbW8nVc3HdY`, each of these texts must return `BLOCKED` from `sanitizeSecurityCredentialOutput` on a fresh session: hex lower (`Buffer.from(v).toString("hex")`), hex upper, reversed, `toUpperCase()`, `toLowerCase()`, `fold -w7` form (insert `\n` every 7 chars), spaced form (`v.split("").join(" ")`), JSON `\uXXXX` of every char, HTML decimal entities (`&#NN;` per char), full `%XX` of every byte. Add: a value with spaces `"pass word with spaces!"` folded at 7 blocks. Add: registering `"admin"` and `"1"` leaves `sanitizeSecurityCredentialOutput(sid, "HTTP/1.1 200 OK\n<a href=/admin>")` and `"total 12"` unchanged. Add: a result `{ text: "ok", attachments: [{ type: "image", data: new Uint8Array(2 * 1024 * 1024), mimeType: "image/png" }] }` sanitizes in under 50 ms (measure with `performance.now()`). Keep the existing 256 KiB timing test and benign corpus test.

- [ ] **Step 2: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/api test security-credential-tripwire` and confirm the new tests fail.

- [ ] **Step 3: Implement** in the tripwire:
  - `encodings(value)` adds to `values`: hex lower and upper of the utf8 bytes, `[...value].reverse().join("")`, `value.toUpperCase()`, `value.toLowerCase()`, full percent form (`%XX` for every byte, upper hex), JSON escape form (`\uXXXX` for every UTF-16 unit), HTML decimal entity form. Adds `compact(value)` to `compactValues`. No cross products. Comment: compression and ciphers stay the residual.
  - `registerSecurityCredentialValue` returns early when `value.length < MIN_CREDENTIAL_FRAGMENT`, with a comment: a value that short is ordinary text, and the tripwire cannot tell it from source output; preflight refuses short secrets.
  - `outputText` skips `ArrayBuffer.isView(item)`; `blocks` serializes with a replacer that returns `undefined` for `ArrayBuffer.isView(v)`.

- [ ] **Step 4: Implement** in `shapeCheckByKind`: `password`, `signingKey` (when not PEM) and `toolAuth` with `refShape !== "json"` throw `shapeFailed(decl, "the resolved value is N bytes; the minimum is 8")` under 8 bytes, the same rule `headerToken` has. `testData` and `session` keep their rules.

- [ ] **Step 5: Write a seed test** that a `password` resolving to `"short"` throws `SecurityCredentialPreflightError` with reason `shape_failed`. Follow the existing shape-check test pattern in `security-seed.test.ts`.

- [ ] **Step 6: Update spec 12**: the residual paragraph lists the encodings the tripwire indexes (plain, base64, base64url, percent, hex, reversed, case-folded, JSON escapes, HTML decimal entities, and whitespace-stripped forms) and names compression and ciphers as the residual; the preflight table states the 8-byte minimum for password, headerToken, signingKey and raw toolAuth, and that the tripwire does not track a value under 8 characters.

- [ ] **Step 7: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/api test security-credential-tripwire security-seed` and `pnpm typecheck`. Expected: pass, timing tests within budget.

- [ ] **Step 8: Commit** `security: tripwire indexes shell transforms, skips short and binary`.

---

### Task 3: Persona write seams, review items 3 and 4

Review text: (3) "/api/memory accepts the sandbox token ... stores the value in the owner's memory"; "file_attach is in PERSONA_SANDBOX_TOOLS. It stores file bytes as a durable blob without a scan"; "The persona routes /security/needs, /coverage, /report, and /findings/:id/review write model text without assertNoSecurityCredentialOutput." (4) "A credential in a need description goes into a notification."

**Files:**
- Modify: `packages/api/src/routes/security.ts` (the six `resolvePersonaActor` routes at lines 1930, 1961, 2056, 2098, 2140, 2188)
- Modify: `packages/api/src/routes/memory.ts` (router-level middleware)
- Modify: `packages/api/src/services/security-persona-scope.ts:12-33`
- Test: `packages/api/src/integration/security-needs.test.ts`, `packages/api/src/integration/security-persona.test.ts`, `packages/api/src/integration/memory-routes.test.ts`, `packages/api/src/services/security-persona-scope.test.ts`

**Interfaces:**
- Produces: `readPersonaBody(c: Context<AppEnv>, sessionId: string): Promise<Record<string, unknown>>` in `security.ts`, which reads the JSON body and calls `assertNoSecurityCredentialOutput(sessionId, body)` on the whole body. It throws the tripwire error; each route's existing `serviceError` catch returns it. Place the read inside the route's `try`.

- [ ] **Step 1: Write failing tests.** Needs test: register a value for the persona child session, POST `/needs` with the value in `description`; expect 400 with the tripwire text and no `security_needs` row and no `notifications` row. Persona test: same for `/coverage` `reason`, `/report` `markdown`, `/findings/:id/review` `reason`. Memory test: a session that is a security cell child (any cell status) PUTs memory with the sandbox token and gets 403 with text `"A security persona cannot write memory. Record findings with sec_finding_report."`; a non-security child's PUT still succeeds. Scope test: `personaToolScope(...).tools` does not contain `file_attach`.

- [ ] **Step 2: Run** the four suites and confirm the new tests fail.

- [ ] **Step 3: Implement** `readPersonaBody` and use it in all six routes; delete the two per-field `assertNoSecurityCredentialOutput` calls at 1945 and 2031. The `/files` route keeps asserting through the helper (whole body includes `content`).

- [ ] **Step 4: Implement** the memory refusal: `memoryRouter.use("*", async (c, next) => {...})` that, when `c.var.sandbox` is set and the method is not GET or HEAD, queries `securityCells` for `childSessionId = sandbox.sessionId` (any status: a persona child never writes memory) and returns the 403 above when a row exists. Comment: the persona's tool scope grants no memory action, so this token path is the only one, and a refusal has no encoding residual where a scan would.

- [ ] **Step 5: Implement** the scope change: move `"file_attach"` from `PERSONA_SANDBOX_TOOLS` to `PERSONA_DENIED_TOOLS` with the comment "stores file bytes as a blob with no tripwire scan".

- [ ] **Step 6: Update spec 11** INV-32 tool list: remove `file_attach`, name memory writes as refused for a running persona child.

- [ ] **Step 7: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/api test security-needs security-persona memory-routes security-persona-scope security-needs-attention` and `pnpm typecheck`. Expected: pass.

- [ ] **Step 8: Commit** `security: scan every persona write, refuse memory and file_attach`.

---

### Task 4: Credential declaration validator, review items 6, 12 and 13

Review text: (6) "RESERVED_CREDENTIAL_LABELS accepts curl, sed, base64, sh, git, env, and cat. A launcher named curl runs exec valet-secrets run. valet-secrets then calls curl through PATH and lands back in the launcher ... 586 processes in 2 s." (12) "meta.scheme goes unvalidated into the sh -c usage hint." (13) "validateCredentialDecls does not check the derived ${env}_CERT name."

**Files:**
- Modify: `packages/shared/src/security-credentials.ts:91` (`RESERVED_CREDENTIAL_LABELS`), `validateCredentialDecl` meta block (~line 218), `validateCredentialDecls` (line 281)
- Modify: `docs/specs/valet-security/spec/12-credentials-via-1password.md` (label rules, scheme rule, env rules)
- Test: `packages/shared/src/security-credentials.test.ts:43` (exact list assertion), `packages/api/src/engine/secrets-cli-script.test.ts`

**Interfaces:**
- Produces: `RESERVED_CREDENTIAL_LABELS` grows. `CREDENTIAL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9-]*$/` exported from `security-credentials.ts`.

- [ ] **Step 1: Write failing tests.** Shared: `validateCredentialDecls([{label:"curl", ...}])` is `ok: false` with a message that lists reserved names; same for `sh`, `sed`, `base64`, `git`, `env`, `cat`. `meta.scheme` of `Bearer $ADMIN" ; echo "$ADMIN` is refused with a message naming the allowed shape (letters, digits, hyphen; example `Bearer`). An mTLS decl with env `PARTNER` plus a decl with env `PARTNER_CERT` is refused in either order with the duplicate-env message naming `PARTNER_CERT`. Api (`secrets-cli-script.test.ts`): `commandWordsOf(script)` extracts every token that follows a line start, `$(`, `|`, `||`, `&&`, `;`, `exec ` or `command -v ` in the `valet-secrets` SCRIPT and in `commandWrapperScript` output for a launcher and a wrapper decl, filtered to `[a-z][a-z0-9_-]*` and excluding shell keywords and builtins (`if then else fi case esac for do done while in exit set shift eval exec local return break continue true false test trap unset export read printf echo`), and asserts each word is in `RESERVED_CREDENTIAL_LABELS`. Keep `printf` and `echo` reserved anyway.

- [ ] **Step 2: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/shared test security-credentials` and `... --filter @valet/api test secrets-cli-script`; confirm failures.

- [ ] **Step 3: Implement.** Extend the set with: `sh bash dash zsh env command printf echo cat sed awk tr cut paste tail head wc grep base64 curl wget mktemp rm cp mv chmod git ssh node npm pnpm python python3`. Comment: the second group names what the generated launcher scripts call; a label that shadows one recurses through valet-secrets. Add the scheme check in the meta block, the `_CERT` derivation in `validateCredentialDecls` (add `${decl.env}_CERT` to `envs` for `kind === "mtls"` and check it before adding).

- [ ] **Step 4: Update spec 12** label rule (reserved list by reference to the constant and the reason), scheme rule, and the derived env rule.

- [ ] **Step 5: Run** both suites, `credential-commands`, and `pnpm typecheck`. Expected: pass.

- [ ] **Step 6: Commit** `security: reserve launcher utilities, validate scheme and cert env`.

---

### Task 5: Repo-declared tools and credentials, review items 5 and 14

Review text: (5) "The repo commits .valet/security.yml with tools: [{id: github, mcp: {url: ...}}] ... personaToolScope emits github.* ... Fix direction: refuse a declared MCP service id that collides with an installed integration." (14) "An API create without securityConfig.credentials adopts the repo's declared list ... The web wizard always sends the list."

**Files:**
- Modify: `packages/plugin-security/src/lib/config.ts:177` (`parseSecurityConfig`), `:350` (`parseToolDecl`)
- Modify: `packages/api/src/services/security-seed.ts` (`SeedSecurityReviewArgs`, the parse call at ~249, the adoption at ~262)
- Modify: `packages/api/src/routes/security.ts:810` (preview call), `packages/api/src/routes/security.ts` config route if it parses yaml, `packages/api/src/services/security-persona-scope.ts:36`
- Modify: `docs/specs/valet-security/spec/12-credentials-via-1password.md` (adoption rule), `docs/specs/valet-security/spec/11-runtime-execution.md` (INV-32 reserved service rule)
- Test: `packages/plugin-security/src/lib/config.test.ts`, `packages/api/src/services/security-seed.test.ts`, `packages/api/src/services/security-persona-scope.test.ts`

**Interfaces:**
- Produces: `parseSecurityConfig(yaml: string, knownPersonas: readonly string[], options?: { reservedServices?: ReadonlySet<string> }): SecurityConfig`. `SeedSecurityReviewArgs.reservedServices?: ReadonlySet<string>` and `SeedSecurityReviewArgs.adoptRepoCredentials?: boolean`. `personaToolScope(cell, mcpServices, reservedServices?: ReadonlySet<string>)`.
- Consumes: `c.var.providers.actionPluginByService: Map<string, ...>` (`providers/types.ts:125`); `new Set(actionPluginByService.keys())` is the installed set.

- [ ] **Step 1: Write failing tests.** Config: a tool `{id: github, mcp: {url: ...}}` with `reservedServices: new Set(["github"])` throws with message `tools[0] "github" is the name of an installed integration. Rename the tool id or set mcp.prefix to a name that is not an integration.`; same for `mcp: {prefix: "mcp__slack__"}`; a tool id `zap` passes. Seed: with `adoptRepoCredentials` unset and no `credentials` arg, a repo config that declares credentials yields `credentialsJson: null`; with `adoptRepoCredentials: true` it yields the declared list. Scope: `personaToolScope({persona:"dast", review:false}, ["github","zap"], new Set(["github"])).actions` equals `["zap.*"]`.

- [ ] **Step 2: Run** the three suites; confirm failures.

- [ ] **Step 3: Implement** the parser option, thread it through `parseToolDecls` to `parseToolDecl`; compute the service with the same rule `mcpServiceName` uses (prefix stripped of `mcp__` and `__`, else id). The seed passes `reservedServices` into `parseSecurityConfig`; the preview and create routes pass `reservedServices: new Set(c.var.providers.actionPluginByService.keys())`; the preview also passes `adoptRepoCredentials: true`. In the seed, the adoption condition becomes `args.adoptRepoCredentials === true && args.credentials === undefined && config.credentials?.length`. `personaToolScope` filters reserved names with the existing warn.

- [ ] **Step 4: Check** `packages/api/src/routes/sessions.ts:609` (create) passes `reservedServices` and not `adoptRepoCredentials`. Check whether `/:id/security/config` (route at 1437) parses yaml; if it does, pass the set there too.

- [ ] **Step 5: Update specs**: spec 12 says the setup page prefills from `.valet/security.yml` and the create request carries the list; an API create with no list declares none. Spec 11 INV-32 says a declared MCP service name that matches an installed integration is refused at config time and dropped at dispatch.

- [ ] **Step 6: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/plugin-security test config`, `... --filter @valet/api test security-seed security-persona-scope security-setup security-routes`, `pnpm typecheck`. Expected: pass.

- [ ] **Step 7: Commit** `security: refuse integration-named MCP tools, explicit credential adoption`.

---

### Task 6: Stored constraint and broker caller, review items 10 and 11

Review text: (10) "After the repair, a legacy row with kind='credential' and a plaintext resolution remains ... Any UPDATE of that row fails ... Fix direction: a data step that nulls those resolutions before the constraint is added." (11) "/security/handoff writes a child_watches row whose parent is the runner. classifySecurityBrokerCaller then returns security-session-denied ... The passing test at sandbox-secrets.test.ts:1095 sets up this same state."

**Files:**
- Modify: `packages/api/src/lib/drizzle.ts:1895-1913` (the `security_needs_credential_resolution_null` repair)
- Modify: `packages/api/src/services/security-broker-allowlist.ts:44-59` (`classifySecurityBrokerCaller`)
- Test: `packages/api/src/schema/pg-schema.test.ts` (near line 1144), `packages/api/src/routes/sandbox-secrets.test.ts` (near line 1095)

- [ ] **Step 1: Write failing tests.** Schema: drop the constraint, insert a credential need with `resolution = 'plaintext'`, run `applyAppMigrations`, assert the row's `resolution` is NULL, the constraint exists, `pg_constraint.convalidated` is true, and an UPDATE of that row succeeds. Broker: insert a `security_handoffs` row for the fix session in the existing handoff setup and assert `/api/sandbox-secrets/resolve` answers 200 for a `.valet/credentials.yaml` reference; add the Review Focus case: engagement status `complete` makes it `security-session-denied`.

- [ ] **Step 2: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/api test pg-schema sandbox-secrets`; confirm failures.

- [ ] **Step 3: Implement** the repair SQL: inside the same `DO` block, first `UPDATE "security_needs" SET "resolution" = NULL WHERE "kind" = 'credential' AND "resolution" IS NOT NULL;` then `ADD CONSTRAINT ... CHECK (...)` without `NOT VALID`. Rewrite the comment: the UPDATE removes plaintext answers an earlier handler stored (INV-37); after it, validation passes on every row.

- [ ] **Step 4: Implement** the broker rule: after the cell lookup and before the runner lookup, select from `securityHandoffs` joined to `securityEngagements` where `childSessionId = sessionId`; when the engagement status is `running`, return `{ kind: "non-security" }`; otherwise fall through to the existing parent rule. Comment: a fix session is a coding child that uses the owner's ordinary wrappers, and it loses them with the engagement.

- [ ] **Step 5: Run** both suites and `pnpm typecheck`. Expected: pass.

- [ ] **Step 6: Commit** `security: null legacy credential resolutions, admit handoff sessions`.

---

### Task 7: Runner driver deadlines and alerts, review items 7, 15 and 17

Review text: (7) "A persona's background work stops the runner driver for up to 30 days, with no alert ... Fix direction: put a deadline on background work, or count stalls while it is open." (15) "The stall dedupe key repeats when a resume returns the engagement to an earlier signature ... security-runner-down fires only once per engagement." (17) "routeAttention awaits team delivery inline. One channel send that never returns would block every later driver sweep and hang sec_need_report."

**Files:**
- Modify: `packages/api/src/orchestrator/security-runner-driver.ts` (`StallState`, `driveEngagement` ~270, `nudgeOrAlert`, `safeAlert`, `NUDGE_TEXT`, deps)
- Modify: `packages/api/src/routes/security.ts` fail route (1763) and needs route attention loop (~2220)
- Modify: `packages/api/src/services/security-engagements.ts` `completeCell` message (~1496)
- Modify: `docs/specs/valet-security/spec/11-runtime-execution.md` (background work deadline)
- Test: `packages/api/src/orchestrator/security-runner-driver.test.ts`, `packages/api/src/integration/security-needs-attention.test.ts`, `packages/api/src/integration/security-settlement.test.ts` or the fail route's suite

**Interfaces:**
- Produces: `SecurityRunnerDriverDeps.backgroundWorkMaxMs?: number`, default `SECURITY_BACKGROUND_WORK_MAX_MS = 24 * 60 * 60 * 1000`, exported. `StallState.since: number` (the `now()` when the entry was created or reset). Dedupe keys `security-stall:${engagementId}:${sig}:${since}` and `security-runner-down:${engagementId}:${since}`.
- Consumes: `securityCells.dispatchedAt` (`schema/index.ts:2460`), `cancelAllWorkAsHuman` (`engine/wakeups-admin.ts:484`) with the pattern at `routes/sessions.ts:1219`.

- [ ] **Step 1: Write failing driver tests.** (7) A running cell with `dispatchedAt = now - 25h`, a settled child and one pending timer 30 days out: after `maxStalls + 1` sweeps, `submits >= 1` and `alerts.length === 1` with title `Security review stalled`; the same setup at `dispatchedAt = now - 1h` produces 0 submits. (15) Two stall episodes with the same signature separated by a signature change produce two alerts with different dedupe keys. (17) An `alert` dep that never resolves does not block `sweep()` from resolving (race `sweep()` against a 100 ms timer).

- [ ] **Step 2: Write failing route tests.** Fail route: a running cell whose child has one pending wakeup; after POST `/cells/:id/fail`, `openBackgroundWork(engineStore, childId) === 0`. Needs route: an `routeAttention` that hangs does not delay the 200 response (stub the attention deps with a never-resolving promise; assert the response arrives within 1 s).

- [ ] **Step 3: Run** the suites; confirm failures.

- [ ] **Step 4: Implement** in the driver: the early return for open background work holds only while `this.now() - (runningCell.dispatchedAt ?? runningCell.createdAt) < backgroundWorkMaxMs`; past that, fall through to `nudgeOrAlert`. `NUDGE_TEXT` gains the sentence: "If a running cell's background work has passed its limit, child_send the persona to cancel it with wakeup_cancel, or call sec_cell_fail." `StallState.since` set on create and reset; both dedupe keys append it. `safeAlert` does not await: `void this.deps.alert(...).catch(log)`.

- [ ] **Step 5: Implement** the fail route: when the cell has a `childSessionId`, load its session with `engineHost.sessionFor` and call `cancelAllWorkAsHuman(engineStore, live, childId, {}, { actorUserId, signal: "suppress" or the option that sends no signal, note: "The runner failed this cell." })` before `security.failCell`. Read `HumanCancelOptions` for the exact signal values. The needs route loop stops awaiting: `void routeAttention(...).catch(...)`.

- [ ] **Step 6: Update** the `completeCell` refusal to add "or call sec_cell_fail to stop it", and spec 11: a cell's background work is bounded by 24 hours from dispatch; past that the driver counts stalls and alerts, and a failed cell cancels its child's work.

- [ ] **Step 7: Run** `GIT_CONFIG_GLOBAL=/dev/null pnpm --filter @valet/api test security-runner-driver security-needs-attention security-settlement security-needs` and `pnpm typecheck`. Expected: pass.

- [ ] **Step 8: Commit** `security: bound background work, episode dedupe keys, async alerts`.

---

### Task 8: Validation and PR text

**Files:**
- Modify: `docs/specs/valet-security/README.md` (changelog entry v1.3, 2026-10-29, one line per review item group)
- Modify: scratchpad `squash-message-v2.txt` trailer and `pr-body-v3.md`

- [ ] **Step 1: Run** `pnpm typecheck`. Expected: clean.
- [ ] **Step 2: Run** `GIT_CONFIG_GLOBAL=/dev/null make e2e 2>&1 | tee /tmp/e2e-round3.log`. Expected: every row green except the two known environmental reds (BSD `chmod --` in skill-file tests; engine timeouts under load that pass alone). Name any other red.
- [ ] **Step 3: Run** `python3 ~/.claude/skills/ste-plain-writing/scripts/ste_lint.py` on each touched spec file; fix findings in text this plan touched.
- [ ] **Step 4: Changelog trailer** becomes: `Changelog: Security reviews declare 1Password credentials in the setup wizard, which prefills from .valet/security.yml; personas use them through launcher commands and never see values.` PR body: replace the sentence about repo-declared credentials, add one line under Platform adoption or a new "Review fixes" line naming the 18 items closed, and trim to 300 words or fewer. Scan both for em and en dashes with Python.
- [ ] **Step 5: Commit** `docs: security spec changelog v1.3`.
