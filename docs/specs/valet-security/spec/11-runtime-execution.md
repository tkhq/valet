# Part 11: Runtime Execution via API-Side Tool

*Depends on: Part 00, Part 01, Part 04, Part 05, Part 07, Part 09, Part 10. Conformance: L1+ (server-side gates and tool wiring); L3 dispatches runtime-verify cells; L4 pulls in multi-step verify plans.*

## Purpose

The current engagement model has no place for a source-only cell to prove a chain that needs a real API call. An `attack-tree` cell reading Turnkey client code can prove statically that a root API key seeds `createSubOrganization` -> `createApiKeys` -> `createUsers` against org `019cd851-152f-40aa-ac32-ed07246f98cb`. The cell cannot fire the chain and record the actual sub-org id, api key id, and user id as evidence. Source-only cells are forbidden from live network access by policy; no downstream cell mode exists to pick up the intent.

Two ways to close this gap:

- **Sandbox-native.** Open sandbox egress under scope enforcement (NetworkPolicy on kubernetes, per-sandbox internal bridge on docker, a scope-aware proxy sidecar). Ambitious; requires new infrastructure on both backends and a new package.
- **API-side.** Add one engine tool that runs in the api's Node process (where every other tool already runs) and makes the HTTP call from there. Reuses the existing tool bridge, the existing credential vault (Part 10), and the existing sandbox provisioning path. Zero networking changes.

Part 11 picks the api-side path for v1. The sandbox-native plane is a follow-up (§Sandbox-native follow-up).

## Why the api-side path fits

Three existing seams make this design cheap:

1. **Every tool already executes in the api Node process.** `toAgentTool` (`packages/engine/src/tool-bridge.ts:15`) binds each `ToolDef.execute` to the api-side pi-agent-core `Agent`; the sandbox holds workspace bytes only. A tool that makes an HTTP call adds no new topology.
2. **The api process already has trusted outbound.** `streamSimple` posts to `api.anthropic.com` from the api process (`packages/engine/src/thread.ts:3164`, provider config in `pi-ai/anthropic-messages.js`). Trusting the api process for LLM egress means it is already trusted for any outbound; a runtime-verify call reuses that trust.
3. **The GitHub-App path proves the pattern.** `mintInstallationToken` (`packages/api/src/services/github-app.ts:801`) decrypts a stored token, injects it into an api-side outbound call, and returns a scoped result to the sandbox. `valet-gh` in the sandbox is a thin client. Runtime-verify follows the same shape with a different vault: Part 10's `EngagementVault` replaces the GitHub credential store.

## Vocabulary

**LLM egress.** The api's Node process posting to `api.anthropic.com`. Runs in the api container, not in the sandbox. Uses the org-configured provider key resolved by `resolveModelSpec` (`packages/api/src/services/model-resolution.ts:169`). Part 11 does NOT change LLM egress.

**Target egress via api.** A runtime-verify tool call fires from the api process, not from the sandbox. The api process substitutes vault credentials at the outbound boundary, enforces scope on the URL, computes evidence hashes, and returns a redacted result to the sandbox.

**Runtime-verify cell.** A cell dispatched with `mode: runtime-verify`. The persona sees one new tool: `sec_http_request`. It executes an ordered verify plan against a specific `need_id`, writes a redacted evidence file via `sec_fs_write`, and settles.

**`sec_http_request`.** The new engine tool. Fires one HTTP request from the api process. Available ONLY to a cell running with `mode: runtime-verify`; every other cell mode omits it from the persona's toolset.

**Verify plan.** An ordered `steps[]` list on a `runtime-verify-request` need's `proposed_resolution.auto.params.verify_plan`. Names host, method, path, credentials by vault label, body template, and expected response shape.

**Evidence file.** A YAML doc at `/cells/<NN>-<slug>/verify-runs/<need_id>.yml` written by a runtime-verify cell. Carries only key paths, status codes, and content hashes. Never carries a raw response body.

## Global invariants

**INV-18 (LLM egress and target egress share the api boundary; target egress never uses the sandbox).** For v1, target-egress runtime-verify calls originate in the api process. The sandbox never opens a new outbound socket for a runtime-verify step. This keeps the enforcement plane in one code path (the tool) instead of two (network + proxy).

