# Part 11: Runtime Execution

*Depends on: Part 00, Part 01, Part 04, Part 05, Part 07, Part 09, Part 12. Conformance: L1+ (server-side gates and tool wiring); L3 dispatches runtime-verify cells; L4 pulls in multi-step verify plans.*

## Purpose

The engagement model has no place for a source-only cell to prove a chain that needs a real API call. An `attack-tree` cell reading Turnkey client code can prove statically that a root API key seeds `createSubOrganization` -> `createApiKeys` -> `createUsers` against org `019cd851-152f-40aa-ac32-ed07246f98cb`. The cell cannot fire the chain and record the actual sub-org id, api key id, and user id as evidence. Source-only cells are forbidden from live network access by policy; no downstream cell mode exists to pick up the intent.

Two ways to close this gap:

- **Sandbox-native.** The persona fires the call itself, inside its sandbox, using the credential broker and `valet-secrets` CLI that Part 12 already lands. Values never enter the api process's heap.
- **API-side.** An engine tool runs in the api's Node process and makes the HTTP call from there. Reuses the existing tool bridge and the existing sandbox provisioning path.

A prior draft of this part picked the api-side path for v1 because the credential store it depended on (a per-engagement vault, since dropped) only had an api-side read path. Part 12 replaces that vault with 1Password references resolved through a sandbox-authenticated broker, so a sandbox-side call no longer needs the api process to touch a value at all. Part 11 v2 ships sandbox-side as the default and keeps api-side as a fallback for a target the sandbox cannot reach.

## Two-mode contract

Runtime-verify cells choose one of two egress modes per call, declared on the cell as `verification.egress_mode: "sandbox" | "api"` (default: `sandbox`).

**Mode 1: `sec_verify_exec` (sandbox-side, default).** A new tool that wraps `valet-secrets run --env ... -- curl ...` with plan enforcement. Reuses the landed broker (`POST /api/sandbox-secrets/resolve`) and the `valet-secrets` CLI (`packages/api/src/engine/secrets-cli-script.ts`). The resolved value transits the broker route in api memory for the length of that one resolve call, the same as any other `valet-secrets` use; it never enters `sec_verify_exec`'s own call path or the api tool's heap. Curl output is canonicalized, hashed, and dropped; evidence is written from the wrapper via `sec_fs_write`. Redirects are refused (`--max-redirs 0`). The wrapper refuses any plan step whose URL template names a credential label or environment variable directly.

**Mode 2: `sec_http_request` (api-side, opt-in).** Kept for a private-cluster target or a Node-native TLS knob no `curl` flag covers. Fires from the api Node process via `undici`. All of this part's Node hygiene (Buffer-not-String, no keep-alive pool, boot refusals, heap-dump guards) applies to this mode only.

A cell chooses mode via the persona's `verification` block; `sec_cell_complete` refuses to settle a runtime-verify cell whose evidence file names an egress mode not listed on the cell.

## Vocabulary

**LLM egress.** The api's Node process posting to `api.anthropic.com`. Runs in the api container, not in the sandbox. Uses the org-configured provider key resolved by `resolveModelSpec` (`packages/api/src/services/model-resolution.ts`). Part 11 does not change LLM egress.

**Egress mode.** `verification.egress_mode`, one of `sandbox` (default) or `api`. Chosen per cell on the persona's `verification` block. Picks which of the two tools below the cell's toolset carries.

**Runtime-verify cell.** A cell dispatched with `mode: runtime-verify`. The persona sees exactly one egress tool for the target, named by the cell's egress mode. It executes an ordered verify plan against a specific `need_id`, writes a redacted evidence file via `sec_fs_write`, and settles.

**`sec_verify_exec`.** The sandbox-side egress tool. Available only to a cell running `mode: runtime-verify` with `egress_mode: "sandbox"`. Runs inside the cell's sandbox via `ctx.sandbox.exec`, wrapping `valet-secrets run --env ... -- curl ...` with plan enforcement.

**`sec_http_request`.** The api-side egress tool. Available only to a cell running `mode: runtime-verify` with `egress_mode: "api"`. Fires one HTTP request from the api process.

**Verify plan.** An ordered `steps[]` list on a `runtime-verify-request` need's `proposed_resolution.auto.params.verify_plan`. Names host, method, path, credentials by Part 12 `label`, body template, and expected response shape.

**Evidence file.** A YAML doc at `/cells/<NN>-<slug>/verify-runs/<need_id>.yml` written by a runtime-verify cell. Carries only key paths, status codes, content hashes, and the cell's egress mode. Never carries a raw response body.

