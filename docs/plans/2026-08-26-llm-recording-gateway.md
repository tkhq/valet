# LLM Recording Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a transparent recording gateway in `packages/api` that lets local Claude Code and Codex point their base URL at valet, authenticate with a per-user `vlt_` key, and have every call forwarded to the real provider, recorded (raw + normalized), attributed to a user, and shown on a spend dashboard.

**Architecture:** A new `/proxy/*` Hono router forwards requests verbatim to `api.anthropic.com` / `api.openai.com`, swapping a valet key for the org's real upstream key. The upstream response is `tee()`'d — one branch streams to the client unbuffered, the other feeds a recorder that parses usage, prices it with pi-ai's `calculateCost`, normalizes the bodies into a provider-agnostic `Sample`, and writes one `llm_proxy_requests` row. A `cost_entries` view UNION folds proxy spend into the existing usage aggregates. A `/api/proxy/*` router + web dashboard surface it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Hono, Drizzle (Postgres/PGlite), `@mariozechner/pi-ai` (`getModel`, `calculateCost`, `getEnvApiKey`), better-auth `apiKey` plugin, Vitest, Vite + React 19 + TanStack Router/Query.

**Spec:** `docs/specs/2026-08-26-llm-proxy-mitm-design.md` — read it alongside this plan.

## Global Constraints

- **Node 22** for tests (`nvm use 22`) — anything importing `ws`/`WebSocket` fails under Node 20.
- **Type safety (CLAUDE.md):** no `any`, no `as unknown as T`, no `@ts-ignore`. Use real types or `Record<string, unknown>` + narrowing. Leave every edited file cleaner than found.
- **Pre-1.0 migrations edited in place:** edit `packages/api/migrations/pg/0000_app.sql` and `packages/api/src/schema/index.ts` directly — NO numbered migrations. After editing either, `rm -rf ~/.valet/pg` is MANDATORY (the migration tracker skips an already-applied `0000`).
- **bigint ms columns** use Drizzle `bigint(col, { mode: "number" })`; timestamps are epoch-ms numbers.
- **Import specifiers end in `.js`** even for `.ts` sources (ESM/NodeNext).
- **Test filters take NO `--`** before them: `pnpm --filter @valet/api test <filter>`.
- **Validation before done:** `pnpm typecheck` clean, then `make e2e` with a clean scorecard.
- **No AI co-author trailers** in commits. Subjects ≤72 chars. Base branch: `dev-v2`. Work branch: `feat/llm-proxy-mitm-spec` (spec already committed there).
- **Terminology:** call it the "recording gateway", not MITM. `startRef` in code, "start-ref" in prose (not relevant here, but the one-name-per-thing rule is).

---

## File Structure

**Create (api):**
- `packages/api/src/lib/pricing.ts` — `priceUsage(kind, modelId, usage)` over pi-ai.
- `packages/api/src/proxy/upstream.ts` — `resolveUpstream`, `ensureEnvProviders`.
- `packages/api/src/proxy/principal.ts` — `resolveProxyPrincipal`, `wireError`.
- `packages/api/src/proxy/usage-parser.ts` — `parseUsage` (SSE + JSON → usage/model/response-id).
- `packages/api/src/proxy/sample.ts` — `parseSample`, `Sample` types, `PARSE_VERSION`.
- `packages/api/src/proxy/recorder.ts` — `recordProxyCall`, `insertProxyRequest`.
- `packages/api/src/proxy/metrics.ts` — proxy spend OTEL counter.
- `packages/api/src/routes/proxy-gateway.ts` — the `/proxy/*` forwarding router.
- `packages/api/src/routes/proxy-usage.ts` — the `/api/proxy/*` read API.
- Tests colocated: `*.test.ts` beside each.

**Modify (api):**
- `packages/api/src/schema/index.ts` — add `llmProxyRequests` table.
- `packages/api/migrations/pg/0000_app.sql` — add table + extend `cost_entries` view.
- `packages/api/src/app.ts` — mount both routers.
- `packages/api/src/main.ts` — call `ensureEnvProviders` at boot.

**Create (web):**
- `packages/web/src/routes/usage.tsx` — dashboard route.
- `packages/web/src/components/usage/` — `SpendChart.tsx`, `BreakdownTable.tsx`, `RequestLog.tsx`, `SampleView.tsx`.

**Interfaces used across tasks (define once, reuse verbatim):**

```ts
// packages/api/src/proxy/types.ts  (create in Task 3, imported everywhere)
export type ProviderKind = "anthropic" | "openai";
export interface ProxyUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; total: number;
}
export interface ParsedUsage {
  usage: ProxyUsage; model: string | null; providerResponseId: string | null;
}
export interface ProxyPrincipal { userId: string; orgId: string; keyId: string; }
export interface Upstream { baseUrl: string; apiKey: string; }
```

---

## Task 1: `llm_proxy_requests` schema + `cost_entries` UNION

**Files:**
- Modify: `packages/api/src/schema/index.ts` (add table after `llmProviders`)
- Modify: `packages/api/migrations/pg/0000_app.sql` (add table; extend view at line ~938)
- Test: `packages/api/src/schema/proxy-requests.test.ts`

**Interfaces:**
- Produces: Drizzle `llmProxyRequests` table; type `LlmProxyRequestRow = typeof llmProxyRequests.$inferSelect`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/schema/proxy-requests.test.ts
import { describe, it, expect } from "vitest";
import { llmProxyRequests } from "./index.js";