**INV-19 (`sec_http_request` is the ONLY channel for a runtime-verify step).** A runtime-verify cell's persona has exactly one tool for target egress: `sec_http_request`. A cell that spawns `curl` or an installed scanner from `sec_bash` and hits the plan's host is a hard cell failure; the api-side tool rejects the plan and the cell settles `failed`.

**INV-20 (Only `runtime-verify` cells see `sec_http_request`).** The tool is added to the persona's toolset by cell mode, not by persona. Source-only cell modes (`fresh`, `resume`, `post-pivot-delta` when the origin persona is source-only) MUST NOT have the tool in their toolset. `buildSecurityPersonaTools` (`packages/api/src/engine/host.ts:2750`) reads the mode and filters.

**INV-21 (Verify plan bounds the tool).** `sec_http_request` refuses any request whose destination is not covered by the plan's `host`+`method`+`path` triple for the calling cell. The plan is loaded into the tool's per-cell context at dispatch; the tool refuses out-of-plan calls with a corrective error naming the plan.

**INV-22 (Evidence file redacts by structure).** The evidence file schema captures only key paths, HTTP status codes, and SHA-256 hashes of canonicalized request/response bytes. `sec_fs_write` on `/cells/*/verify-runs/*.yml` refuses any evidence doc whose bytes include a substring matching any credential fingerprint (Part 10 tripwire) or any value the tool substituted into this cell's requests. Redaction is enforced at write time.

**INV-23 (Every runtime-verify finding cites `traces_to.runtime_step`).** A finding whose status changed inside a runtime-verify cell MUST include `traces_to.runtime_step: <step_id>` in its state doc. `sec_cell_complete` refuses to settle a runtime-verify cell whose finding writes lack the citation, mirroring the `traces_to.pivot_need` gate from Part 07.

**INV-24 (Credential values live in `Buffer`, never in a JS `String`).** After `decryptSecret`, the plaintext is a Node `Buffer`. Every downstream operation that composes an outbound header, URL, or body reads bytes from the Buffer via `TextEncoder` or `Buffer.concat`, never a JS string concatenation. The Buffer is zeroed with `.fill(0)` in a `finally` block before `sec_http_request` returns, even on error paths. V8 strings are immutable; a credential that lands in a string persists in the heap until GC and is visible in any heap snapshot taken in the meantime.

**INV-25 (Fresh HTTP client per request; no keep-alive pool).** `sec_http_request` builds a per-call `undici.Client` (or an equivalent single-connection dispatcher). Keep-alive is disabled, `Connection: close` is set on the outbound request, and the client is destroyed after the response is drained. No connection pool retains the last request's header set; no other tool call rides the same TCP session.

**INV-26 (Response body and response headers never surface).** The response body is read into a Buffer, canonicalized, hashed, shape-extracted, then zeroed. Response headers are NOT returned to the persona in `chained_refs`, NOT written to any log, NOT stored anywhere. The tool's return value carries only `status`, `outcome`, `response_shape`, `response_hash`, `chained_refs` (key paths only), and `evidence_path`.

**INV-27 (Redirect refusal by default).** The tool follows at most one HTTP redirect, only when the `Location` host is in the plan's `host` set for the calling step. Any other redirect settles the step with `outcome: "inconclusive"`, records the redirect target in the evidence file, and skips further steps. This closes the "attacker-controlled Location header leaks the credential to a hostname the plan did not authorize" path.

**INV-28 (Response echo tripwire).** Before hashing, the response Buffer is scanned for a credential fingerprint match against the Part 10 index. A match sets `outcome: "refuted"` with reason `"credential-echoed"`, records a `security_incidents` row, and DOES NOT persist a `response_hash` on the step (the hash itself would let a reader distinguish which body variant echoed the credential). Only `response_status` and the incident record survive.

**INV-29 (No credential in URL, query, or path).** The plan's `url` is validated at need-write time to contain no `${cred:*}` reference. Only headers and body may name a vault label; the URL never carries a substitution that a proxy, an access log, or a Referer header could capture. `sec_http_request` rejects a plan step whose URL string contains `${cred:` or a percent-encoded variant.