**Retired numbers.** INV-18 and INV-28 from the prior draft are dropped outright; their numbers are not reused. Part 12 owns INV-33 through INV-40. This part owns INV-30 and INV-31; INV-32 is unclaimed.

## Global invariants

**INV-19 (One bounded egress channel per cell).** A runtime-verify cell has exactly one egress tool in its toolset for target egress. `egress_mode: "sandbox"` gives the cell `sec_verify_exec` and nothing else target-egress-shaped. `egress_mode: "api"` gives the cell `sec_http_request` and nothing else. A cell that spawns `curl` from `sec_bash` (sandbox mode) or `fetch` from a JavaScript persona tool (api mode) and hits the plan's host is a hard cell failure; the egress tool rejects the plan and the cell settles `failed`.

**INV-20 (Only `runtime-verify` cells see an egress tool).** The tool is added to the persona's toolset by cell mode and egress mode, not by persona. Source-only cell modes (`fresh`, `resume`, `post-pivot-delta` when the origin persona is source-only) must not have either tool in their toolset. `buildSecurityPersonaTools` (`packages/api/src/engine/security-tools.ts`) reads the mode and the egress mode and filters.

**INV-21 (Verify plan bounds the tool).** Both tools refuse any request whose destination is not covered by the plan's `host`+`method`+`path` triple for the calling cell. The plan is loaded into the tool's per-cell context at dispatch. In sandbox mode, the enforcement lives in the wrapper `sec_verify_exec` installs, not only in the api-side tool; a plan check that runs solely in the api process would not see a call the sandbox fires directly.

**INV-22 (Evidence file has no raw response bytes).** The evidence file schema captures only key paths, HTTP status codes, and SHA-256 hashes of canonicalized request/response bytes. `sec_fs_write` on `/cells/*/verify-runs/*.yml` refuses any evidence doc whose bytes match an entry in Part 12's per-session tripwire index, grouped by engagement (INV-35), the same index the broker populates on every resolve for a session a security cell owns. Part 11 does not keep a second index; a runtime-verify cell's resolved credentials land in the one index Part 12 already maintains, scoped further by the `x-valet-verify-cell` header below (INV-31).

**INV-23 (Every runtime-verify finding cites `traces_to.runtime_step`).** A finding whose status changed inside a runtime-verify cell must include `traces_to.runtime_step: <step_id>` in its state doc. `sec_cell_complete` refuses to settle a runtime-verify cell whose finding writes lack the citation, mirroring the `traces_to.pivot_need` gate from Part 07.

**INV-24 (Api-side mode only: values live in a `Buffer`, never a JS `String`).** Applies only when a cell chose `egress_mode: "api"`. `sec_http_request` reads the resolved value into a Node `Buffer` after `OnePasswordService.resolveReference` (via `onePasswordScopesFor`, Part 12), zeros the Buffer with `.fill(0)` in a `finally` block, and never constructs a JS string from it. This invariant is vacuous for `egress_mode: "sandbox"`: `sec_verify_exec` never receives the value itself, only the wrapped command's exit status and stdout summary. The broker route's own momentary handling of the value inside the api process is Part 12's concern for either mode. Part 12's INV-35 tripwire index and its "zero value memory in the api" non-goal cover that surface. This invariant is scoped to the egress tool's own call path, not the broker.

**INV-25 (Api-side mode only: fresh HTTP client per request).** Applies only in `egress_mode: "api"`. `sec_http_request` builds a per-call `undici.Client`. Keep-alive is disabled. In `egress_mode: "sandbox"`, curl's own transport is used and the wrapper sets `--max-redirs 0` plus a no-keepalive flag.

**INV-26 (Response body and response headers never surface to the persona).** In `egress_mode: "api"`, the response body is read into a Buffer, canonicalized, hashed, shape-extracted, then zeroed; response headers are never returned to the persona, logged, or stored. In `egress_mode: "sandbox"`, the wrapper pipes curl's body straight into an in-sandbox hash and shape extractor. It never writes the body to disk or to a file `sec_bash` could read. The wrapper's stdout to the api tool carries only `status`, `response_hash`, `response_shape`, and, when present, the redirect `Location`. Either mode, the tool's return value carries only `status`, `outcome`, `response_shape`, `response_hash`, `chained_refs` (key paths only), and `evidence_path`.

**INV-27 (Redirect refusal by default).** In `egress_mode: "api"`, `undici` follows at most one redirect and only when the `Location` host is in the plan's host set. In `egress_mode: "sandbox"`, the wrapper sets `--max-redirs 0`; a plan step whose expected response is a redirect must set `expected_shape` to include `Location` and read it from the evidence file, not from a followed redirect.

