# LLM Recording Gateway Design — pass-through recording of Claude Code and Codex traffic

**Date:** 2026-08-26
**Status:** Approved design (revised after adversarial review), not yet implemented
**Scope:** Adds a transparent recording gateway in `packages/api` that presents Anthropic Messages and OpenAI Responses endpoints to external agent harnesses (Claude Code, Codex CLI). The harness points its base URL at valet and authenticates with a per-user `vlt_` key. Valet forwards each request verbatim to the real provider, swaps in the org's real upstream key, streams the response back unbuffered, and records the full request/response plus token usage and cost. It also normalizes each call into a provider-agnostic `Sample` (messages, system, tools, output) for analysis and a future training-data pipeline. Every proxied call is attributed to a user. A usage dashboard aggregates spend per user, model, and harness. Reuses the `vlt_` API-key identity (auth middleware rung 4), the `llm_providers` + `CredentialStore` upstream-key path, and the `cost_entries` cost-attribution invariant.

**Not MITM.** The name "MITM" was the original framing, but this is not TLS interception: no CA cert, no transparent capture of traffic that still points at the real provider. It is an explicit opt-in reverse proxy — the harness is reconfigured (`base_url`) to send its traffic to valet. This document calls it the "recording gateway."

**Build, not buy.** LiteLLM Proxy is the reference for the pass-through pattern and the spend-log schema, but valet builds its own gateway rather than run LiteLLM as a sidecar. The reasons: native `vlt_`/org identity (no key-mapping glue between two user models), a single deploy and one Postgres, and full control of the recorded data model and the `cost_entries` invariant.

## Context

- Engineers run Claude Code and Codex on their laptops against Anthropic and OpenAI directly. That spend is invisible to the org: no per-user attribution, no prompt/response record, no central budget view.
- Both harnesses can redirect every API call to a chosen host. Claude Code reads `ANTHROPIC_BASE_URL` once at start and sends every request there, with auth as `ANTHROPIC_AUTH_TOKEN` (Bearer) or `ANTHROPIC_API_KEY` (`x-api-key`). Codex defines a custom provider in `~/.codex/config.toml` with `base_url`, `env_key`, and `wire_api`, or overrides the built-in with `OPENAI_BASE_URL`.
- **Codex constraint:** since February 2026, a Codex custom provider must set `wire_api = "responses"`. The proxy must speak the OpenAI Responses API, not Chat Completions. Provider ids `openai`, `ollama`, and `lmstudio` are reserved, so valet registers as a new provider id.
- Valet already owns the three pieces this needs: per-user `vlt_` API keys (better-auth `apiKey` plugin, `packages/api/src/auth/index.ts`), org upstream keys (`llm_providers` rows + `CredentialStore`, service `llm:{rowId}`), and a single cost-attribution definition (`cost_entries` view, `packages/api/migrations/pg/0000_app.sql`). A streaming reverse-proxy already exists as prior art (`packages/api/src/routes/gateway-proxy.ts`).

## The model

One sentence: **valet speaks no LLM wire format — it forwards raw bytes to the real provider, tees the response to a recorder, and only parses far enough to read the usage numbers.**

This is LiteLLM's pass-through mode, not its unified mode. LiteLLM's unified `/chat/completions` surface normalizes every provider into one schema; that would force valet to own both the Anthropic Messages format and the young, moving OpenAI Responses format, and to break whenever either harness changes its wire. Pass-through forwards verbatim, attaches a virtual key, and writes one spend-log row per call. Valet copies that behavior.

### Nouns