## LLM call topology (informative)

Included to remove ambiguity. Unchanged by Part 11.

- A persona child session is built by `EngineHost.buildChildSession` (`packages/api/src/engine/host.ts:2711`). Its `Thread` owns a pi-agent-core `Agent` (`packages/engine/src/thread.ts:3154`) that runs in the api's Node process.
- `streamSimple` sends bytes from the api process to `api.anthropic.com`. The sandbox is not on that path.
- Tool intent flows: model returns `tool_call` -> the tool's `execute` runs in the api process -> the tool reaches into the sandbox via `ctx.sandbox.exec` / `readFile` for local work, or fires a network call directly (for `sec_http_request`) -> result normalized and handed back to the Agent.
- `ANTHROPIC_API_KEY` is loaded at api boot (`packages/api/src/main.ts:178`) and NEVER included in `mintSandboxEnv` (`host.ts:1231-1252`). No provider key ever reaches the sandbox.

Two consequences. First, LLM calls and runtime-verify calls both leave the api container, but they resolve to different destinations and different auth. Second, when a persona wants an HTTP call to the target, the tool fires from the api; the sandbox does not open the socket.

## Node process hygiene

Moving the credential from a sandbox to the api process narrows the topology but widens a different attack surface: the api process's own memory, log pipeline, and observability stack. This section enumerates the mechanisms the tool implementation and the api deployment MUST use to keep a credential from leaking out of the Node process. Every item maps to a threat that would otherwise turn "the credential never enters the sandbox" into a false comfort.

### In-memory hygiene

- **Buffers, not strings.** `decryptSecret` returns a `Buffer`; every downstream composition (header value, body substitution) is a `Buffer.concat` or a `TextEncoder.encodeInto` into a mutable `Uint8Array`. Never `` `Authorization: Bearer ${token}` ``. Zero the Buffer with `.fill(0)` in `finally`, on every path. INV-24.
- **Per-request dispatcher.** `sec_http_request` constructs a fresh `undici.Client` (single-shot Dispatcher) per call, sets `keepAliveTimeout: 0` and `Connection: close` on the request, and calls `client.close()` after `response.body` is drained and zeroed. INV-25.
- **Bounded body reads.** Response bodies are read into a Buffer capped at 256 KiB (`VALET_RUNTIME_VERIFY_MAX_RESPONSE_BYTES`). A response over the cap settles `outcome: "inconclusive"` with reason `"response-too-large"` and the tool discards. Prevents heap-exhaustion + limits the window in which a large body sits decrypted.
- **No subprocess.** `sec_http_request` MUST NOT spawn `curl`, `wget`, or any child process. In-process fetch only. A subprocess would inherit the api's env (see below) and its argv would be visible via `/proc/self/cmdline` for the lifetime of the call.

### Boundary discipline

- **Header keys the tool sets, not the persona.** The persona names a vault label; the tool composes the header key. The persona MUST NOT name the header key (`Authorization`, `Cookie`, `X-Stamp`); the vault entry's `kind` picks the key deterministically (`password` -> Basic, `headerToken` -> `<scheme>`, `session` -> `Cookie`, `mtls` -> handled via `undici` TLS options, not a header). A rogue persona cannot smuggle the credential into a body field by renaming the header.
- **URL is credential-free.** INV-29. Validated at need-write time AND at tool-call time.
- **Body substitution is a byte replace, not a string format.** For `${cred:label}` in a body template, the tool builds the outbound body as `Buffer.concat([prefix, credBuffer, suffix])`. The prefix and suffix are the parts of the template around the token; the token bytes are inserted only into the outbound buffer that is immediately handed to `undici.request` and zeroed on return. There is no intermediate string.
- **One redirect at most, into the plan's host set.** INV-27. Custom `Dispatcher` interceptor refuses `3xx` Locations that resolve outside the plan; sets `maxRedirections: 0` on undici and handles the single-hop case manually.
- **Proxy env stripped.** `sec_http_request` clears `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` for its call scope by passing `undici.request({ dispatcher: freshClient })` with an explicit `origin` and by NOT reading `process.env` for proxy config. A cluster-configured egress proxy MUST NOT sit between the api and the target when a credential is on the wire.