**INV-29 (No credential in URL, query, or path).** The plan's `url` is validated at need-write time to contain no `$`, `${`, or a percent-encoded variant (`%24`), and no declared credential's `env` name as a literal substring. Only headers and body may name a credential label; the URL never carries a substitution that a proxy, an access log, or a `curl` argv snapshot could capture. Both tools reject a plan step whose URL string fails this check.

**INV-30 (Verify tool cannot be bypassed by direct broker calls).** A runtime-verify cell in `egress_mode: "sandbox"` MUST NOT let its sandbox resolve a credential outside `sec_verify_exec`'s own wrapper. Two implementations satisfy this; a spec conformant implementation picks one and documents which.

- (a) Strip `valet-secrets`, the `op` shim, and any `.valet/credentials.yaml` wrappers from a runtime-verify sandbox in `egress_mode: "sandbox"`; only `sec_verify_exec`'s bundled wrapper resolves values for that cell. This does not by itself stop a direct `curl` to the broker: `/etc/valet/creds/token` still sits on disk (a documented broker limit; see `docs/specs/2026-09-01-sandbox-secret-broker-design.md`), so a persona that reads the token file and crafts its own broker request bypasses the removal. It only removes the convenience path.
- (b) Add the broker-side allowlist keyed on `x-valet-verify-cell` in INV-31 below. This is the approach that actually closes the gap: a request without a valid single-use token is refused regardless of what scripts sit on the sandbox's `PATH`.

This part recommends (b), and (a) as defense in depth alongside it, not as a substitute.

**INV-31 (Broker sees the calling cell).** `sec_verify_exec`'s wrapper mints a single-use token bound to `(cell_id, step_id)` at call time and passes it to the broker as `x-valet-verify-cell: <token>`. A bare `cell_id` would be forgeable: the persona already knows its own cell id from the dispatch prompt and the evidence path, so a header carrying only that id would let a direct `curl` to the broker impersonate `sec_verify_exec`. The token, not the cell id, is what the broker checks. The broker route validates the token against a runtime-verify cell in `running` state, gated by `x-valet-sandbox`'s session claim, and consumes it: a second request with the same token is refused. The broker logs and rate-limits per verify cell, not per sandbox.

## LLM call topology (informative)

Included to remove ambiguity. Unchanged by Part 11.

- A persona child session is built by `EngineHost.buildChildSession` (`packages/api/src/engine/host.ts`). Its `Thread` owns a pi-agent-core `Agent` (`packages/engine/src/thread.ts`) that runs in the api's Node process.
- `streamSimple` sends bytes from the api process to `api.anthropic.com`. The sandbox is not on that path.
- Tool intent flows: model returns `tool_call` -> the tool's `execute` runs in the api process -> for `sec_verify_exec` the tool reaches into the sandbox via `ctx.sandbox.exec`; for `sec_http_request` the tool fires the network call directly from the api process -> result normalized and handed back to the Agent.
- `ANTHROPIC_API_KEY` is loaded at api boot (`packages/api/src/main.ts`) and never included in `mintSandboxEnv` (`packages/api/src/engine/host.ts`). No provider key ever reaches the sandbox.

Two consequences. First, LLM calls and any api-mode runtime-verify call both leave the api container, but they resolve to different destinations and different auth. Second, a sandbox-mode runtime-verify call never opens a socket from the api process at all; the sandbox's `curl` does.

## Node process hygiene (api-side fallback only)

This entire section applies only to a cell running `egress_mode: "api"`. A cell in `egress_mode: "sandbox"`, the default, has no api-heap surface for the credential value beyond the broker's own momentary resolve, which is Part 12's concern. An engagement whose every cell runs `egress_mode: "sandbox"` never exercises this section at all.

### In-memory hygiene

- **Buffers, not strings.** `OnePasswordService.resolveReference` returns the plaintext; every downstream composition (header value, body substitution) is a `Buffer.concat` or a `TextEncoder.encodeInto` into a mutable `Uint8Array`. Never `` `Authorization: Bearer ${token}` ``. Zero the Buffer with `.fill(0)` in `finally`, on every path. INV-24.
- **Per-request dispatcher.** `sec_http_request` constructs a fresh `undici.Client` (single-shot Dispatcher) per call, sets `keepAliveTimeout: 0` and `Connection: close` on the request, and calls `client.close()` after `response.body` is drained and zeroed. INV-25.
- **Bounded body reads.** Response bodies are read into a Buffer capped at 256 KiB (`VALET_RUNTIME_VERIFY_MAX_RESPONSE_BYTES`). A response over the cap settles `outcome: "inconclusive"` with reason `"response-too-large"` and the tool discards it.
- **No subprocess.** `sec_http_request` must not spawn `curl`, `wget`, or any child process. In-process fetch only. A subprocess would inherit the api's env and its argv would be visible via `/proc/self/cmdline` for the lifetime of the call.