describe("llmProxyRequests schema", () => {
  it("has the columns the recorder writes", () => {
    const cols = Object.keys(llmProxyRequests);
    for (const c of [
      "id", "createdAt", "orgId", "userId", "apiKeyId", "providerKind", "model",
      "harness", "endpoint", "providerResponseId", "previousResponseId", "stream",
      "statusCode", "requestBody", "responseBody", "inputTokens", "outputTokens",
      "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd", "latencyMs",
      "error", "parsed", "parseVersion", "parseError",
    ]) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test proxy-requests`
Expected: FAIL — `llmProxyRequests` is not exported.

- [ ] **Step 3: Add the Drizzle table**

In `packages/api/src/schema/index.ts`, after the `llmProviders` block, add (match its style — `text`, `bigint({mode:"number"})`, `jsonb`, `index`):

```ts
export const llmProxyRequests = pgTable(
  "llm_proxy_requests",
  {
    id: text("id").primaryKey(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    apiKeyId: text("api_key_id").notNull(),
    providerKind: text("provider_kind", { enum: ["anthropic", "openai"] }).notNull(),
    model: text("model"),
    harness: text("harness"),
    endpoint: text("endpoint").notNull(),
    providerResponseId: text("provider_response_id"),
    previousResponseId: text("previous_response_id"),
    stream: boolean("stream").notNull(),
    statusCode: integer("status_code").notNull(),
    requestBody: text("request_body").notNull(),
    responseBody: text("response_body"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    parsed: jsonb("parsed"),
    parseVersion: integer("parse_version"),
    parseError: text("parse_error"),
  },
  (t) => [index("llm_proxy_requests_org_created").on(t.orgId, t.createdAt),
          index("llm_proxy_requests_user_created").on(t.userId, t.createdAt)],
);

export type LlmProxyRequestRow = typeof llmProxyRequests.$inferSelect;
```

Ensure `integer` and `doublePrecision` are imported from `drizzle-orm/pg-core` at the top of the file (add to the existing import list if absent).

- [ ] **Step 4: Add the raw SQL table + extend the view**

In `packages/api/migrations/pg/0000_app.sql`, before the `cost_entries` view (line ~905), add:

```sql
CREATE TABLE "llm_proxy_requests" (
  "id"                text PRIMARY KEY,
  "created_at"        bigint NOT NULL,
  "org_id"            text NOT NULL,
  "user_id"           text NOT NULL,
  "api_key_id"        text NOT NULL,
  "provider_kind"     text NOT NULL,
  "model"             text,
  "harness"           text,
  "endpoint"          text NOT NULL,
  "provider_response_id" text,
  "previous_response_id" text,
  "stream"            boolean NOT NULL,
  "status_code"       integer NOT NULL,
  "request_body"      text NOT NULL,
  "response_body"     text,
  "input_tokens"      bigint NOT NULL DEFAULT 0,
  "output_tokens"     bigint NOT NULL DEFAULT 0,
  "cache_read_tokens" bigint NOT NULL DEFAULT 0,
  "cache_write_tokens" bigint NOT NULL DEFAULT 0,
  "total_tokens"      bigint NOT NULL DEFAULT 0,
  "cost_usd"          double precision,
  "latency_ms"        integer,
  "error"             text,
  "parsed"            jsonb,
  "parse_version"     integer,
  "parse_error"       text
);
CREATE INDEX "llm_proxy_requests_org_created" ON "llm_proxy_requests" ("org_id", "created_at");
CREATE INDEX "llm_proxy_requests_user_created" ON "llm_proxy_requests" ("user_id", "created_at");
```

Then, at the END of the `CREATE VIEW "cost_entries" AS ...` statement (after its closing `WHERE ... IS NOT NULL;`), replace the terminating `;` with a `UNION ALL` block:

```sql
UNION ALL
SELECT
  p."id" AS "entry_id", NULL AS "session_id", p."created_at" AS "created_at", p."model" AS "model",
  p."org_id" AS "org_id", p."user_id" AS "user_id", 'user' AS "owner_type", p."user_id" AS "owner_id",
  NULL AS "workflow_id", NULL AS "workflow_run_id",
  p."input_tokens", p."output_tokens", p."cache_read_tokens", p."cache_write_tokens", p."total_tokens",
  p."cost_usd" AS "cost_total", (p."cost_usd" IS NOT NULL) AS "priced"
FROM "llm_proxy_requests" p;
```

- [ ] **Step 5: Reset the dev DB and run the test**

```bash
rm -rf ~/.valet/pg
nvm use 22
pnpm --filter @valet/api test proxy-requests
```
Expected: PASS.

- [ ] **Step 6: Verify the view still builds**

Run: `pnpm --filter @valet/store-postgres test` and `pnpm --filter @valet/api test cost-entries-view`
Expected: PASS (the UNION is column-compatible with the base view).

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/schema/index.ts packages/api/migrations/pg/0000_app.sql packages/api/src/schema/proxy-requests.test.ts
git commit -m "feat(api): add llm_proxy_requests table + cost_entries union"
```

---

## Task 2: `priceUsage` — reuse pi-ai's cost table

**Files:**
- Create: `packages/api/src/proxy/types.ts` (the shared interfaces above)
- Create: `packages/api/src/lib/pricing.ts`
- Test: `packages/api/src/lib/pricing.test.ts`

**Interfaces:**
- Consumes: `ProviderKind`, `ProxyUsage` from `proxy/types.js`.
- Produces: `priceUsage(kind: ProviderKind, modelId: string, usage: ProxyUsage): number | null`.

- [ ] **Step 1: Create the shared types file**

Create `packages/api/src/proxy/types.ts` with exactly the interfaces from the File Structure section (`ProviderKind`, `ProxyUsage`, `ParsedUsage`, `ProxyPrincipal`, `Upstream`).

- [ ] **Step 2: Write the failing test**

```ts
// packages/api/src/lib/pricing.test.ts
import { describe, it, expect } from "vitest";
import { priceUsage } from "./pricing.js";

const usage = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 };

describe("priceUsage", () => {
  it("prices a known Anthropic model to a positive number", () => {
    const cost = priceUsage("anthropic", "claude-sonnet-4-5-20250929", usage);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
  it("prices a known OpenAI model to a positive number", () => {
    const cost = priceUsage("openai", "gpt-5", usage);
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
  it("returns null for an unknown model (unpriced, not zero)", () => {
    expect(priceUsage("openai", "totally-made-up-model", usage)).toBeNull();
  });
});
```

Note for implementer: the exact model ids above must exist in the installed pi-ai `MODELS` registry. Before writing the impl, confirm the ids: `node -e "const {getModels}=require('@mariozechner/pi-ai'); console.log(getModels('anthropic').map(m=>m.id).slice(0,5)); console.log(getModels('openai').map(m=>m.id).slice(0,5))"` — swap the test ids for real ones from that output if these drift.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @valet/api test pricing`
Expected: FAIL — `priceUsage` not defined.

- [ ] **Step 4: Implement over pi-ai**

```ts
// packages/api/src/lib/pricing.ts
import { getModel, calculateCost } from "@mariozechner/pi-ai";
import type { ProviderKind, ProxyUsage } from "../proxy/types.js";

/** pi-ai provider key for our two proxy kinds. Codex talks the Responses
 * API but its models live under the "openai" provider in pi-ai's registry. */
function piProvider(kind: ProviderKind): "anthropic" | "openai" {
  return kind;
}

/**
 * Prices a proxied turn using the SAME table the engine's cost comes from
 * (pi-ai `calculateCost`). Returns null — UNPRICED, never 0 — when the model
 * is not in pi-ai's registry, so the caller stores NULL and a later
 * reprocess can price it. See spec finding 3.
 */
export function priceUsage(kind: ProviderKind, modelId: string, usage: ProxyUsage): number | null {
  let model;
  try {
    // getModel is generically typed on literal ids; at runtime it indexes
    // MODELS[provider][id]. Cast the id to the index type — a genuine
    // third-party-typing narrowing (CLAUDE.md rule 3), commented here.
    model = getModel(piProvider(kind), modelId as never);
  } catch {
    return null;
  }
  if (!model) return null;
  const cost = calculateCost(model, {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  return cost.total > 0 ? cost.total : null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @valet/api test pricing`
Expected: PASS. If the Anthropic/OpenAI ids failed, replace them with real ids from the Step 2 `node -e` probe and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/proxy/types.ts packages/api/src/lib/pricing.ts packages/api/src/lib/pricing.test.ts
git commit -m "feat(api): priceUsage over pi-ai calculateCost"
```

---

## Task 3: `resolveUpstream` + `ensureEnvProviders`

**Files:**
- Create: `packages/api/src/proxy/upstream.ts`
- Test: `packages/api/src/proxy/upstream.test.ts`

**Interfaces:**
- Consumes: `ProviderKind`, `Upstream`; `CredentialStore` (`packages/api/src/providers/types.ts`), `AppDb`.
- Produces:
  - `resolveUpstream(db, credentials, orgId, kind): Promise<Upstream | null>`
  - `ensureEnvProviders(db, credentials, orgId): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/proxy/upstream.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveUpstream } from "./upstream.js";

function fakeCreds(map: Record<string, { apiKey: string }>) {
  return { get: vi.fn(async (_o: unknown, svc: string) => map[svc] ?? undefined) };
}

describe("resolveUpstream", () => {
  it("uses the org provider credential when present", async () => {
    const db = { /* not read on this path */ } as never;
    const listProviders = vi.fn(async () => [{ id: "p1", kind: "anthropic", baseUrl: null }]);
    const creds = fakeCreds({ "llm:p1": { apiKey: "sk-real" } });
    const up = await resolveUpstream(db, creds as never, "org1", "anthropic", { listProviders, envKey: () => undefined });
    expect(up).toEqual({ baseUrl: "https://api.anthropic.com", apiKey: "sk-real" });
  });
  it("falls back to the env key when no provider row exists", async () => {
    const creds = fakeCreds({});
    const up = await resolveUpstream({} as never, creds as never, "org1", "openai",
      { listProviders: async () => [], envKey: (k) => (k === "openai" ? "sk-env" : undefined) });
    expect(up).toEqual({ baseUrl: "https://api.openai.com", apiKey: "sk-env" });
  });
  it("returns null when neither provider nor env key exists", async () => {
    const creds = fakeCreds({});
    const up = await resolveUpstream({} as never, creds as never, "org1", "openai",
      { listProviders: async () => [], envKey: () => undefined });
    expect(up).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test proxy/upstream`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/api/src/proxy/upstream.ts
import { getEnvApiKey } from "@mariozechner/pi-ai";
import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import type { ProviderKind, Upstream } from "./types.js";
import { listLlmProviders, createLlmProvider } from "../services/llm-providers.js";

const DEFAULT_BASE: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/** Seam for tests: real deps read the db + env; tests inject fakes. */
export interface UpstreamDeps {
  listProviders: (kind: ProviderKind) => Promise<Array<{ id: string; kind: string; baseUrl: string | null }>>;
  envKey: (kind: ProviderKind) => string | undefined;
}

function defaultDeps(db: AppDb, orgId: string): UpstreamDeps {
  return {
    listProviders: async (kind) =>
      (await listLlmProviders(db, orgId)).filter((r) => r.kind === kind && r.enabled),
    envKey: (kind) => getEnvApiKey(kind),
  };
}

/**
 * Resolves the real upstream for a provider kind: the org's first enabled
 * provider row of that kind (key from CredentialStore `llm:{id}`), else the
 * process env key (dev). Returns null when neither exists — the caller then
 * returns a wire-correct 502 naming the fix.
 */
export async function resolveUpstream(
  db: AppDb, credentials: CredentialStore, orgId: string, kind: ProviderKind,
  deps: UpstreamDeps = defaultDeps(db, orgId),
): Promise<Upstream | null> {
  const rows = await deps.listProviders(kind);
  const owner = { type: "org" as const, id: orgId };
  for (const row of rows) {
    const stored = await credentials.get(owner, `llm:${row.id}`);
    if (stored?.apiKey) return { baseUrl: row.baseUrl || DEFAULT_BASE[kind], apiKey: stored.apiKey };
  }
  const env = deps.envKey(kind);
  return env ? { baseUrl: DEFAULT_BASE[kind], apiKey: env } : null;
}

/**
 * Boot step: for each kind, if the env key is set and the org has no
 * provider of that kind, seed one (name `env:{kind}`) with the env key in
 * CredentialStore, so the Settings UI shows a provider and the demo works
 * with zero setup. Idempotent.
 */
export async function ensureEnvProviders(db: AppDb, credentials: CredentialStore, orgId: string): Promise<void> {
  for (const kind of ["anthropic", "openai"] as const) {
    const env = getEnvApiKey(kind);
    if (!env) continue;
    const existing = (await listLlmProviders(db, orgId)).filter((r) => r.kind === kind);
    if (existing.length > 0) continue;
    const row = await createLlmProvider(db, { orgId, kind, name: `env:${kind}` });
    await credentials.set({ type: "org", id: orgId }, `llm:${row.id}`, { apiKey: env });
  }
}
```

Note: confirm `createLlmProvider`'s exact options shape and `credentials.set`'s signature against `services/llm-providers.ts` and the `CredentialStore` interface; adjust the two calls in `ensureEnvProviders` to match (the resolve path is what the tests cover).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @valet/api test proxy/upstream`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proxy/upstream.ts packages/api/src/proxy/upstream.test.ts
git commit -m "feat(api): resolveUpstream + ensureEnvProviders"
```

---

## Task 4: `resolveProxyPrincipal` + `wireError`

**Files:**
- Create: `packages/api/src/proxy/principal.ts`
- Test: `packages/api/src/proxy/principal.test.ts`

**Interfaces:**
- Consumes: `ProviderKind`, `ProxyPrincipal`; `ValetAuth` (`auth/index.ts`), `AppDb`.
- Produces:
  - `wireError(kind: ProviderKind, status: number, message: string): Response`
  - `resolveProxyPrincipal(headers: Headers, deps): Promise<ProxyPrincipal | Response>`
    where `deps = { verifyApiKey, userOrg }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/proxy/principal.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveProxyPrincipal, wireError } from "./principal.js";

const ok = {
  verifyApiKey: vi.fn(async ({ key }: { key: string }) =>
    key === "vlt_good" ? { valid: true, key: { id: "k1", userId: "u1" } } : { valid: false, key: null }),
  userOrg: vi.fn(async (userId: string) => (userId === "u1" ? "org1" : null)),
};

describe("resolveProxyPrincipal", () => {
  it("resolves from x-api-key", async () => {
    const h = new Headers({ "x-api-key": "vlt_good" });
    const r = await resolveProxyPrincipal(h, "anthropic", ok);
    expect(r).toEqual({ userId: "u1", orgId: "org1", keyId: "k1" });
  });
  it("resolves from Authorization: Bearer", async () => {
    const h = new Headers({ authorization: "Bearer vlt_good" });
    const r = await resolveProxyPrincipal(h, "openai", ok);
    expect(r).toEqual({ userId: "u1", orgId: "org1", keyId: "k1" });
  });
  it("returns a 401 anthropic-shaped body for a missing key", async () => {
    const r = await resolveProxyPrincipal(new Headers(), "anthropic", ok);
    expect(r).toBeInstanceOf(Response);
    const res = r as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });
  it("returns a 401 openai-shaped body for an invalid key", async () => {
    const h = new Headers({ authorization: "Bearer nope" });
    const r = await resolveProxyPrincipal(h, "openai", ok);
    const res = r as Response;
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } });
  });
});

describe("wireError", () => {
  it("names a corrective action in the message", async () => {
    const res = wireError("anthropic", 502, "Configure an Anthropic provider in valet Settings.");
    expect((await res.json()).error.message).toMatch(/Settings/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test proxy/principal`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/api/src/proxy/principal.ts
import type { ProviderKind, ProxyPrincipal } from "./types.js";

export function wireError(kind: ProviderKind, status: number, message: string): Response {
  const body = kind === "anthropic"
    ? { type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }
    : { error: { message, type: status === 401 ? "invalid_request_error" : "api_error", code: null } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function extractKey(headers: Headers): string | undefined {
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}

export interface PrincipalDeps {
  verifyApiKey: (opts: { key: string }) => Promise<{ valid: boolean; key: { id: string; userId: string } | null }>;
  userOrg: (userId: string) => Promise<string | null>;
}

/**
 * Resolves a `vlt_` key (from `x-api-key` OR `Authorization: Bearer`) to a
 * principal. The org comes from the user row — verifyApiKey returns the key
 * record (userId), NOT an org (spec finding 2). Returns a wire-correct 401
 * Response on any failure so the harness shows a clean message.
 */
export async function resolveProxyPrincipal(
  headers: Headers, kind: ProviderKind, deps: PrincipalDeps,
): Promise<ProxyPrincipal | Response> {
  const key = extractKey(headers);
  if (!key) return wireError(kind, 401, "Missing API key. Create a proxy key in valet Settings.");
  const result = await deps.verifyApiKey({ key });
  if (!result.valid || !result.key) return wireError(kind, 401, "Invalid API key. Create a proxy key in valet Settings.");
  const orgId = await deps.userOrg(result.key.userId);
  if (!orgId) return wireError(kind, 401, "API key is not linked to an organization.");
  return { userId: result.key.userId, orgId, keyId: result.key.id };
}
```

The `userOrg` dep, wired in Task 8, reads the `users` table (`orgId` column) via `db`; fall back to `resolveOrgId(db)` (single-org) when the row has no org.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @valet/api test proxy/principal`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proxy/principal.ts packages/api/src/proxy/principal.test.ts
git commit -m "feat(api): resolveProxyPrincipal + wire-correct errors"
```

---

## Task 5: `parseUsage` — SSE + JSON usage extraction

**Files:**
- Create: `packages/api/src/proxy/usage-parser.ts`
- Test: `packages/api/src/proxy/usage-parser.test.ts`
- Fixtures: `packages/api/src/proxy/fixtures/` (anthropic-stream.txt, openai-responses-stream.txt)

**Interfaces:**
- Consumes: `ProviderKind`, `ParsedUsage`.
- Produces: `parseUsage(kind: ProviderKind, responseText: string): ParsedUsage | null`.

- [ ] **Step 1: Create fixtures**

Create `packages/api/src/proxy/fixtures/anthropic-stream.txt` — a minimal real Anthropic Messages SSE capture:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_01ABC","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1200,"cache_creation_input_tokens":40,"cache_read_input_tokens":10,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":350}}

event: message_stop
data: {"type":"message_stop"}
```

Create `packages/api/src/proxy/fixtures/openai-responses-stream.txt`:

```
event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"Hi"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_01XYZ","model":"gpt-5","usage":{"input_tokens":900,"output_tokens":220,"total_tokens":1120,"input_tokens_details":{"cached_tokens":30}}}}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/api/src/proxy/usage-parser.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUsage } from "./usage-parser.js";

const fx = (n: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url)), "utf8");

describe("parseUsage", () => {
  it("extracts Anthropic usage, model, and message id", () => {
    const r = parseUsage("anthropic", fx("anthropic-stream.txt"));
    expect(r).not.toBeNull();
    expect(r!.model).toBe("claude-sonnet-4-5-20250929");
    expect(r!.providerResponseId).toBe("msg_01ABC");
    expect(r!.usage).toEqual({ input: 1200, output: 350, cacheRead: 10, cacheWrite: 40, total: 1600 });
  });
  it("extracts OpenAI Responses usage, model, and response id", () => {
    const r = parseUsage("openai", fx("openai-responses-stream.txt"));
    expect(r).not.toBeNull();
    expect(r!.model).toBe("gpt-5");
    expect(r!.providerResponseId).toBe("resp_01XYZ");
    expect(r!.usage).toEqual({ input: 900, output: 220, cacheRead: 30, cacheWrite: 0, total: 1120 });
  });
  it("returns null when no usage is present", () => {
    expect(parseUsage("anthropic", "event: ping\ndata: {}\n")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @valet/api test usage-parser`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// packages/api/src/proxy/usage-parser.ts
import type { ProviderKind, ParsedUsage, ProxyUsage } from "./types.js";

/** Parse SSE `data:` payloads (and a bare JSON body) into JSON objects. */
function dataObjects(text: string): Record<string, unknown>[] {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try { return [JSON.parse(trimmed) as Record<string, unknown>]; } catch { return []; }
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const s = line.trimStart();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { out.push(JSON.parse(payload) as Record<string, unknown>); } catch { /* skip partial */ }
  }
  return out;
}

function num(v: unknown): number { return typeof v === "number" ? v : 0; }

export function parseUsage(kind: ProviderKind, responseText: string): ParsedUsage | null {
  const events = dataObjects(responseText);
  const usage: ProxyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let model: string | null = null;
  let providerResponseId: string | null = null;
  let sawUsage = false;

  if (kind === "anthropic") {
    for (const e of events) {
      if (e.type === "message_start") {
        const msg = e.message as Record<string, unknown> | undefined;
        if (msg) {
          model = (msg.model as string) ?? model;
          providerResponseId = (msg.id as string) ?? providerResponseId;
          const u = msg.usage as Record<string, unknown> | undefined;
          if (u) { usage.input = num(u.input_tokens); usage.cacheWrite = num(u.cache_creation_input_tokens); usage.cacheRead = num(u.cache_read_input_tokens); sawUsage = true; }
        }
      } else if (e.type === "message_delta") {
        const u = e.usage as Record<string, unknown> | undefined;
        if (u) { usage.output = num(u.output_tokens); sawUsage = true; }
      }
    }
  } else {
    for (const e of events) {
      const resp = (e.response ?? (e.type === "response" ? e : undefined)) as Record<string, unknown> | undefined;
      if (resp && (e.type === "response.completed" || resp.usage)) {
        model = (resp.model as string) ?? model;
        providerResponseId = (resp.id as string) ?? providerResponseId;
        const u = resp.usage as Record<string, unknown> | undefined;
        if (u) {
          usage.input = num(u.input_tokens); usage.output = num(u.output_tokens);
          const details = u.input_tokens_details as Record<string, unknown> | undefined;
          usage.cacheRead = num(details?.cached_tokens);
          sawUsage = true;
        }
      }
    }
  }
  if (!sawUsage) return null;
  usage.total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return { usage, model, providerResponseId };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @valet/api test usage-parser`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/proxy/usage-parser.ts packages/api/src/proxy/usage-parser.test.ts packages/api/src/proxy/fixtures
git commit -m "feat(api): parseUsage for Anthropic + OpenAI Responses"
```

---

## Task 6: `parseSample` — normalized samples

**Files:**
- Create: `packages/api/src/proxy/sample.ts`
- Test: `packages/api/src/proxy/sample.test.ts`

**Interfaces:**
- Consumes: `ProviderKind`.
- Produces:
  - `PARSE_VERSION = 1`
  - `parseSample(kind: ProviderKind, requestBody: string, responseText: string): Sample | null`
  - types `Sample`, `SampleMessage`, `ContentBlock`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/proxy/sample.test.ts
import { describe, it, expect } from "vitest";
import { parseSample, PARSE_VERSION } from "./sample.js";

const anthropicReq = JSON.stringify({
  model: "claude-sonnet-4-5-20250929", max_tokens: 1024,
  system: "You are helpful.",
  tools: [{ name: "read_file", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "hi" }],
});
const anthropicResp = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}
`;

describe("parseSample", () => {
  it("normalizes an Anthropic request/response", () => {
    const s = parseSample("anthropic", anthropicReq, anthropicResp);
    expect(s).not.toBeNull();
    expect(s!.schema).toBe("valet.llm-sample/v1");
    expect(s!.provider).toBe("anthropic");
    expect(s!.model).toBe("claude-sonnet-4-5-20250929");
    expect(s!.tools.map((t) => t.name)).toContain("read_file");
    expect(s!.input[0]).toMatchObject({ role: "user" });
    expect(s!.output.role).toBe("assistant");
    expect(s!.output.content.find((c) => c.type === "text")).toMatchObject({ text: "hello" });
    expect(s!.stop_reason).toBe("end_turn");
  });
  it("records a Codex previous_response_id and partial input", () => {
    const req = JSON.stringify({ model: "gpt-5", previous_response_id: "resp_prev", input: [{ role: "user", content: "next" }] });
    const resp = `event: response.completed
data: {"type":"response.completed","response":{"id":"resp_now","model":"gpt-5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}
`;
    const s = parseSample("openai", req, resp);
    expect(s!.previousResponseId).toBe("resp_prev");
    expect(s!.output.content.find((c) => c.type === "text")).toMatchObject({ text: "ok" });
  });
  it("preserves an unknown block type rather than dropping it", () => {
    const req = JSON.stringify({ model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: [{ type: "weird_new_thing", data: 1 }] }] });
    const s = parseSample("anthropic", req, "data: {}\n");
    expect(s!.input[0].content[0]).toMatchObject({ type: "unknown" });
  });
  it("exposes the parser version", () => { expect(PARSE_VERSION).toBe(1); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test proxy/sample`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/api/src/proxy/sample.ts`. Define the `Sample`/`SampleMessage`/`ContentBlock` types from the spec, `PARSE_VERSION = 1`, and `parseSample` that:
1. `JSON.parse`es `requestBody`; on failure returns null.
2. Reads `model`, `params` (max_tokens/temperature/top_p/stop/reasoning_effort), `system`, `tools`, `previousResponseId` (OpenAI `previous_response_id`).
3. Normalizes request messages: Anthropic `messages[]`; OpenAI `input[]` (or `instructions`+`input`). Map each content item to a `ContentBlock` union (`text`/`image`/`tool_use`/`tool_result`/`reasoning`), and ANY unrecognized `type` to `{ type: "unknown", raw }`.
4. Reassembles the response `output` from the SSE (Anthropic `content_block_delta` text concatenation + `message_delta.stop_reason`; OpenAI `response.completed.response.output[]`), producing one assistant `SampleMessage`.
5. Attaches `usage` by calling `parseUsage(kind, responseText)` (reuse Task 5) — `?.usage ?? zero`.
6. Never throws: wrap body parsing so a malformed body yields null (caller stores `parse_error`).

Write it as small pure helpers (`normalizeContent`, `assembleAnthropicOutput`, `assembleOpenAIOutput`) so each is unit-simple. Keep the block union permissive (`Record<string, unknown>` for unknown).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @valet/api test proxy/sample`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proxy/sample.ts packages/api/src/proxy/sample.test.ts
git commit -m "feat(api): parseSample normalized sample for both wires"
```

---

## Task 7: Recorder + proxy spend metric

**Files:**
- Create: `packages/api/src/proxy/recorder.ts`
- Create: `packages/api/src/proxy/metrics.ts`
- Test: `packages/api/src/proxy/recorder.test.ts`

**Interfaces:**
- Consumes: everything above; `AppDb`, `llmProxyRequests`.
- Produces:
  - `recordProxyCall(deps, ctx): Promise<void>` — consumes a tee branch, parses, prices, inserts one row, emits the metric.
  - `ctx` type `RecordContext = { principal, kind, endpoint, harness, requestBody, stream, statusCode, startMs, nowMs, stream: ReadableStream<Uint8Array> | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/proxy/recorder.test.ts
import { describe, it, expect, vi } from "vitest";
import { recordProxyCall } from "./recorder.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
const anthropicResp = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5-20250929","role":"assistant","content":[],"usage":{"input_tokens":100,"output_tokens":1}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}
`;

describe("recordProxyCall", () => {
  it("inserts one row with usage, cost, bodies, and parsed sample", async () => {
    const inserted: Record<string, unknown>[] = [];
    await recordProxyCall(
      { insert: async (row) => { inserted.push(row); }, now: () => 1000, id: () => "row1", metric: vi.fn() },
      {
        principal: { userId: "u1", orgId: "org1", keyId: "k1" },
        kind: "anthropic", endpoint: "/v1/messages", harness: "claude-code",
        requestBody: JSON.stringify({ model: "claude-sonnet-4-5-20250929", messages: [{ role: "user", content: "hi" }] }),
        stream: streamOf(anthropicResp), statusCode: 200, startMs: 900,
      },
    );
    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row).toMatchObject({
      id: "row1", orgId: "org1", userId: "u1", providerKind: "anthropic",
      model: "claude-sonnet-4-5-20250929", inputTokens: 100, outputTokens: 50, totalTokens: 150,
      providerResponseId: "msg_1", statusCode: 200, parseVersion: 1,
    });
    expect(row.costUsd).not.toBeNull();
    expect(String(row.requestBody)).toContain("hi");
    expect(String(row.responseBody)).toContain("message_start");
    expect(row.parsed).toBeTruthy();
  });
  it("swallows a parse failure: row still written, cost null", async () => {
    const inserted: Record<string, unknown>[] = [];
    await recordProxyCall(
      { insert: async (r) => { inserted.push(r); }, now: () => 1, id: () => "row2", metric: vi.fn() },
      { principal: { userId: "u", orgId: "o", keyId: "k" }, kind: "openai", endpoint: "/v1/responses",
        harness: "codex", requestBody: "not json", stream: streamOf("garbage"), statusCode: 200, startMs: 0 },
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0].costUsd).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test proxy/recorder`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement metrics + recorder**

```ts
// packages/api/src/proxy/metrics.ts
import { metrics } from "@opentelemetry/api";
let counter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null;
export function recordProxySpend(costUsd: number, attrs: { model: string; userId: string; keyId: string; kind: string }): void {
  if (!counter) counter = metrics.getMeter("@valet/api").createCounter("valet.proxy.cost.usd", {
    description: "External-harness proxy spend in USD, by user/key/model (priced calls only)",
  });
  if (costUsd > 0) counter.add(costUsd, attrs);
}
```

```ts
// packages/api/src/proxy/recorder.ts
import { parseUsage } from "./usage-parser.js";
import { parseSample, PARSE_VERSION } from "./sample.js";
import { priceUsage } from "../lib/pricing.js";
import type { ProviderKind, ProxyPrincipal } from "./types.js";

export interface RecordContext {
  principal: ProxyPrincipal;
  kind: ProviderKind;
  endpoint: string;
  harness: string;
  requestBody: string;
  stream: ReadableStream<Uint8Array> | null;
  statusCode: number;
  startMs: number;
}
export interface RecorderDeps {
  insert: (row: Record<string, unknown>) => Promise<void>;
  now: () => number;
  id: () => string;
  metric: (costUsd: number, attrs: { model: string; userId: string; keyId: string; kind: string }) => void;
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) chunks.push(value); } }
  catch { /* client disconnect mid-stream: record what arrived */ }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

function previousResponseId(kind: ProviderKind, requestBody: string): string | null {
  if (kind !== "openai") return null;
  try { const b = JSON.parse(requestBody) as Record<string, unknown>; return (b.previous_response_id as string) ?? null; }
  catch { return null; }
}

/**
 * Consumes the recorder's tee branch to completion, parses usage, prices it,
 * normalizes the sample, and writes exactly one row. NEVER throws to the
 * caller — the client stream was already delivered, so a recording failure
 * is logged and swallowed (spec section 5).
 */
export async function recordProxyCall(deps: RecorderDeps, ctx: RecordContext): Promise<void> {
  try {
    const responseBody = await drain(ctx.stream);
    const parsedUsage = parseUsage(ctx.kind, responseBody);
    const usage = parsedUsage?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const model = parsedUsage?.model ?? null;
    const cost = model ? priceUsage(ctx.kind, model, usage) : null;
    let parsed: unknown = null; let parseError: string | null = null;
    try { parsed = parseSample(ctx.kind, ctx.requestBody, responseBody); }
    catch (e) { parseError = e instanceof Error ? e.message : String(e); }
    const now = deps.now();
    await deps.insert({
      id: deps.id(), createdAt: now, orgId: ctx.principal.orgId, userId: ctx.principal.userId,
      apiKeyId: ctx.principal.keyId, providerKind: ctx.kind, model, harness: ctx.harness, endpoint: ctx.endpoint,
      providerResponseId: parsedUsage?.providerResponseId ?? null,
      previousResponseId: previousResponseId(ctx.kind, ctx.requestBody),
      stream: !!ctx.stream, statusCode: ctx.statusCode, requestBody: ctx.requestBody, responseBody,
      inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite, totalTokens: usage.total, costUsd: cost, latencyMs: now - ctx.startMs,
      error: ctx.statusCode >= 400 ? responseBody.slice(0, 2000) : null,
      parsed, parseVersion: parsed ? PARSE_VERSION : null, parseError,
    });
    if (cost && model) deps.metric(cost, { model, userId: ctx.principal.userId, keyId: ctx.principal.keyId, kind: ctx.kind });
  } catch (err) {
    console.error("recordProxyCall failed (client stream already delivered):", err);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @valet/api test proxy/recorder`
Expected: PASS (both cases). Note: `deps.now()` is called once and reused; the test asserts `now:()=>1000, startMs:900` → `latencyMs:100` implicitly via the row (add that assertion if desired).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/proxy/recorder.ts packages/api/src/proxy/metrics.ts packages/api/src/proxy/recorder.test.ts
git commit -m "feat(api): proxy recorder + spend metric"
```

---

## Task 8: `/proxy/*` gateway router + mount

**Files:**
- Create: `packages/api/src/routes/proxy-gateway.ts`
- Modify: `packages/api/src/app.ts` (mount before the `/api` auth middleware so `/proxy` bypasses the ladder)
- Modify: `packages/api/src/main.ts` (call `ensureEnvProviders`)
- Test: `packages/api/src/routes/proxy-gateway.test.ts`

**Interfaces:**
- Consumes: `resolveProxyPrincipal`, `resolveUpstream`, `recordProxyCall`, `outboundHeaders`.
- Produces: `registerProxyGateway(app, deps)`; `outboundHeaders(raw, kind, apiKey): Headers` (exported, unit-tested).

- [ ] **Step 1: Write the failing test (header fidelity + forward + record)**

```ts
// packages/api/src/routes/proxy-gateway.test.ts
import { describe, it, expect, vi } from "vitest";
import { outboundHeaders } from "./proxy-gateway.js";

describe("outboundHeaders", () => {
  it("forwards provider headers, drops the valet key + hop-by-hop, sets real auth", () => {
    const raw = new Headers({
      "x-api-key": "vlt_secret", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching",
      "x-stainless-lang": "js", "content-type": "application/json", "content-length": "42", "host": "localhost",
      connection: "keep-alive",
    });
    const out = outboundHeaders(raw, "anthropic", "sk-real");
    expect(out.get("anthropic-version")).toBe("2023-06-01");
    expect(out.get("anthropic-beta")).toBe("prompt-caching");
    expect(out.get("x-stainless-lang")).toBe("js");
    expect(out.get("x-api-key")).toBe("sk-real");           // swapped, not the valet key
    expect(out.get("content-length")).toBeNull();           // hop-by-hop stripped
    expect(out.get("host")).toBeNull();
    expect(out.get("connection")).toBeNull();
  });
  it("uses Authorization: Bearer for openai and drops the incoming bearer", () => {
    const raw = new Headers({ authorization: "Bearer vlt_secret", "openai-beta": "responses=v1" });
    const out = outboundHeaders(raw, "openai", "sk-real");
    expect(out.get("authorization")).toBe("Bearer sk-real");
    expect(out.get("openai-beta")).toBe("responses=v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test proxy-gateway`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Create `packages/api/src/routes/proxy-gateway.ts`:

```ts
import type { Hono, Context } from "hono";
import type { AppEnv } from "../env.js";
import type { ProviderKind } from "../proxy/types.js";
import { resolveProxyPrincipal, wireError } from "../proxy/principal.js";
import { resolveUpstream } from "../proxy/upstream.js";
import { recordProxyCall } from "../proxy/recorder.js";
import { recordProxySpend } from "../proxy/metrics.js";
import { llmProxyRequests } from "../schema/index.js";
import { resolveOrgId } from "../lib/org.js";
import { users } from "../schema/index.js";
import { eq } from "drizzle-orm";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "host", "te", "trailer", "upgrade"]);

/** Strip-list, NOT allowlist (spec finding 4): forward every header except
 * hop-by-hop + the valet key, then set the real upstream auth. Fidelity
 * matters on this harness→provider hop; unenumerated beta headers must pass. */
export function outboundHeaders(raw: Headers, kind: ProviderKind, apiKey: string): Headers {
  const out = new Headers();
  for (const [k, v] of raw.entries()) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === "x-api-key" || lk === "authorization") continue;
    out.set(k, v);
  }
  if (kind === "anthropic") out.set("x-api-key", apiKey);
  else out.set("authorization", `Bearer ${apiKey}`);
  return out;
}

function sanitizeResponseHeaders(res: Response): Headers {
  const h = new Headers(res.headers);
  h.delete("content-encoding"); h.delete("transfer-encoding");
  return h;
}
function harnessFrom(ua: string | null): string {
  if (!ua) return "unknown";
  if (/claude-cli|claude-code/i.test(ua)) return "claude-code";
  if (/codex/i.test(ua)) return "codex";
  return "unknown";
}
const RECORDABLE = new Set(["/v1/messages", "/v1/responses"]);

export interface ProxyGatewayDeps {
  verifyApiKey: (opts: { key: string }) => Promise<{ valid: boolean; key: { id: string; userId: string } | null }>;
}

async function handle(c: Context<AppEnv>, kind: ProviderKind): Promise<Response> {
  const db = c.var.providers.db;
  const principal = await resolveProxyPrincipal(c.req.raw.headers, kind, {
    verifyApiKey: c.get("proxyVerifyApiKey") ?? (() => { throw new Error("verifyApiKey dep missing"); }),
    userOrg: async (userId) => {
      const rows = await db.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).limit(1);
      return rows[0]?.orgId ?? (await resolveOrgId(db));
    },
  });
  if (principal instanceof Response) return principal;

  const upstream = await resolveUpstream(db, c.var.providers.engineCredentials, principal.orgId, kind);
  if (!upstream) return wireError(kind, 502, `No ${kind} provider configured. Add one in valet Settings, or set the ${kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} env var.`);

  const url = new URL(c.req.url);
  const subpath = url.pathname.replace(new RegExp(`^/proxy/${kind}`), "") || "/";
  if (subpath.split("/").some((s) => s === "..")) return wireError(kind, 400, "Invalid path.");

  const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
  const reqText = hasBody ? await c.req.text() : "";
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(`${upstream.baseUrl}${subpath}${url.search}`, {
      method: c.req.method, headers: outboundHeaders(c.req.raw.headers, kind, upstream.apiKey),
      body: hasBody ? reqText : undefined,
    });
  } catch {
    return wireError(kind, 502, "Upstream provider unreachable.");
  }

  const recordable = RECORDABLE.has(subpath) && !!res.body;
  if (!recordable) return new Response(res.body, { status: res.status, headers: sanitizeResponseHeaders(res) });

  const [toClient, toRecorder] = res.body!.tee();
  void recordProxyCall(
    { insert: async (row) => { await db.insert(llmProxyRequests).values(row as typeof llmProxyRequests.$inferInsert); },
      now: () => Date.now(), id: () => crypto.randomUUID(), metric: recordProxySpend },
    { principal, kind, endpoint: subpath, harness: harnessFrom(c.req.header("user-agent") ?? null),
      requestBody: reqText, stream: toRecorder, statusCode: res.status, startMs: start },
  );
  return new Response(toClient, { status: res.status, headers: sanitizeResponseHeaders(res) });
}

export function registerProxyGateway(app: Hono<AppEnv>, deps: ProxyGatewayDeps): void {
  app.use("/proxy/*", async (c, next) => { c.set("proxyVerifyApiKey", deps.verifyApiKey); await next(); });
  app.all("/proxy/anthropic/*", (c) => handle(c, "anthropic"));
  app.all("/proxy/openai/*", (c) => handle(c, "openai"));
}
```

Add `proxyVerifyApiKey` to `AppVariables` in `env.ts` as an optional context var (`proxyVerifyApiKey?: PrincipalDeps["verifyApiKey"]`), or thread `deps.verifyApiKey` via a closure instead of `c.get` — pick the closure form if you prefer not to widen `AppVariables`. (Closure form: capture `deps` in `handle` by defining `handle` inside `registerProxyGateway`.)

- [ ] **Step 4: Mount in `app.ts` and boot in `main.ts`**

In `app.ts`, mount `/proxy` BEFORE the `/api` auth middleware runs (the proxy has its own key auth; it must not hit the cookie ladder). Import `registerProxyGateway` and call `registerProxyGateway(app, { verifyApiKey: (opts) => auth.api.verifyApiKey({ body: opts }) })` where `auth` is the instance `createApp` already has. If `auth` is null (stub mode), pass a `verifyApiKey` that 401s — the proxy needs real keys.

In `main.ts`, after providers are built and migrations applied (near the existing boot reconciliation), call:
```ts
await ensureEnvProviders(providers.db, providers.engineCredentials, await resolveOrgId(providers.db));
```

- [ ] **Step 5: Run header test + typecheck**

Run: `pnpm --filter @valet/api test proxy-gateway` then `pnpm typecheck`
Expected: PASS + clean.

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/routes/proxy-gateway.ts packages/api/src/app.ts packages/api/src/main.ts packages/api/src/env.ts packages/api/src/routes/proxy-gateway.test.ts
git commit -m "feat(api): mount /proxy recording gateway + env provider boot"
```

---

## Task 9: `/api/proxy/*` read API

**Files:**
- Create: `packages/api/src/routes/proxy-usage.ts`
- Modify: `packages/api/src/app.ts` (`app.route("/api/proxy", proxyUsageRouter)`)
- Test: `packages/api/src/routes/proxy-usage.test.ts`
- Modify: `packages/api/src/wire/types.ts` (response types)

**Interfaces:**
- Produces endpoints: `GET /api/proxy/usage/summary`, `GET /api/proxy/requests`, `GET /api/proxy/requests/:id`.
- Response types in `wire/types.ts`: `ProxyUsageSummary`, `ProxyRequestListItem`, `ProxyRequestDetail`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/api/src/routes/proxy-usage.test.ts — use the existing api integration test harness
// (see routes/usage.test.ts for the app+seed pattern). Assert:
//   - a member sees only their own rows in /requests
//   - an admin sees the whole org
//   - /requests/:id 404s for a cross-org row and for another member's row (non-admin)
//   - /usage/summary buckets cost by user, model, harness
```

Follow `routes/usage.test.ts` for building the app, seeding a user + org, and inserting `llmProxyRequests` rows directly via `providers.db.insert(llmProxyRequests)`. Write one `it` per bullet above with concrete inserted rows and asserted aggregates.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @valet/api test proxy-usage`
Expected: FAIL.

- [ ] **Step 3: Implement the router**

Mirror `routes/usage.ts`: `new Hono<AppEnv>()`, read `c.var.user`, gate admin via `isOrgAdmin`. `/usage/summary` runs raw aggregates over `llm_proxy_requests` grouped by time bucket, `user_id`, `model`, `harness` (members: `WHERE user_id = :self`; admins: `WHERE org_id = :org`). `/requests` selects metadata columns (no bodies) with filters + a `created_at`/`id` cursor. `/requests/:id` selects one row incl. `request_body`/`response_body`/`parsed`, gated: non-admin only their own row; a row outside the org 404s.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @valet/api test proxy-usage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/proxy-usage.ts packages/api/src/wire/types.ts packages/api/src/app.ts packages/api/src/routes/proxy-usage.test.ts
git commit -m "feat(api): /api/proxy read API with ownership gating"
```

---

## Task 10: Web dashboard + onboarding panel

**Files:**
- Create: `packages/web/src/routes/usage.tsx`
- Create: `packages/web/src/components/usage/SpendChart.tsx`, `BreakdownTable.tsx`, `RequestLog.tsx`, `SampleView.tsx`, `OnboardingPanel.tsx`
- Test: `packages/web/src/routes/usage.test.tsx`

**Interfaces:**
- Consumes: `/api/proxy/*` endpoints via TanStack Query.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/web/src/routes/usage.test.tsx — follow settings.organization.models.test.tsx for the
// render + mocked-fetch pattern. Assert:
//   - the spend total renders from a mocked /usage/summary
//   - a breakdown row per model renders
//   - clicking a request-log row opens the SampleView drill-down
//   - OnboardingPanel shows the Claude Code env pair and Codex config.toml block after "create key"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nvm use 22 && pnpm --filter @valet/web test usage`
Expected: FAIL.

- [ ] **Step 3: Implement components**

- `usage.tsx`: `createFileRoute("/usage")`, TanStack Query for `/api/proxy/usage/summary` (window selector) + `/api/proxy/requests`. Layout: header total, `SpendChart`, `BreakdownTable` (×3: user/model/harness), `RequestLog`, and `OnboardingPanel`.
- `SpendChart.tsx`: dependency-free inline-SVG bars of cost per time bucket (no new chart lib). Height-scale to max bucket; label axis with dates.
- `BreakdownTable.tsx`: generic `{ rows: {label, requests, tokens, costUsd}[] }` table.
- `RequestLog.tsx`: paginated table (model, harness, user, tokens, cost, time); row `onClick` sets a selected id.
- `SampleView.tsx`: fetches `/api/proxy/requests/:id`, renders `parsed` (system, tools, input turns, assistant output) reusing existing session message-render components where a block maps cleanly; "view raw" toggle shows `request_body`/`response_body`. Falls back to raw when `parsed` is null.
- `OnboardingPanel.tsx`: "Create proxy key" button (POST to the key endpoint — reuse `apiKey` issuance; if no endpoint exists yet, add `POST /api/proxy/keys` wrapping `auth.api.createApiKey` in Task 9's router). On success, render copyable snippets:
  - Claude Code: `ANTHROPIC_BASE_URL=<origin>/proxy/anthropic` + `ANTHROPIC_AUTH_TOKEN=<key>`.
  - Codex `config.toml`: `[model_providers.valet]` with `base_url="<origin>/proxy/openai/v1"`, `env_key="VALET_KEY"`, `wire_api="responses"`, plus `export VALET_KEY=<key>`.

- [ ] **Step 4: Run test to verify it passes**

Run: `nvm use 22 && pnpm --filter @valet/web test usage`
Expected: PASS.

- [ ] **Step 5: Add nav link + commit**

Add a nav entry to `/usage` wherever the app registers top-level nav (match how `/sessions`/`settings` are linked). Then:

```bash
git add packages/web/src/routes/usage.tsx packages/web/src/components/usage packages/web/src/routes/usage.test.tsx
git commit -m "feat(web): recording-gateway usage dashboard + onboarding"
```

---

## Task 11: End-to-end validation

**Files:** none (validation only)

- [ ] **Step 1: Reset + start the stack**

```bash
rm -rf ~/.valet/pg
nvm use 22
make dev-local     # needs ANTHROPIC_API_KEY (and OPENAI_API_KEY for the Codex leg) in env
curl -sf localhost:8788/api/health   # expect ok within ~5s
```

- [ ] **Step 2: Issue a proxy key**

Open the web app `/usage`, create a proxy key, copy it.

- [ ] **Step 3: Drive Claude Code through the gateway**

```bash
ANTHROPIC_BASE_URL=http://localhost:8788/proxy/anthropic ANTHROPIC_AUTH_TOKEN=<vlt_key> \
  claude -p "say hello in five words"
```
Expected: normal streamed reply. Then confirm a row: on `/usage` the request log shows a `claude-code` row with non-zero tokens and a non-null cost, and the drill-down renders the prompt + reply.

- [ ] **Step 4: Drive Codex through the gateway**

Add to `~/.codex/config.toml`:
```toml
model_provider = "valet"
[model_providers.valet]
name = "valet"
base_url = "http://localhost:8788/proxy/openai/v1"
env_key = "VALET_KEY"
wire_api = "responses"
```
Then:
```bash
VALET_KEY=<vlt_key> codex exec "say hello in five words"
```
Expected: normal reply; `/usage` shows a `codex` row with a non-null cost (Codex-priced acceptance, spec finding 3). If the Codex row is unpriced, the model id is not in pi-ai's registry — extend `priceUsage`/the model map before calling this done.

- [ ] **Step 5: Confirm spend folds into existing usage**

Hit `/api/usage/summary` and confirm the proxy spend is included (the `cost_entries` UNION).

- [ ] **Step 6: Full scorecard**

```bash
pnpm typecheck
make e2e 2>&1 | tee /tmp/e2e.log
```
Expected: clean scorecard. Any red row must be a pre-existing environmental failure you can name as unrelated (see the memory notes on env-sensitive tests + pool-contention flakes).

- [ ] **Step 7: Update the spec status + commit**

Flip the spec header `Status:` to "Implemented" and note the pi-ai model ids actually used for pricing. Commit.

---

## Self-Review Notes

- **Spec coverage:** ingress (T8), auth/attribution (T4/T8), upstream + env auto-provision (T3/T8), tee+recorder (T7/T8), usage parse (T5), pricing incl. Codex acceptance (T2/T11), sample parse (T6), schema + cost_entries union (T1), read API + gating (T9), dashboard + onboarding (T10), spend metric (T7), operational fail-open (T8 `wireError` on every error path). All spec sections map to a task.
- **Deferred per spec (no task, intentional):** hard budget caps, conversation stitching, retention sweep, training-data export, Google/OpenRouter kinds.
- **Type consistency:** `ProxyUsage`/`ParsedUsage`/`ProxyPrincipal`/`Upstream`/`ProviderKind` defined once in `proxy/types.ts` (T2) and imported everywhere; `priceUsage`, `parseUsage`, `parseSample(PARSE_VERSION)`, `resolveUpstream`, `resolveProxyPrincipal`, `wireError`, `outboundHeaders`, `recordProxyCall` names are used identically across tasks.
- **Known verify-at-impl points (flagged inline, not placeholders):** exact pi-ai model ids for the pricing test (T2 probe), `createLlmProvider`/`credentials.set` signatures (T3), and the `auth.api.verifyApiKey` wiring in stub mode (T8).