### Response boundary

- **Echo tripwire before hash.** INV-28. Scan the response Buffer against the credential fingerprint index (Part 10) BEFORE canonicalizing for the hash. A match kills the step and skips hash persistence.
- **Shape extraction is streaming.** The shape extractor uses `stream-json` (or an equivalent) to emit key paths without materializing full value strings. Values are consumed to compute a canonical hash and then dropped.
- **No error message with response bytes.** JSON parse errors, TLS errors, HTTP protocol errors: the tool catches every error, discards the caught error's message, and rethrows a `RuntimeVerifyError` whose `message` names only `{step_id, phase: "decode"|"transport"|"tls"|"parse"}`. The original error's stack MAY be captured to structured logs ONLY after passing through the tripwire.

### Logging and observability

- **Structured logger only, tripwire-wrapped.** `sec_http_request` uses a purpose-built logger (`runtimeVerifyLogger`) that emits `{ event: "http_request", step_id, host, method, status }`. The logger has no `.info(headers)` overload; header maps are not loggable objects. Every write passes through the Part 10 tripwire; a fingerprint match hard-fails the log write and quarantines the entry.
- **No fetch auto-instrumentation.** At api boot, the process asserts that no fetch-instrumenting library has monkey-patched `globalThis.fetch`, `undici`, or `http.request`. Check by comparing `Function.prototype.toString.call(fetch)` and the `undici` symbol registry against a captured baseline. Refuses to boot when `verification.enabled === true` AND a patch is detected.
- **No Sentry / DataDog / New Relic auto-capture of headers.** APM libraries that hook fetch by default (Sentry Node, `dd-trace`, `elastic-apm-node`, `newrelic`) MUST be configured with request-header capture disabled and MUST be on an ignore list for the `sec_http_request` module. The spec ships a runbook item; the api boot logs a warning when these libraries are `require`d without the ignore list.
- **No `console.*` in the tool.** `sec_http_request` uses only `runtimeVerifyLogger`. A `console.log` in the tool module fails the code review gate; a runtime `console.log` reaching a credential is caught by the Part 10 tripwire that wraps the process-level console handler.

### Environment refusals at boot

The api refuses to boot when `verification.enabled === true` for any engagement AND any of the following holds:

- `NODE_OPTIONS` contains `--inspect`, `--inspect-brk`, or `--inspect-port`. The V8 inspector exposes the entire heap; anyone with local access reads every decrypted credential.
- `process.env.NODE_ENV === "production"` AND core dumps are enabled (`ulimit -c` unlimited). Core dumps capture the heap.
- The kubernetes pod has `SYS_PTRACE` in its container capabilities. A sidecar could `ptrace` the api.
- The kubernetes pod exposes a debug port outside the pod network.

The refusal names the offending setting and the correction. A break-glass env var `VALET_RUNTIME_VERIFY_UNSAFE_BOOT=1` skips these refusals for local reproduction and is refused when `NODE_ENV === "production"`.

### Heap dump and signal discipline

- **No `v8.writeHeapSnapshot` while a runtime-verify call is in flight.** The tool takes a process-level `runtimeVerifyInFlight` gauge; a snapshot API call refuses with `busy` while gauge > 0. Snapshots take a live heap picture, credential bytes and all.
- **`SIGUSR2` and `SIGQUIT` refuse to dump the heap** when the gauge > 0. The default Node behavior on some deployments is to write a snapshot on SIGUSR2; the api MUST override the handler at boot to check the gauge.
- **Deployment runbook.** The chart README and the operator runbook add: "Do not `kubectl exec` a `node --inspect` or `heapdump` into a running api pod. If you need a snapshot, cancel every running engagement first." This is a runbook item; it is not a code change but Part 11 names it because the code change alone does not close the operator threat.

### Reuse: everything above rides existing seams

None of the items above require new infrastructure. `undici` is already a Valet dependency (transitively via `pi-ai`). The Part 10 tripwire already exists. The structured logger already exists. The boot-time refusal pattern already exists (the api already refuses to boot without `ANTHROPIC_API_KEY`; §Boot refusals adds four more checks in the same code path).