### Boundary discipline

- **Header keys the tool sets, not the persona.** The persona names a Part 12 credential label; the tool composes the header key. The persona must not name the header key (`Authorization`, `Cookie`, `X-Stamp`); the credential's `kind` (Part 12) picks the key deterministically (`headerToken` -> `<scheme>`, `session` -> `Cookie`, `mtls` -> handled via `undici` TLS options, not a header).
- **URL is credential-free.** INV-29. Validated at need-write time and at tool-call time.
- **Body substitution is a byte replace, not a string format.** For a credential reference in a body template, the tool builds the outbound body as `Buffer.concat([prefix, credBuffer, suffix])`. The prefix and suffix are the parts of the template around the token; the token bytes are inserted only into the outbound buffer immediately handed to `undici.request` and zeroed on return.
- **One redirect at most, into the plan's host set.** INV-27.
- **Proxy env stripped.** `sec_http_request` clears `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` for its call scope and does not read `process.env` for proxy config.

### Response boundary

- **Echo tripwire before hash.** Scan the response Buffer against Part 12's per-session tripwire index, grouped by engagement (INV-35), before canonicalizing for the hash. A match kills the step and skips hash persistence.
- **Shape extraction is streaming.** The shape extractor uses `stream-json` (or an equivalent) to emit key paths without materializing full value strings.
- **No error message with response bytes.** The tool catches every error, discards the caught error's message, and rethrows a `RuntimeVerifyError` whose `message` names only `{step_id, phase: "decode"|"transport"|"tls"|"parse"}`.

### Logging and observability

- **Structured logger only, tripwire-wrapped.** `sec_http_request` uses a purpose-built logger (`runtimeVerifyLogger`) that emits `{ event: "http_request", step_id, host, method, status }`. The logger has no `.info(headers)` overload. Every write passes through Part 12's tripwire index (INV-35); a match hard-fails the log write.
- **No fetch auto-instrumentation.** At api boot, the process asserts that no fetch-instrumenting library has monkey-patched `globalThis.fetch`, `undici`, or `http.request`. Refuses to boot when some engagement's `verification.egress_mode` permits `"api"` and a patch is detected.
- **No Sentry / DataDog / New Relic auto-capture of headers.** APM libraries that hook fetch by default must be configured with request-header capture disabled and must be on an ignore list for the `sec_http_request` module.
- **No `console.*` in the tool.** `sec_http_request` uses only `runtimeVerifyLogger`.

### Environment refusals at boot

The api refuses to boot when any engagement's `verification.egress_mode` permits `"api"` and any of the following holds:

- `NODE_OPTIONS` contains `--inspect`, `--inspect-brk`, or `--inspect-port`.
- `process.env.NODE_ENV === "production"` and core dumps are enabled (`ulimit -c` unlimited).
- The kubernetes pod has `SYS_PTRACE` in its container capabilities.
- The kubernetes pod exposes a debug port outside the pod network.

The refusal names the offending setting and the correction. A break-glass env var `VALET_RUNTIME_VERIFY_UNSAFE_BOOT=1` skips these refusals for local reproduction and is refused when `NODE_ENV === "production"`.

### Heap dump and signal discipline

- **No `v8.writeHeapSnapshot` while an api-mode call is in flight.** The tool takes a process-level `runtimeVerifyInFlight` gauge; a snapshot API call refuses with `busy` while gauge > 0.
- **`SIGUSR2` and `SIGQUIT` refuse to dump the heap** when the gauge > 0.
- **Deployment runbook.** The chart README and the operator runbook add: "Do not `kubectl exec` a `node --inspect` or `heapdump` into a running api pod while an api-mode runtime-verify call may be in flight."

### Reuse: everything above rides existing seams

`undici` is already a Valet dependency (transitively via `pi-ai`). Part 12's tripwire index already exists. The structured logger already exists. The boot-time refusal pattern already exists (the api already refuses to boot without `ANTHROPIC_API_KEY`; this section adds four more checks in the same code path, scoped to api-mode engagements).

## `sec_verify_exec` tool (sandbox-side, default)

### Contract

Registered alongside the existing `sec_*` tools (`packages/plugin-security/src/lib/actions.ts` + `packages/api/src/engine/security-tools.ts`). Available only when `cell.mode === 'runtime-verify'` and the cell's `egress_mode === 'sandbox'`.