| Noun | Definition |
|---|---|
| **Proxy key** | A per-user `vlt_` API key (existing `apiKey` plugin). The identity anchor for every proxied request. The harness sends it; valet resolves it to `{userId, orgId, keyId}`. Never leaves valet — the real upstream key is swapped in on the outbound hop. |
| **Ingress route** | A public, wire-compatible mount: `/proxy/anthropic/*` and `/proxy/openai/*`. Path suffixes (`/v1/messages`, `/v1/responses`) are fixed by the clients; the prefix is valet's. |
| **Upstream** | `{ baseUrl, apiKey }` for a provider `kind`, resolved from the org's default `llm_providers` row of that kind + its `CredentialStore` secret. |
| **Recorder** | The tee branch that accumulates the streamed response and, on completion, parses SSE events for the usage object, computes cost, and writes one row. |
| **Proxy request row** | One `llm_proxy_requests` row per recorded call: identity, provider kind, model, harness, endpoint, full request/response bodies, token usage, cost, latency, status. Valet's `LiteLLM_SpendLogs` analog. |

### Verbs

| Verb | Definition |
|---|---|
| **resolve** | `resolveProxyPrincipal(headers)` reads the key from `x-api-key` or `Authorization: Bearer`, runs `auth.api.verifyApiKey`, and returns `{userId, orgId, keyId}`, or a wire-correct 401. |
| **forward** | Fetch the upstream `{baseUrl}{subpath}{search}` with the request body streamed through, valet's key replaced by the real key, and hop-by-hop headers stripped. |
| **tee** | `ReadableStream.tee()` the upstream response body: one branch streams to the client unbuffered; the other feeds the recorder. |
| **record** | On response completion, parse usage, price it, and insert one `llm_proxy_requests` row. Failure to parse usage leaves `cost_usd` NULL (unpriced, not free). |
| **auto-provision** | On boot, for each of `anthropic`/`openai`: if the env key (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) is set and the org has no provider of that kind, seed a provider row + credential from the env value. |

## Decisions (locked)