## `sec_http_request` tool

### Contract

Registered in the engine tool registry alongside the existing `sec_*` tools (`packages/plugin-security/src/lib/actions.ts` + `packages/api/src/engine/security-tools.ts`). Available only when `cell.mode === 'runtime-verify'`.

Input schema:

```ts
{
  step_id: string;                       // matches verify_plan.steps[].id
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;                           // MUST match plan.host+path_prefix for this cell
  headers?: Record<string, string>;      // literal headers; NEVER a credential value
  headers_from_vault?: string[];         // vault labels; the tool injects at outbound
  body?: unknown;                        // JSON body; may reference "${st<N>.response.<key path>}"
  expected_shape?: string[];             // key paths the tool asserts exist on the response
  max_calls?: number;                    // default 1; upper bound checked by the tool
}
```

Output schema (returned to the persona):

```ts
{
  step_id: string;
  status: number;
  outcome: "confirmed" | "refuted" | "inconclusive";
  response_shape: string[];              // key paths only; no values
  response_hash: string;                 // sha256:<hex> of canonicalized response
  chained_refs: Record<string, string>;  // for ${st<N>.response.<key path>}; key paths only
  evidence_path: string;                 // "/cells/<NN>-<slug>/verify-runs/<need_id>.yml"
}
```

### Execution steps

1. Load the calling cell's `runtime_verify_plan` from the cell context (set at dispatch time from the origin need). Reject when the cell has no plan.
2. Match `url` against the plan's `host`+`method`+`path_prefix` triple for the named `step_id`. Reject with a corrective error naming the plan when the URL is outside.
3. Increment the per-cell call counter for this step; refuse when `max_calls` is exceeded.
4. Resolve `${st<N>.response.<key path>}` references from prior steps' chained_refs. A missing reference is a hard error.
5. Materialize each label in `headers_from_vault` by loading the ciphertext from `engagement_credentials` (Part 10), decrypting via `decryptSecret`, and building the outbound `Authorization` (or provider-specific) header. Stamp `engagement_credential_access` (Part 10 §Audit).
6. Fire the request with Node fetch from the api process. Timeout at 15 seconds (configurable via `VALET_RUNTIME_VERIFY_TIMEOUT_MS`).
7. Canonicalize request+response bytes (JCS ordering for JSON; raw bytes for other content types). Compute SHA-256 of each.
8. Extract `response_shape` (dotted key paths reached, no values). Verify against `expected_shape`; when a required path is missing, `outcome = "inconclusive"`; when every path is present and status < 400, `outcome = "confirmed"`; when status ≥ 400 or the shape refutes the plan's premise, `outcome = "refuted"`.
9. Discard the plaintext request+response bodies. Neither is written anywhere. In-memory buffers are zeroed before the tool returns.
10. Write the evidence tuple to `/cells/<NN>-<slug>/verify-runs/<need_id>.yml` (append or update). Return the summary above to the persona.

### What the persona sees

The persona sees:

- The plan's `host`+`method`+`path` triples (from the dispatch prompt).
- The tool's summary output (status, outcome, response_shape, response_hash, chained_refs, evidence_path).
- The evidence file it just wrote (via `sec_fs_read`).

The persona NEVER sees:

- A raw response body.
- A raw request body after substitution.
- A credential value.
- Any header the tool injected.

## `runtime-verify` cell mode

### Cell state machine

Adds a fourth `mode` value to Part 01 §"Cell state machine": `fresh | resume | post-pivot-delta | runtime-verify`. All other transitions and settlement rules apply unchanged. Settlement:

- `completed` when every plan step has a written evidence row AND every finding written by the cell cites `traces_to.runtime_step` (INV-23).
- `yielded` when the cell decides mid-plan that a step is inconclusive AND requires human input.
- `failed` when a step fires against a URL outside the plan (INV-21), when a call count exceeds `max_calls`, or when `sec_fs_write` refuses evidence for redaction reasons (INV-22).

### Persona binding