Input schema:

```ts
{
  step_id: string;                       // matches verify_plan.steps[].id
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;                           // MUST match plan.host+path_prefix for this cell
  headers?: Record<string, string>;      // literal headers; NEVER a credential value
  credentials?: string[];                // Part 12 credential labels; the wrapper injects at outbound
  body?: unknown;                        // JSON body; may reference "${st<N>.response.<key path>}"
  expected_shape?: string[];             // key paths the tool asserts exist on the response
  max_calls?: number;                    // default 1; upper bound checked by the tool
}
```

Output schema (returned to the persona): identical to `sec_http_request`'s below.

### Execution steps

1. Load the calling cell's `runtime_verify_plan` from the cell context (set at dispatch time from the origin need). Reject when the cell has no plan.
2. Match `url` against the plan's `host`+`method`+`path_prefix` triple for the named `step_id`. Reject with a corrective error naming the plan when the URL is outside.
3. Increment the per-cell call counter for this step; refuse when `max_calls` is exceeded.
4. Resolve `${st<N>.response.<key path>}` references from prior steps' `chained_refs`. A missing reference is a hard error.
5. Mint a single-use token bound to `(cell_id, step_id)` (INV-31). Build the wrapped command: `valet-secrets run --env NAME=<credential's reference> [...] -- curl --max-redirs 0 --no-keepalive -H 'x-valet-verify-cell: <token>' ...`, one `--env` per requested label.
6. Run the command via `ctx.sandbox.exec`. The wrapper pipes curl's response body into an in-sandbox hash and shape extractor; it writes nothing to a file `sec_bash` could read and prints only `status`, `response_hash`, `response_shape`, and any `Location` header to its own stdout.
7. Parse the wrapper's stdout. Verify the shape against `expected_shape`; when a required path is missing, `outcome = "inconclusive"`; when every path is present and status < 400, `outcome = "confirmed"`; when status >= 400, `outcome = "refuted"`.
8. Write the evidence tuple, including `egress_mode: "sandbox"`, to `/cells/<NN>-<slug>/verify-runs/<need_id>.yml` via `sec_fs_write`. Return the summary to the persona.

## `sec_http_request` tool (api-side, opt-in)

### Contract

Registered alongside the existing `sec_*` tools (`packages/plugin-security/src/lib/actions.ts` + `packages/api/src/engine/security-tools.ts`). Available only when `cell.mode === 'runtime-verify'` and the cell's `egress_mode === 'api'`.

Input schema:

```ts
{
  step_id: string;                       // matches verify_plan.steps[].id
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;                           // MUST match plan.host+path_prefix for this cell
  headers?: Record<string, string>;      // literal headers; NEVER a credential value
  credentials?: string[];                // Part 12 credential labels; the tool injects at outbound
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
4. Resolve `${st<N>.response.<key path>}` references from prior steps' `chained_refs`. A missing reference is a hard error.
5. Resolve each label in `credentials` via `OnePasswordService.resolveReference`, using the scopes `onePasswordScopesFor(ownerType, teamId?)` returns for the engagement's owner (Part 12), and build the outbound header from the credential's `kind`.
6. Fire the request with `undici` from the api process. Timeout at 15 seconds (configurable via `VALET_RUNTIME_VERIFY_TIMEOUT_MS`).
7. Canonicalize request+response bytes (JCS ordering for JSON; raw bytes for other content types). Compute SHA-256 of each.
8. Extract `response_shape` (dotted key paths reached, no values). Verify against `expected_shape`; when a required path is missing, `outcome = "inconclusive"`; when every path is present and status < 400, `outcome = "confirmed"`; when status >= 400 or the shape refutes the plan's premise, `outcome = "refuted"`.
9. Discard the plaintext request+response bodies. In-memory buffers are zeroed before the tool returns.
10. Write the evidence tuple, including `egress_mode: "api"`, to `/cells/<NN>-<slug>/verify-runs/<need_id>.yml`. Return the summary to the persona.

### What the persona sees, both modes

The persona sees:

- The plan's `host`+`method`+`path` triples (from the dispatch prompt).
- The tool's summary output (status, outcome, response_shape, response_hash, chained_refs, evidence_path).
- The evidence file it just wrote (via `sec_fs_read`).

The persona never sees a raw response body, a raw request body after substitution, a credential value, or any header the tool injected.

## `runtime-verify` cell mode

### Cell state machine

Adds a fourth `mode` value to Part 01's cell state machine: `fresh | resume | post-pivot-delta | runtime-verify`. All other transitions and settlement rules apply unchanged. Settlement:

- `completed` when every plan step has a written evidence row, every row's `egress_mode` matches the mode listed on the cell, and every finding written by the cell cites `traces_to.runtime_step` (INV-23).
- `yielded` when the cell decides mid-plan that a step is inconclusive and requires human input.
- `failed` when a step fires against a URL outside the plan (INV-21), when a call count exceeds `max_calls`, or when `sec_fs_write` refuses evidence for redaction reasons (INV-22).

### Persona binding

`runtime-verify` is a mode, not a persona. The persona whose need raised the verify request runs the runtime-verify cell. Attack-tree raises the runtime step, attack-tree runs the runtime-verify cell (with its usual playbook plus a runtime-verify addendum), attack-tree cites `traces_to.runtime_step` on the finding update.

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
        egress_mode: sandbox
        verify_plan:
          steps:
            - id: st1
              method: POST
              url: "https://api.preprod.turnkey.engineering/public/v1/submit/create_sub_organization"
              credentials: [root-api-key]
              body:
                organizationId: "019cd851-152f-40aa-ac32-ed07246f98cb"
                subOrganizationName: "valet-verify-${cell.id}"
              expected_shape: [organizationId, activity.result.createSubOrganizationResult.subOrganizationId]
              max_calls: 1
            - id: st2
              method: POST
              url: "https://api.preprod.turnkey.engineering/public/v1/submit/create_api_keys"
              credentials: [root-api-key]
              body:
                organizationId: "${st1.response.activity.result.createSubOrganizationResult.subOrganizationId}"
                apiKeys: [{ apiKeyName: "verify-${cell.id}", publicKey: "${keys.pubHex}" }]
              expected_shape: [activity.result.createApiKeysResult.apiKeyIds]
              max_calls: 1
```