1. **Transparent pass-through on the forwarding path.** Valet forwards request and response bytes untouched — parsing NEVER alters, blocks, or delays what the harness sends or receives. This survives wire-format changes in either harness and sidesteps the Codex Responses-API requirement entirely: valet proxies to OpenAI, which already speaks Responses. All parsing (for usage AND for analysis, decision 9) happens off the forwarding path, on the recorder's tee branch, over bytes valet has already delivered.
2. **Identity is the `vlt_` key.** No new key system. The proxy accepts the key in either the `x-api-key` header (Anthropic form) or the `Authorization: Bearer` header (OpenAI/Codex form, and Claude Code's `ANTHROPIC_AUTH_TOKEN`). Both resolve through the existing `verifyApiKey`. **Precedence (learned in live testing):** Claude Code sends BOTH headers — the `vlt_` key as the bearer AND, whenever `ANTHROPIC_API_KEY` is set in the user's environment, the real provider key as `x-api-key`. So `extractKey` prefers whichever candidate carries the `vlt_` prefix, not a fixed header order; otherwise it would pick the unverifiable provider key and 401 every Claude Code user who has `ANTHROPIC_API_KEY` set.
3. **Credential strategy is an org-level switch (`centralized` | `passthrough`).** Stored on the org (`orgs.features.proxyCredentialMode`, default `centralized`); an org-admin sets it via `PUT /api/proxy/settings`.
   - **`centralized` (default):** the user configures only a `vlt_` key on the laptop. Valet swaps in the org's real provider key from `CredentialStore` on the outbound hop; the real key never reaches the laptop, and the org's key bills. This is the "valet holds the upstream key" model.
   - **`passthrough`:** the user configures a `vlt_` key (identity) AND their own provider key. The `vlt_` key still identifies the user for attribution, but valet forwards the user's OWN key upstream instead of the org key — so per-user keys and billing are preserved while valet only observes. Attribution works because the harness presents two credentials: the gateway picks the `vlt_`-prefixed one for identity (`extractKey`) and forwards the non-`vlt_` one upstream (`extractPassthroughKey`). If no BYO key is present, the gateway 400s naming the fix. Codex pass-through is a rough edge (Codex sends one credential; the user must supply the `vlt_` via a custom `http_header` and the real key as `env_key`).
   - **Subscriptions are NOT supported by either mode.** A Claude Pro/Max subscription authenticates over OAuth, a different rail from the token/API-key path this proxy intercepts. Routing a subscription through the gateway converts it to metered API billing; observing subscription usage needs a different mechanism (e.g. Claude Code's native OpenTelemetry export).
4. **Env auto-provisions a provider.** If `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are present at boot and no matching provider row exists, valet seeds one. The local success-criteria demo works with zero manual setup; production still resolves through the normal provider path.
5. **Bodies are stored like engine prompts.** Full request and response bodies are plaintext in Postgres, the same substrate and posture as `engine_entries` prompt data. No new encryption path for large blobs.
6. **`cost_entries` stays the one cost definition.** The view gains a `UNION ALL` of proxy rows mapped into its columns, so Grafana and `/api/usage` pick up proxy spend without a second definition.
7. **Record per request, not per conversation — but store the chaining ids.** Codex Responses is stateful; a request may carry `previous_response_id` instead of the full transcript. Valet records exactly what crosses the wire and does not reconstruct conversations at MVP. It DOES persist `provider_response_id` and `previous_response_id` (finding 5) so a later stitcher can walk the chain — the alternative (not storing them) makes reconstruction impossible to backfill.
8. **A per-key spend metric and alert ship with the MVP (finding 7).** A recording gateway whose purpose is spend management must not itself be blind to a runaway or leaked key. Hard budget caps are deferred (they fit "alert, don't auto-repair" poorly), but a per-key/per-user spend metric plus a threshold alert is in scope. Emit it through the existing OTEL meter (`valet.cost.usd`-style counter, tagged by key and user).
9. **Raw is source of truth; the parse is a derived, versioned layer.** Beyond usage, the recorder normalizes each request/response into a provider-agnostic `Sample` (messages, system, tools, output, params) for analysis and a future training-data pipeline. This parse is best-effort and NEVER authoritative: raw bytes are always stored, the parser is a pure function tagged with `parse_version`, and a schema improvement re-runs it over stored raw to backfill. A parse failure leaves the sample null and the raw intact. The `Sample` schema is deliberately NOT the engine's internal message model — coupling the gateway to `@valet/engine`'s parts model would drift with the engine and violate its portability boundary. It is a small, stable, own schema.

## Architecture

### 1. Ingress mount

A new router mounted at `/proxy`, separate from `/api`, because the path shapes are client-dictated and the auth model differs (key-only, no cookies).

- **Claude Code:** `ANTHROPIC_BASE_URL=http://localhost:8788/proxy/anthropic`. The harness calls `POST /proxy/anthropic/v1/messages`, and auxiliary paths such as `/proxy/anthropic/v1/messages/count_tokens` and `/proxy/anthropic/v1/models`.
- **Codex:** provider `base_url = http://localhost:8788/proxy/openai/v1`, `wire_api = "responses"`. The harness calls `POST /proxy/openai/v1/responses`, and auxiliary paths such as `/proxy/openai/v1/models`.

Every path under a prefix forwards to the real provider host (`https://api.anthropic.com`, `https://api.openai.com`). Only the completion endpoints (`/v1/messages`, `/v1/responses`) are recorded; auxiliary paths forward without a row so the harness works fully, but do not clutter the spend log.

The `/proxy` router does NOT run the `/api` auth ladder. It runs its own `resolveProxyPrincipal` first-line check.

### 2. Auth and attribution

```
resolveProxyPrincipal(c):
  key = c.req.header("x-api-key") ?? bearer(c.req.header("authorization"))
  if !key: return wireError(kind, 401, "missing API key. Create a proxy key in valet Settings.")
  result = await auth.api.verifyApiKey({ body: { key } })
  if !result.valid || !result.key: return wireError(kind, 401, "invalid API key.")
  userId = result.key.userId               // verifyApiKey returns the key record, NOT an org
  orgId  = await resolveOrgId(db, userId)   // org comes from the user row (lib/org.ts), as the auth ladder does
  return { userId, orgId, keyId: result.key.id }
```

`verifyApiKey` returns `{ valid, error, key }` (`ValetVerifyApiKeyResult`); the key record carries `userId`, not an org. The org is resolved from the user, reusing `resolveOrgId` (`packages/api/src/lib/org.ts`) — the same lookup auth-ladder rung 3/4 uses.

`wireError(kind, status, msg)` returns the provider's own error shape so the harness surfaces a clean message:
- Anthropic: `{ "type": "error", "error": { "type": "authentication_error", "message": "..." } }`
- OpenAI: `{ "error": { "message": "...", "type": "invalid_request_error", "code": "..." } }`

The corrective action is named in the message (CLAUDE.md error-message rule).

### 3. Upstream resolution

```
resolveUpstream(orgId, kind):   // kind ∈ { "anthropic", "openai" }
  row = defaultLlmProvider(orgId, kind)          // existing service
  if !row: throw NoUpstreamConfigured(kind)      // 502 wireError, names the fix
  apiKey = await credentialStore.get({ owner:{type:"org",id:orgId}, service:`llm:${row.id}` })
  return { baseUrl: row.baseUrl ?? defaultBase(kind), apiKey }
```

`defaultBase("anthropic") = "https://api.anthropic.com"`, `defaultBase("openai") = "https://api.openai.com"`.

**Env auto-provision** (`ensureEnvProviders`, called at boot after migrations): for each kind, if the env key is set and `defaultLlmProvider(orgId, kind)` is null, call the existing `createLlmProvider` + credential write with the env value and a name such as `env:anthropic`. Idempotent — a second boot finds the row and skips.

### 4. Forward and tee

```
proxyCompletion(c, kind):
  principal = resolveProxyPrincipal(c);  if error: return it
  upstream  = resolveUpstream(principal.orgId, kind);  if error: return wireError
  subpath   = stripPrefix(c.req.path, `/proxy/${kind}`)   // "/v1/messages" | "/v1/responses" | ...
  start     = performanceNow()
  reqText   = hasBody ? await c.req.text() : undefined     // buffer once: bounded JSON POST, also the recorded request
  res = await fetch(`${upstream.baseUrl}${subpath}${search}`, {
    method: c.req.method,
    headers: outboundHeaders(c.req.raw.headers, kind, upstream.apiKey), // strip hop-by-hop + valet key, swap in real key
    body: reqText,
  })
  if isRecordable(subpath) and res.body:
    [toClient, toRecorder] = res.body.tee()
    void recorder.consume(toRecorder, { principal, kind, subpath, requestBody: reqText, start, status: res.status })
    return c.body(toClient, { status, headers: sanitized(res.headers) })
  return c.body(res.body, { status, headers: sanitized(res.headers) })   // non-recorded passthrough
```

- **The request body is read once into `reqText`.** A `ReadableStream` cannot be consumed twice, so the earlier "stream the request with `duplex: half`" idea would have left the recorder with no request to store (adversarial-review finding 1). These are bounded JSON POSTs, not client-streamed uploads, so buffering the request is correct and cheap; `reqText` is both forwarded and recorded.
- **`outboundHeaders` is a strip-list, not an allowlist** (finding 4). This hop is harness→real-provider — high trust, and fidelity matters — so it forwards **every** incoming header except hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `content-encoding`, `content-length`, `host`) and the valet key header, then sets the real upstream auth (`x-api-key` for Anthropic, `Authorization: Bearer` for OpenAI). This preserves headers valet does not enumerate — `anthropic-version`, `anthropic-beta`, `openai-beta`, `x-stainless-*` — that change model behavior when dropped. (Contrast `gateway-proxy.ts`, which *allowlists* precisely because its hop crosses into a semi-trusted sandbox — the opposite trust boundary.)
- `sanitized(res.headers)` drops `content-encoding`/`transfer-encoding` (the tee returns decoded bytes) and forwards the rest so SSE framing reaches the client intact.
- The client stream is never blocked by the recorder. `tee()` applies backpressure per branch; the recorder branch drains independently.

### 5. Recorder and usage parsing

The model id is read from the request body (both APIs carry `model` in the request JSON), so a row always has a model even if the response never completes. The recorder consumes its tee branch to completion, concatenates the SSE text, and extracts usage per provider:

- **Anthropic Messages (SSE):** `message_start` carries `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. `message_delta` carries the final `usage.output_tokens`. The model id is in `message_start.message.model`.
- **OpenAI Responses (SSE):** the terminal `response.completed` event carries `response.usage` (`input_tokens`, `output_tokens`, `total_tokens`, and `input_tokens_details.cached_tokens`). The model id is in `response.model`.
- **Non-streaming JSON** (a harness may request `stream:false`): the same fields live on the single JSON body.

**Pricing — one function, not a second cost path (finding 3).** The engine does not expose a standalone `price(model, usage)`; it derives cost inside the agent loop (`thread.ts`) from pi-ai's `MessageUsage`. So this spec extracts a pure `priceUsage(model, usage): number | null` helper (in `packages/shared` or a small `packages/api/src/lib/pricing.ts`) that both the recorder and, ideally, the engine call — otherwise the gateway and the engine price the same tokens on two code paths that drift, and the "one cost definition" holds only at the view layer, not in the numbers. The helper reads the same model-catalog/pi-ai rate table.

**Responses-usage caveat (finding 3, must-verify).** pi-ai's pricing was built for Anthropic Messages and OpenAI Chat Completions; it may not map the OpenAI **Responses** usage shape (`input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`) at all. If it does not, every Codex row lands unpriced and spend management fails for exactly one of the two harnesses. The implementation MUST add a Responses→rate-table mapping (cached tokens priced at the input-cache rate) and a test asserting a non-null cost for a Codex fixture. Treat "Codex rows priced" as an acceptance criterion, not an afterthought.

If the model is unpriced (custom/unknown) or usage parsing fails, `cost_usd` is NULL — the row is still written with the raw bodies, so a later reprocess can price it (unpriced, never 0-for-free).

The recorder writes exactly one row per recorded call. A parse or DB failure is logged and swallowed — a recording failure must never break the client's stream, which has already been delivered.

#### Normalized samples (analysis + future training data)

Beyond usage, the recorder runs `parseSample(kind, requestBody, responseBody): Sample | null` and stores the result in the `parsed` column with the current `parse_version` (decision 9). The `Sample` is a small, provider-agnostic record designed for querying and export, NOT the engine's message model:

```
Sample {
  schema: "valet.llm-sample/v1"
  provider: "anthropic" | "openai"
  model: string
  params: { max_tokens?, temperature?, top_p?, stop?, reasoning_effort?, ... }   // provider params, best-effort
  system: ContentBlock[]                       // Anthropic top-level system; OpenAI system/developer input items
  tools: ToolDef[]                             // declared tool/function schemas, if any
  input: Message[]                             // prior turns as sent on the wire (may be partial for Codex — see below)
  output: Message                              // the assistant turn: text + tool_use/function_call blocks
  stop_reason: string | null
  usage: { input, output, cacheRead, cacheWrite, total }
}
Message      { role: "system"|"user"|"assistant"|"tool", content: ContentBlock[] }
ContentBlock { type: "text"|"image"|"tool_use"|"tool_result"|"reasoning", ... }   // union normalized across both wires
```

Parsing rules:
- **Streaming responses** are reassembled from the tee branch: Anthropic `content_block_delta` events concatenate into the final `output` blocks; OpenAI `response.output_*`/`response.completed` events assemble the output items. So a streamed turn produces the same `Sample` a non-streamed one would.
- **Codex partial input.** When a Codex request carries `previous_response_id`, `input` holds only the turns actually on the wire, and `Sample` records `previous_response_id` (already a column) so a later stitcher can splice the full conversation. The sample is honest about being partial rather than faking a complete transcript.
- **Best-effort, versioned, reprocessable.** `parseSample` is pure over the stored raw bodies. A parser bug or a new wire field never corrupts data — it is a `parse_version` bump and a reprocess pass over `llm_proxy_requests`. Unknown block types are preserved as `{ type: "unknown", raw }` rather than dropped, so nothing analysis might need is silently lost.

**Governance note.** The `parsed` samples are the substrate for a future training-data pipeline, but that pipeline (consent, redaction, opt-out, export) is a separate spec. This spec only produces and stores the normalized record inside valet, under the same org-scoped access control and plaintext posture as the raw bodies. No export surface ships here.

### 6. Data model

New app-schema table (`packages/api/src/schema/index.ts` Drizzle + `packages/api/migrations/pg/0000_app.sql`, edited in place per the pre-1.0 rule):

```sql
CREATE TABLE "llm_proxy_requests" (
  "id"                text PRIMARY KEY,
  "created_at"        bigint NOT NULL,          -- epoch ms, toNum convention
  "org_id"            text NOT NULL,
  "user_id"           text NOT NULL,
  "api_key_id"        text NOT NULL,
  "provider_kind"     text NOT NULL,            -- 'anthropic' | 'openai'
  "model"             text,                     -- null until parsed
  "harness"           text,                     -- 'claude-code' | 'codex' | 'unknown' (from user-agent)
  "endpoint"          text NOT NULL,            -- '/v1/messages' | '/v1/responses'
  "provider_response_id" text,                  -- OpenAI Responses id / Anthropic message id (from the response)
  "previous_response_id" text,                  -- Codex chaining pointer (from the request), null otherwise
  "stream"            boolean NOT NULL,
  "status_code"       integer NOT NULL,
  "request_body"      text NOT NULL,            -- plaintext, engine-prompt posture
  "response_body"     text,                     -- accumulated SSE or JSON; null on upstream error
  "input_tokens"      bigint NOT NULL DEFAULT 0,
  "output_tokens"     bigint NOT NULL DEFAULT 0,
  "cache_read_tokens" bigint NOT NULL DEFAULT 0,
  "cache_write_tokens" bigint NOT NULL DEFAULT 0,
  "total_tokens"      bigint NOT NULL DEFAULT 0,
  "cost_usd"          double precision,         -- NULL = unpriced, never 0-for-free
  "latency_ms"        integer,
  "error"            text,
  "parsed"            jsonb,                     -- normalized Sample (decision 9); NULL if parse failed/pending
  "parse_version"     integer,                   -- parser version that produced `parsed`; drives reprocessing
  "parse_error"       text
);
CREATE INDEX "llm_proxy_requests_org_created" ON "llm_proxy_requests" ("org_id", "created_at");
CREATE INDEX "llm_proxy_requests_user_created" ON "llm_proxy_requests" ("user_id", "created_at");
```

**`cost_entries` extension.** Append a `UNION ALL` that maps proxy rows into the view's existing columns, so the one cost definition covers proxy spend:

```sql
UNION ALL
SELECT
  p."id" AS entry_id, NULL AS session_id, p."created_at", p."model",
  p."org_id", p."user_id", 'user' AS owner_type, p."user_id" AS owner_id,
  NULL AS workflow_id, NULL AS workflow_run_id,
  p."input_tokens", p."output_tokens", p."cache_read_tokens", p."cache_write_tokens", p."total_tokens",
  p."cost_usd" AS cost_total, (p."cost_usd" IS NOT NULL) AS priced
FROM "llm_proxy_requests" p
WHERE p."org_id" IS NOT NULL;
```

`/api/usage/summary` and any Grafana panel then include proxy spend with no code change.

### 7. API surface

New router `/api/proxy`, mounted under the normal `/api` auth ladder (cookie/session identity). Members see their own rows; org-admins see the whole org.

- `GET /api/proxy/usage/summary?window=...` — time-series buckets plus breakdowns by user, model, and harness. Reads `llm_proxy_requests` with a raw aggregate, same pattern as `routes/usage.ts`.
- `GET /api/proxy/requests?user=&model=&harness=&from=&to=&cursor=` — filtered, paginated list (metadata columns, no bodies).
- `GET /api/proxy/requests/:id` — one row with full request and response bodies for drill-down. Ownership-gated: a member reads only their own row; an admin reads any row in the org; a row in another org 404s.
- `POST /api/proxy/keys` / `GET /api/proxy/keys` / `DELETE /api/proxy/keys/:id` — issue, list, and revoke `vlt_` proxy keys, wrapping the existing `apiKey` plugin. Reused by the onboarding panel.

### 8. Dashboard (web)

New route in `packages/web/src/routes/` (proposed `usage.tsx`, or a tab under settings), TanStack Query against the endpoints above:

- **Time-series** — spend (USD) and tokens over the selected window, stacked by model.
- **Breakdown tables** — by user (admin view), by model, and by harness; each row shows requests, tokens, and cost.
- **Request log** — a paginated table with filters (user, model, harness, date range); each row links to drill-down.
- **Drill-down** — renders the normalized `Sample` (`parsed`) with the existing session message-rendering components: system, tools, input turns, and the assistant output as readable message blocks. Falls back to raw request/response JSON when `parsed` is null (parse failed or pending reprocess). The raw bodies stay available behind a "view raw" toggle.

### 9. Onboarding panel

A settings panel that issues a proxy key and shows copy-paste setup:

- **Claude Code:**
  ```
  export ANTHROPIC_BASE_URL=https://<valet-host>/proxy/anthropic
  export ANTHROPIC_AUTH_TOKEN=vlt_<key>
  ```
- **Codex** (`~/.codex/config.toml`):
  ```toml
  model_provider = "valet"
  [model_providers.valet]
  name = "valet"
  base_url = "https://<valet-host>/proxy/openai/v1"
  env_key = "VALET_KEY"
  wire_api = "responses"
  ```
  plus `export VALET_KEY=vlt_<key>`.

## Error handling

- **Missing/invalid proxy key** → wire-correct 401 with the corrective action ("Create a proxy key in valet Settings").
- **No upstream configured** (no provider row and no env key) → wire-correct 502 naming the fix ("Configure an Anthropic provider in valet Settings").
- **Upstream error** (4xx/5xx from the real provider) → forwarded verbatim to the client; a row is still recorded with `status_code` and `error`, `response_body` set to the error payload.
- **Recorder failure** (parse or DB) → logged and swallowed; the client stream is unaffected.
- **Client disconnect mid-stream** → the recorder branch still drains to whatever arrived; the row records partial usage if the terminal usage event never came (`cost_usd` NULL).

## Security and privacy

- The real upstream key never leaves valet. The `vlt_` key on the laptop grants only proxied inference scoped to the user's org.
- Full prompt and completion bodies are stored plaintext, the same posture as engine prompts (decision 5). Access is ownership-gated: members read only their own rows.
- The `/proxy` router forwards to a fixed allowlist of provider hosts (`api.anthropic.com`, `api.openai.com`) — it is not an open forward-proxy. The subpath is validated to reject `..` segments, matching `gateway-proxy.ts`.
- Retention is out of MVP scope and matches engine-prompt retention (none automatic today). A retention sweep is a later addition; the schema carries `created_at` to support one.

## Operational risk (finding 6)

The gateway puts valet in the inference hot path for every engineer's local Claude Code and Codex. If the api is down, restarting, or mid-deploy, those harnesses stop working until valet returns — a laptop-blocking dependency valet did not have before. This is a deliberate cost of the design, accepted because full-body recording and key centralization require it (OTEL-only telemetry, the fail-safe alternative, cannot capture bodies or hold keys). Two consequences for implementation:

- The gateway must not fail closed silently. On any upstream or internal error it returns a wire-correct error the harness can display, never a hang.
- The gateway shares the api process, so a spike in proxied traffic competes with valet's own request handling. At team scale this is fine; a dedicated process/replica is a scaling follow-up, noted so it is a known lever, not a surprise.

## Testing

- **Principal resolution** — both header forms (`x-api-key`, `Authorization: Bearer`), missing key, invalid key; assert wire-correct error shapes per kind.
- **Upstream resolution + auto-provision** — env key present seeds a provider; a second call is idempotent; a configured row wins over env.
- **Usage parser** — fixture SSE streams for Anthropic (`message_start` + `message_delta`) and OpenAI Responses (`response.completed`), plus non-streaming JSON; assert the actual token numbers are reachable (not just "defined" — the tool-call-persistence lesson: assert real values).
- **Pricing** — `priceUsage(model, usage)` returns a non-null cost for a real Anthropic model AND a real OpenAI Responses fixture (finding 3 acceptance: Codex rows must price, including cached-token discount); unknown model returns null.
- **Header fidelity** — `outboundHeaders` forwards `anthropic-version`/`anthropic-beta`/`x-stainless-*` unchanged, drops the valet key and hop-by-hop headers, and sets the real upstream auth (finding 4).
- **Recorder integration** — a fake upstream serving a canned SSE stream; drive `proxyCompletion` and assert one `llm_proxy_requests` row with the recorded **request body** (finding 1), correct usage, cost, latency, `provider_response_id`, full response body, and a non-null `parsed` sample; assert the client received the identical stream bytes.
- **Sample parser** — `parseSample` fixtures for both wires: a plain text turn, a tool-use/function-call turn, an image input, and a streamed response reassembled to the same `Sample` as its non-streamed twin. Assert `system`, `tools`, `input`, and `output` blocks are populated; assert an unknown block type is preserved as `{type:"unknown"}` not dropped; assert a Codex request with `previous_response_id` yields a partial `input` plus the recorded pointer.
- **cost_entries union** — insert a proxy row; assert `/api/usage/summary` includes its cost.
- **API authorization** — a member cannot read another member's drill-down; an admin can; a cross-org row 404s.

**Success-criteria validation (manual):** point local Claude Code (`ANTHROPIC_BASE_URL` + `vlt_` key) and Codex (`config.toml` provider) at the dev stack. Run a prompt in each. Confirm each produces streamed output identical to going direct, a `llm_proxy_requests` row lands with correct usage, and the dashboard reflects the spend under the acting user. Then run `make e2e` for a clean scorecard.

## Build sequence

1. Schema: `llm_proxy_requests` table (incl. `provider_response_id`/`previous_response_id`) + `cost_entries` UNION (edit migrations in place; `rm -rf ~/.valet/pg`), Drizzle schema. App schema only — the engine store does not read it.
2. `priceUsage(model, usage)` helper extracted as one shared function, with the Anthropic + OpenAI-Responses pricing tests (finding 3).
3. Upstream resolution + `ensureEnvProviders` boot step, with tests.
4. `resolveProxyPrincipal` (org via `resolveOrgId`) + `wireError`, with tests.
5. Forward (request buffered once) + strip-list `outboundHeaders` + tee + recorder + usage parser, with the fake-upstream integration test.
6. `parseSample` (both wires, streaming reassembly, tool/image/unknown blocks) writing `parsed`/`parse_version`, with the parser fixtures.
7. `/proxy` router mount for both kinds; wire into `app.ts`.
8. Per-key spend metric + alert through the OTEL meter (decision 8).
9. `/api/proxy/*` endpoints, with authorization tests.
10. Web dashboard (Sample drill-down) + onboarding panel.
11. Manual success-criteria run + `make e2e`.

## Out of scope

- Hard budget caps, rate limits, and per-key quotas. A per-key/user spend metric + alert IS in scope (decision 8); enforced ceilings that block requests are the deferred part, and fit "alert, don't auto-repair" poorly.
- Conversation stitching across Codex `previous_response_id` chains (decision 7).
- Google/OpenRouter and other provider kinds (the mount is per-kind; adding one is a follow-up).
- Retention/TTL automation (schema supports it; the sweep is later).
- A pricing backfill job for rows recorded while unpriced.
- The training-data pipeline itself — consent, redaction/PII handling, opt-out, and any export surface. This spec produces the normalized `parsed` samples in-place under org-scoped access; turning them into a training corpus is a separate spec with its own governance (decision 9 governance note).
- A conversation-stitcher that reconstructs full transcripts from `previous_response_id` chains (the ids are stored; the join is later).