`runtime-verify` is a MODE, not a persona. The persona whose need raised the verify request runs the runtime-verify cell. Attack-tree raises the runtime step, attack-tree runs the runtime-verify cell (with its usual playbook plus a runtime-verify addendum), attack-tree cites `traces_to.runtime_step` on the finding update.

### Transport

A source-only cell writes a need with a new kind (extends Part 04 §4.2):

```yaml
- id: nd_runtime_<...>
  cell_id: c_<...>
  kind: runtime-verify-request
  description: "Prove root API key seeds createSubOrganization on org 019cd..."
  detected_from: "packages/turnkey-client/src/sub-orgs.ts:412"
  would_unblock:
    findings_advanced: [f_root_key_seeds_subord]
    surface_added: ["api.preprod.turnkey.engineering"]
  proposed_resolution:
    auto:
      params:
        verify_plan:
          steps:
            - id: st1
              method: POST
              url: "https://api.preprod.turnkey.engineering/public/v1/submit/create_sub_organization"
              headers_from_vault: [root-api-key]
              body:
                organizationId: "019cd851-152f-40aa-ac32-ed07246f98cb"
                subOrganizationName: "valet-verify-${cell.id}"
              expected_shape: [organizationId, activity.result.createSubOrganizationResult.subOrganizationId]
              max_calls: 1
            - id: st2
              method: POST
              url: "https://api.preprod.turnkey.engineering/public/v1/submit/create_api_keys"
              headers_from_vault: [root-api-key]
              body:
                organizationId: "${st1.response.activity.result.createSubOrganizationResult.subOrganizationId}"
                apiKeys: [{ apiKeyName: "verify-${cell.id}", publicKey: "${keys.pubHex}" }]
              expected_shape: [activity.result.createApiKeysResult.apiKeyIds]
              max_calls: 1
```

### Classification

Part 04 §4.3's classification grows one case: `runtime-verify-request` -> auto (when `verification.enabled === true` and every named vault label exists), target = `pivot-coordinator` (`resolve` mode). When `verification.enabled === false`, the need surfaces as a human decision "runtime-verify not enabled for this engagement; approve to enable or dismiss."

### Dispatch

Part 05's `pivot.yml.rerun_plan[]` grows a fifth mode value `runtime-verify`. The pivot-coordinator's resolve pass writes an entry:

```yaml
- cell_id_new: c_verify_<...>
  persona: <same as origin cell>
  mode: runtime-verify
  need_id: nd_runtime_<...>
  runtime_verify_plan: <verify_plan from the need>
```

The engagement runner picks it up on the next tick. `buildSecurityPersonaTools` sees `mode === 'runtime-verify'` and appends `sec_http_request` to the persona toolset for this cell. Sandbox provisioning is unchanged: same image, same mounts, same env, same egress posture. No networking change.

Dispatch prompt (persona sees this):

```md
Runtime verify plan for need <nd_runtime_...>:
- st1 POST api.preprod.turnkey.engineering/public/v1/submit/create_sub_organization
       body carries organizationId, subOrganizationName; headers injected from vault label root-api-key.
- st2 POST api.preprod.turnkey.engineering/public/v1/submit/create_api_keys
       body carries organizationId from st1.response; headers injected from vault label root-api-key.

Fire each step exactly once with `sec_http_request`. Evidence lands automatically at
/cells/<NN>-<slug>/verify-runs/<need_id>.yml. Call `sec_cell_complete` when every step's evidence is written.

DO NOT use `sec_bash` to reach the target. The persona toolset for this mode routes all runtime-verify traffic
through `sec_http_request`; a bypass fails the cell.
```

### Evidence file schema

```yaml
schema_version: 1
need_id: nd_runtime_<...>
outcome: confirmed | refuted | inconclusive
opened_at: <ms>
closed_at: <ms>
steps:
  - id: st1
    request_hash: sha256:<hex>
    response_status: 200
    response_shape:
      - organizationId
      - activity.id
      - activity.result.createSubOrganizationResult.subOrganizationId
    response_hash: sha256:<hex>
    evidence_excerpt: "Sub-org created; response carries subOrganizationId (redacted)."
  - id: st2
    request_hash: sha256:<hex>
    response_status: 200
    response_shape:
      - activity.result.createApiKeysResult.apiKeyIds
    response_hash: sha256:<hex>
    evidence_excerpt: "Chained api key create succeeded."
```