`root-api-key` is a label declared in the engagement's `securityConfig.credentials[]` (Part 12), the same way any other security-engagement credential is declared.

### Classification

Part 04 §4.3's classification grows one case: `runtime-verify-request` -> auto (when `verification.enabled === true` and every named credential label exists in `securityConfig.credentials`), target = `pivot-coordinator` (`resolve` mode). When `verification.enabled === false`, the need surfaces as a human decision: "runtime-verify not enabled for this engagement; approve to enable or dismiss."

### Dispatch

Part 05's `pivot.yml.rerun_plan[]` grows a fifth mode value `runtime-verify`. The pivot-coordinator's resolve pass writes an entry:

```yaml
- cell_id_new: c_verify_<...>
  persona: <same as origin cell>
  mode: runtime-verify
  egress_mode: sandbox
  need_id: nd_runtime_<...>
  runtime_verify_plan: <verify_plan from the need>
```

The engagement runner picks it up on the next tick. `buildSecurityPersonaTools` sees `mode === 'runtime-verify'` and appends `sec_verify_exec` (when `egress_mode === 'sandbox'`) or `sec_http_request` (when `egress_mode === 'api'`) to the persona toolset for this cell, never both. Sandbox provisioning is unchanged for `egress_mode: 'api'`: same image, same mounts, same env. For `egress_mode: 'sandbox'`, the sandbox spec (`packages/api/src/engine/sandbox-spec.ts`) reads the cell's egress mode when generating prep steps and, per INV-30(a), may skip the general-purpose `credential-scripts` step in favor of installing only `sec_verify_exec`'s bundled wrapper.

Dispatch prompt (sandbox mode; persona sees this):

```md
Runtime verify plan for need <nd_runtime_...>:
- st1 POST api.preprod.turnkey.engineering/public/v1/submit/create_sub_organization
       body carries organizationId, subOrganizationName; credential label root-api-key.
- st2 POST api.preprod.turnkey.engineering/public/v1/submit/create_api_keys
       body carries organizationId from st1.response; credential label root-api-key.

Fire each step exactly once with `sec_verify_exec`. Evidence lands automatically at
/cells/<NN>-<slug>/verify-runs/<need_id>.yml. Call `sec_cell_complete` when every step's evidence is written.

DO NOT use `sec_bash` or `valet-secrets` directly to reach the target. This cell's toolset routes all
runtime-verify traffic through `sec_verify_exec`; a bypass fails the cell.
```