`evidence_excerpt` is limited to 200 characters, is composed by the tool from a whitelist of shape-only strings, and is scanned by the tripwire on write. `response_shape` is only key paths; values are never captured.

### Redaction

Two write-time gates:

1. `sec_http_request` computes hashes, extracts shape, and discards the raw request+response body before returning. Nothing else on the platform ever sees the body.
2. `sec_fs_write` on `/cells/*/verify-runs/*.yml` refuses any file whose bytes match: (a) a credential fingerprint from Part 10, (b) any value the tool substituted into this cell's requests, (c) a raw JSON body byte match against the captured response's canonical hash. A refusal is a `security_incident` (Part 10 §Redaction), not a soft warning.

## Config schema

`SecurityConfig` gains one top-level block:

```yaml
verification:
  enabled: true                       # default false; only presets `code-audit-plus-live` and `live-pentest` toggle it on
  max_verify_plans: 5                 # cap for the whole engagement
  step_timeout_ms: 15000              # default; per-step upper bound for sec_http_request
  evidence_retention_days: 14         # cleaned with the vault
```

The wizard's Vault step (Part 10 §Ingress) grows a "Verification" checkbox next to "Enable live testing". Ticking it enables `verification.enabled` and reveals a per-engagement cap slider. When unchecked, source-only cells that raise `runtime-verify-request` needs surface them as human-facing decisions.

## Wire API

Extends Part 09.

- `POST /api/sessions/:id/security/needs/resolve` accepts a `runtime-verify-request` kind with `approve: true` or `dismiss: true`. Approve routes the need through the pivot-coordinator's rerun plan; dismiss records the user's decision.
- `GET /api/sessions/:id/security/verify-plans` returns the engagement's runtime-verify roster: `[{needId, cellId, status, stepsCount, targetsCount, openedAt, closedAt?}]`. Owner + admins only.
- `GET /api/sessions/:id/security/verify-plans/:needId/evidence` returns the redacted evidence file. Owner + admins only. Values never appear.
- `POST /api/sessions/:id/security/verify-plans/:needId/abort` sets the runtime-verify cell to `yielded`. Admin-gated.

## Operations

**Rate limits.** Enforced inside `sec_http_request`. `verification.step_timeout_ms` bounds each call; `authorizedScope.rateLimitRps` from Part 09 bounds calls per host across the engagement. A step whose `max_calls` is > 1 is bounded by `min(max_calls, remaining budget)`.

**Kill switch.** `VALET_SECURITY_KILL_SWITCH=1` causes every runtime-verify cell to settle `yielded` on next tick and `sec_http_request` to refuse every call.

**Audit.** Every `sec_http_request` call is stamped in the existing `engagement_credential_access` (Part 10 §Audit) and in a new `engagement_verify_events` table:

```
id                  TEXT PRIMARY KEY               -- eve_<...>
engagement_id       TEXT NOT NULL
cell_id             TEXT NOT NULL
need_id             TEXT NOT NULL
step_id             TEXT NOT NULL
opened_at           BIGINT NOT NULL
closed_at           BIGINT
status_code         INTEGER
outcome             TEXT                           -- confirmed | refuted | inconclusive
credential_ids      TEXT[]                         -- vault labels the step consumed (ids only)
```

No URL, no body, no header value. The owner can answer "did anyone use my token in the last hour, and against what step, with what outcome".

**Metrics.** New Prometheus counters:

- `valet_runtime_verify_calls_total{outcome}`.
- `valet_runtime_verify_deny_total{reason}` where reason is `plan | rate | timeout | tripwire`.
- `valet_runtime_verify_evidence_writes_total`.
- `valet_runtime_verify_bytes_total{direction}`.

No metric includes URL paths or hosts beyond the authorized set.

## Non-goals