The api-mode dispatch prompt is the same shape, naming `sec_http_request` in place of `sec_verify_exec` and dropping the `sec_bash`/`valet-secrets` bypass warning (an api-mode cell's sandbox never holds the credential at all).

### Evidence file schema

```yaml
schema_version: 1
need_id: nd_runtime_<...>
egress_mode: sandbox
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

`evidence_excerpt` is limited to 200 characters, is composed by the tool from a whitelist of shape-only strings, and is scanned against Part 12's tripwire index on write. `response_shape` is only key paths; values are never captured.

### Redaction

Two write-time gates:

1. Either tool computes hashes, extracts shape, and discards the raw request+response body before returning. Nothing else on the platform ever sees the body.
2. `sec_fs_write` on `/cells/*/verify-runs/*.yml` refuses any file whose bytes match an entry in Part 12's per-session tripwire index, grouped by engagement (INV-35, scoped further here by the `x-valet-verify-cell` token from INV-31), or a raw JSON body byte match against the captured response's canonical hash. A refusal is a `security_incident`, not a soft warning.

## Config schema

`SecurityConfig` gains one top-level block:

```yaml
verification:
  enabled: true                       # default false; only presets `code-audit-plus-live` and `live-pentest` toggle it on
  egress_mode: sandbox                # default for cells that don't set their own; "sandbox" | "api"
  max_verify_plans: 5                 # cap for the whole engagement
  step_timeout_ms: 15000              # default; per-step upper bound for either tool
  evidence_retention_days: 14         # cleaned with the credentials
```

The wizard's Advanced credentials sub-section (Part 12) grows a "Verification" checkbox next to "Enable live testing", plus an egress mode picker defaulted to sandbox. Ticking the checkbox enables `verification.enabled` and reveals a per-engagement cap slider. When unchecked, source-only cells that raise `runtime-verify-request` needs surface them as human-facing decisions.

## Wire API

Extends Part 09.

- `POST /api/sessions/:id/security/needs/resolve` accepts a `runtime-verify-request` kind with `approve: true` or `dismiss: true`. Approve routes the need through the pivot-coordinator's rerun plan; dismiss records the user's decision.
- `GET /api/sessions/:id/security/verify-plans` returns the engagement's runtime-verify roster: `[{needId, cellId, egressMode, status, stepsCount, targetsCount, openedAt, closedAt?}]`. Owner + admins only.
- `GET /api/sessions/:id/security/verify-plans/:needId/evidence` returns the redacted evidence file. Owner + admins only. Values never appear.
- `POST /api/sessions/:id/security/verify-plans/:needId/abort` sets the runtime-verify cell to `yielded`. Admin-gated.

## Operations

**Rate limits.** Enforced inside both tools. `verification.step_timeout_ms` bounds each call; `authorizedScope.rateLimitRps` from Part 09 bounds calls per host across the engagement. A step whose `max_calls` is > 1 is bounded by `min(max_calls, remaining budget)`.

**Kill switch.** `VALET_SECURITY_KILL_SWITCH=1` causes every runtime-verify cell to settle `yielded` on next tick and causes both `sec_verify_exec` and `sec_http_request` to refuse every call.

**Audit.** Every call to either tool is stamped in a new `engagement_verify_events` table:

```
id                  TEXT PRIMARY KEY               -- eve_<...>
engagement_id       TEXT NOT NULL
cell_id             TEXT NOT NULL
need_id             TEXT NOT NULL
step_id             TEXT NOT NULL
egress_mode         TEXT NOT NULL                  -- sandbox | api
opened_at           BIGINT NOT NULL
closed_at           BIGINT
status_code         INTEGER
outcome             TEXT                           -- confirmed | refuted | inconclusive
credential_labels   TEXT[]                         -- Part 12 labels the step consumed
```

No URL, no body, no header value. The owner can answer "did anyone use my credential in the last hour, and against what step, with what outcome."

**Metrics.** New Prometheus counters, each carrying a `mode` label (`sandbox` | `api`):

- `valet_runtime_verify_calls_total{outcome, mode}`.
- `valet_runtime_verify_deny_total{reason, mode}` where reason is `plan | rate | timeout | tripwire`.
- `valet_runtime_verify_evidence_writes_total{mode}`.
- `valet_runtime_verify_bytes_total{direction, mode}`.

No metric includes URL paths or hosts beyond the authorized set.

## Non-goals

- **Multi-round chained verify.** A verify plan is a single ordered list. Chains longer than the plan require a fresh engagement.
- **Adversarial fuzz through either egress tool.** Both tools are a scope + credential enforcer, not a fuzz harness. `fuzz` persona traffic still runs through the persona's own installed tool (`ffuf`, `wfuzz`, etc.) inside the sandbox, unconstrained by either tool.
- **Response body persistence.** Even ciphertext at rest. Either tool holds bytes only long enough to hash, and returns.
- **Sandbox network hardening for scanner-heavy live personas.** DAST, fuzz, and exploit personas still make outbound calls from inside the sandbox via their own installed tools; the sandbox network posture is unchanged by Part 11.
- **Either egress tool outside runtime-verify cells.** Not exposed to `fresh` / `resume` / `post-pivot-delta` cells even on live personas. Those cells use their existing tools.
- **In-sandbox egress-seam redaction for `sec_verify_exec`'s own wrapper.** The wrapper's own use of the broker relies on Part 12's persist and send seams (INV-35) to catch a value that reaches the api process; a wrapper-internal redaction pass is a documented follow-up, not required here.

## Sandbox-native default

A prior draft shipped api-side as the only mode, with sandbox-native noted as a follow-up. Part 11 v2 ships sandbox-side as the default because the broker and `valet-secrets` primitives that unlock it are landed on dev-v2 (see `docs/specs/2026-09-01-sandbox-secret-broker-design.md`). The api-side mode is retained as a fallback so an engagement whose target is only reachable from the api (a private cluster, a Node-native TLS knob) can still verify.

## Implementation checklist

Not implemented by this spec. Drives follow-up PRs.

1. **`sec_verify_exec` tool.** New tool in `packages/plugin-security/src/lib/actions.ts` + `packages/api/src/engine/security-tools.ts`. Generates the wrapped `valet-secrets run --env ... -- curl ...` command, mints the single-use `x-valet-verify-cell` token, runs it via `ctx.sandbox.exec`, parses the wrapper's summary stdout, writes evidence.
2. **`sec_http_request` tool.** Update from the prior draft: `credentials` names Part 12 labels, the same field name `sec_verify_exec` uses; resolution goes through `OnePasswordService.resolveReference` under `onePasswordScopesFor`, not a dropped vault's `decryptSecret`.
3. **Cell mode wiring.** Add `runtime-verify` to Part 01's mode enum, thread through `dispatchCell` and `sec_cell_complete`, wire the citation gate and the `egress_mode` match check.
4. **Toolset filter.** `buildSecurityPersonaTools` (`packages/api/src/engine/security-tools.ts`) filters in exactly one of `sec_verify_exec` / `sec_http_request` for a `runtime-verify` cell, keyed on `egress_mode`, and filters both out for every other mode.
5. **Needs kind.** Add `runtime-verify-request` to the existing kinds in Part 04, with `egress_mode` on `proposed_resolution.auto.params`.
6. **Pivot-coordinator.** Extend `rerun_plan[].mode` to accept `runtime-verify`; extend the classifier at Part 04 §4.3; pass the plan and `egress_mode` into the new cell's context at dispatch.
7. **Sandbox spec conditional.** `packages/api/src/engine/sandbox-spec.ts` reads the cell's mode and egress mode when generating prep steps; per INV-30(a), a runtime-verify cell in `egress_mode: sandbox` may skip the general-purpose `credential-scripts` step.
8. **Broker header check.** Extend `packages/api/src/routes/sandbox-secrets.ts` to accept and validate a single-use `x-valet-verify-cell` token for a request from a runtime-verify cell, per INV-31.
9. **Evidence writer.** `sec_fs_write` on `/cells/*/verify-runs/*.yml` runs the Part 12 tripwire check plus the shape/value validators before persisting.
10. **Wire API.** Four routes above + wizard "Verification" toggle and egress-mode picker.
11. **Config schema.** `verification:` block with `egress_mode`, docs, preset defaults.
12. **Metrics + audit.** `engagement_verify_events` table (with `egress_mode` and `credential_labels` columns), four Prometheus counters carrying a `mode` label.
13. **Preset flip.** `code-audit-plus-live` and `live-pentest` presets set `verification.enabled = true` with `egress_mode: sandbox` by default; every other preset leaves `verification.enabled` false.
14. **Node hygiene enforcement (api mode only).** Runtime `runtimeVerifyLogger` module with tripwire-wrapped writes; process-level `runtimeVerifyInFlight` gauge; `SIGUSR2` / `SIGQUIT` handler override; heap-snapshot guard. Gated on some engagement's `verification.egress_mode` permitting `"api"`.
15. **Boot refusals (api mode only).** Four new environment checks in `packages/api/src/main.ts` next to the existing `ANTHROPIC_API_KEY` refusal (`NODE_OPTIONS` inspector flags, core dumps, `SYS_PTRACE`, exposed debug port), plus the `VALET_RUNTIME_VERIFY_UNSAFE_BOOT` break-glass with prod refusal. Gated the same way as item 14.
16. **Fetch instrumentation guard (api mode only).** Boot-time assertion that `globalThis.fetch`, `undici`, and `http.request` are not patched. APM ignore-list runbook item.

Every step above closes at least one invariant from Global invariants. Every invariant maps to at least one step above.