- **Multi-round chained verify.** A verify plan is a single ordered list. Chains longer than the plan require a fresh engagement.
- **Adversarial fuzz through `sec_http_request`.** The tool is a scope + credential enforcer, not a fuzz harness. `fuzz` persona traffic still runs through the persona's own installed tool (`ffuf`, `wfuzz`, etc.) inside the sandbox. Part 11 does NOT constrain that path; §Sandbox-native follow-up below is the future work.
- **Response body persistence.** Even ciphertext at rest. The tool holds bytes only long enough to hash and returns.
- **Sandbox network hardening for scanner-heavy live personas.** DAST, fuzz, and exploit personas still make outbound calls from inside the sandbox via their own installed tools; the sandbox network posture is unchanged by Part 11.
- **`sec_http_request` outside runtime-verify cells.** Not exposed to `fresh` / `resume` / `post-pivot-delta` cells even on live personas. Those cells use their existing tools.

## Sandbox-native follow-up

Part 11 solves the source-only-cell-needs-live-call problem without touching the network. It does not solve the broader "DAST scanner in the sandbox can hit anything the sandbox reaches" problem. That is the follow-up. When it lands, the plane it needs is:

- Kubernetes: a `NetworkPolicy` co-created with the Sandbox CR, projecting `authorizedScope.hosts + cidrs` into an `Egress` rule set.
- Docker: replace the default `bridge` with a per-sandbox user-defined `--internal` bridge; the api owns an `iptables` chain that opens only the authorized target set.
- Reader for `VALET_SECURITY_AUTHORIZED_SCOPE`. Turns the passenger env var (`packages/api/src/engine/security-provisioning.ts:36`) into rules; closes the "sandbox-infra follow-up" admitted at `security-provisioning.ts:144-148`.

That work is out of scope for this part. Filed as Part 12 when the DAST persona's live traffic becomes a priority.

## Implementation checklist

Not implemented by this spec. Drives follow-up PRs.

1. **New tool.** `sec_http_request` in `packages/plugin-security/src/actions.ts` + `packages/api/src/engine/security-tools.ts`. Execute steps 1-10 above. Per-call `undici.Client`, `Buffer`-only credential composition, `finally`-zeroed buffers, JCS canonicalization, SHA-256 hash, streaming shape extraction, response-echo tripwire before hash, one-hop redirect refusal, `RuntimeVerifyError` with no response bytes.
2. **Cell mode wiring.** Add `runtime-verify` to Part 01's mode enum, thread through `dispatchCell` and `sec_cell_complete`, wire the citation gate.
3. **Toolset filter.** `buildSecurityPersonaTools` (`packages/api/src/engine/host.ts:2750`) filters `sec_http_request` in for `runtime-verify` cells and out for every other mode.
4. **Needs kind.** Add `runtime-verify-request` to the six existing kinds in Part 04.
5. **Pivot-coordinator.** Extend `rerun_plan[].mode` to accept `runtime-verify`; extend the classifier at Part 04 §4.3; pass the plan into the new cell's context at dispatch.
6. **Evidence writer.** `sec_fs_write` on `/cells/*/verify-runs/*.yml` runs the tripwire check + shape/value validators before persisting.
7. **Wire API.** Four routes above + wizard "Verification" toggle.
8. **Config schema.** `verification:` block, docs, preset defaults.
9. **Metrics + audit.** `engagement_verify_events` table, four Prometheus counters.
10. **Preset flip.** `code-audit-plus-live` and `live-pentest` presets set `verification.enabled = true` by default; every other preset leaves it false.
11. **Node hygiene enforcement.** Runtime `runtimeVerifyLogger` module with tripwire-wrapped writes; process-level `runtimeVerifyInFlight` gauge; SIGUSR2 / SIGQUIT handler override; heap-snapshot guard.
12. **Boot refusals.** Four new environment checks in `packages/api/src/main.ts` next to the existing `ANTHROPIC_API_KEY` refusal (`NODE_OPTIONS` inspector flags, core dumps, `SYS_PTRACE`, exposed debug port), plus the `VALET_RUNTIME_VERIFY_UNSAFE_BOOT` break-glass with prod refusal.
13. **Fetch instrumentation guard.** Boot-time assertion that `globalThis.fetch`, `undici`, and `http.request` are not patched. APM ignore-list runbook item.

Every step above closes at least one INV from §Global invariants. Every INV maps to at least one step above.
