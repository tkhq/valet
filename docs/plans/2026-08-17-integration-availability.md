# Integration Availability Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A service whose deployment/org prerequisite is missing reports `connect: "unconfigured"`, rejects manual saves, and never exposes tools to the agent.

**Architecture:** One resolver (`packages/api/src/services/integration-availability.ts`) classifies each credential declaration from two sources: OAuth client env vars (already declared) and org-scoped credential presence (new `requires: { orgCredential: true }` on `CredentialDeclaration`). Four consumers: the `/api/plugins` listing, the `PUT /api/credentials/:service` route, `EngineHost.sessionExtras`, and the workflow `ActionInvoker`.

**Tech Stack:** TypeScript, Hono, Vitest, React 19.

**Spec:** `docs/specs/2026-08-17-integration-availability-design.md`

## Global Constraints

- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md type safety rules).
- Every user-facing error message names the corrective action.
- Vitest filters: `pnpm --filter @valet/<pkg> test <filter>` with NO `--` before the filter.
- Commit per task, subjects ≤72 chars, no AI co-author trailers.
- The engine stays policy-free: it carries `requires`, only the API evaluates it.

---

### Task 1: Engine field + Slack declaration

**Files:**
- Modify: `packages/engine/src/valet-plugin.ts:39-51` (CredentialDeclaration)
- Modify: `packages/plugin-slack/src/plugin.ts:18-24`

**Interfaces:**
- Produces: `CredentialDeclaration.requires?: { orgCredential: true }`

No behavior change yet (nothing reads the field), so no failing test — typecheck is the gate.

- [ ] **Step 1: Add the field**

In `packages/engine/src/valet-plugin.ts`, after the `oauth?` member of `CredentialDeclaration`:

```ts
  /** Deployment/org prerequisite for offering this credential. Absent = the
   * credential is self-sufficient (a personal token works with no org setup)
   * and the service is always offered. `orgCredential: true` = an org-scoped
   * credential for this service must exist before users can connect; an
   * admin creates it in Settings → Organization. Evaluated by the API host,
   * never by the engine. */
  requires?: { orgCredential: true };
```

- [ ] **Step 2: Slack declares it**

In `packages/plugin-slack/src/plugin.ts`:

```ts
  credentials: [
    {
      type: "bot_token",
      configKeys: ["accessToken"],
      connectLabel: "Connect Slack (bot token)",
      requires: { orgCredential: true },
    },
  ],
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck` → clean.

- [ ] **Step 4: Commit**

`feat(engine): requires.orgCredential on CredentialDeclaration; slack declares it`

---

### Task 2: The availability resolver

**Files:**
- Create: `packages/api/src/services/integration-availability.ts`
- Test: `packages/api/src/services/integration-availability.test.ts`

**Interfaces:**
- Consumes: `findOAuthDeclaration`, `authCodeEnvReady` from `./integration-oauth.js`; `CredentialStore`, `ValetPlugin`, `CredentialDeclaration` from `@valet/engine`.
- Produces:
  - `type ConnectMode = "oauth" | "manual" | "unconfigured"`
  - `connectModeFor(params: { plugins: ValetPlugin[]; decl: CredentialDeclaration; service: string; orgId: string; credentials: CredentialStore; env: Record<string, string | undefined> }): Promise<ConnectMode>`
  - `unavailableServiceSet(params: { plugins: ValetPlugin[]; orgId: string; credentials: CredentialStore; env: Record<string, string | undefined> }): Promise<Set<string>>` — decl-service keys resolving `"unconfigured"`.
  - `gateUnavailableActions(plugins: ValetPlugin[], unavailable: ReadonlySet<string>): ValetPlugin[]` — pure; strips `ActionPlugin`s whose `credentialService ?? service` matches an unavailable decl service (join key: `decl.service ?? plugin.name`); everything else on the plugin unchanged.

- [ ] **Step 1: Write failing tests** (in-memory `CredentialStore` stub built as full shape, no casts)

Cases:
- mcp-mode oauth → `"oauth"` regardless of env.
- authorization_code with both env vars → `"oauth"`; either missing → `"unconfigured"`.
- `requires.orgCredential` + org credential stored → `"manual"`; absent → `"unconfigured"`.
- no oauth, no requires → `"manual"` (self-sufficient API key).
- `unavailableServiceSet` returns exactly the unconfigured decl services.
- `gateUnavailableActions` strips matching ActionPlugins, keeps credentials/skills/transports, leaves other plugins untouched.

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @valet/api test integration-availability`
- [ ] **Step 3: Implement** (rules in spec order 1-5)
- [ ] **Step 4: Run to verify pass**
- [ ] **Step 5: Commit** — `feat(api): integration availability resolver`

---

### Task 3: Fix requiresCredential inference fallback

**Files:**
- Modify: `packages/api/src/plugins/assemble.ts:234-244` (`withCredentialRequirement`)
- Test: `packages/api/src/plugins/assemble.test.ts`

- [ ] **Step 1: Failing test** — a plugin whose credential decl omits `service` (slack shape) gets `requiresCredential: true` inferred on its ActionPlugin.
- [ ] **Step 2: Verify fail** — `pnpm --filter @valet/api test assemble`
- [ ] **Step 3: Fix** — `const credentialServices = new Set((plugin.credentials ?? []).map((c) => c.service ?? plugin.name));`
- [ ] **Step 4: Verify pass** (full assemble + engine happy-path suites)
- [ ] **Step 5: Commit** — `fix(api): infer requiresCredential when a credential decl omits service`

---

### Task 4: Wire tri-state + /api/plugins + spec pointer

**Files:**
- Modify: `packages/api/src/wire/types.ts:1599-1603` (`connect` doc + union)
- Modify: `packages/api/src/routes/plugins.ts:119-142`
- Modify: `docs/specs/2026-07-20-integration-oauth-design.md` (manual-fallback paragraph → pointer to new spec)
- Test: `packages/api/src/routes/plugins.test.ts`

**Interfaces:**
- Produces: `PluginServiceSummary.connect: "oauth" | "manual" | "unconfigured"`.

- [ ] **Step 1: Failing tests** — slack with no org credential lists `connect: "unconfigured"`; with org credential stored → `"manual"`; google decl without env → `"unconfigured"` (was `"manual"`); connected slack row keeps `connected: true` while `"unconfigured"`.
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement** — replace the inline `oauthReady` block with `await connectModeFor(...)` (route is async; resolve per decl with `Promise.all` over services).
- [ ] **Step 4: Verify pass** — `pnpm --filter @valet/api test plugins`
- [ ] **Step 5: Commit** — `feat(api): tri-state connect on /api/plugins`

---

### Task 5: Gate manual saves

**Files:**
- Modify: `packages/api/src/routes/credentials.ts` (PUT handler, before the slack org check)
- Test: `packages/api/src/routes/credentials.test.ts`

- [ ] **Step 1: Failing tests** — user-scope PUT for unconfigured slack → 403 with error naming Settings → Organization; org-scope PUT (admin) still accepted; user-scope PUT after org credential exists → accepted; unknown service still accepted.
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement** — look up the service's decl in `c.var.providers.plugins`; when found and `scope === "user"`, `connectModeFor(...) === "unconfigured"` → `403 { error: "<Service> is not configured for this organization. An admin can set it up in Settings → Organization." }`.
- [ ] **Step 4: Verify pass** — `pnpm --filter @valet/api test credentials`
- [ ] **Step 5: Commit** — `feat(api): reject manual saves for unconfigured services`

---

### Task 6: Gate session tools

**Files:**
- Modify: `packages/api/src/engine/host.ts:722-734` (`sessionExtras`)
- Test: `packages/api/src/engine/host.plugins.test.ts`

- [ ] **Step 1: Failing test** — a session built for an org with no org slack credential gets no `slack.*` entries via `list_tools`; after the org credential is saved, a fresh session build lists them.
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement** — in `sessionExtras`, compute `unavailableServiceSet` (env: `process.env`, credentials: `this.opts.engineCredentials`, orgId param) and pass `gateUnavailableActions(plugins, unavailable)` to `pluginSessionExtras`. Skip when `plugins.length === 0`.
- [ ] **Step 4: Verify pass** — `pnpm --filter @valet/api test host.plugins`
- [ ] **Step 5: Commit** — `feat(api): strip unconfigured services' tools from session builds`

---

### Task 7: Gate workflow invocations

**Files:**
- Modify: `packages/api/src/plugins/action-invoker.ts` (before credential resolution)
- Test: `packages/api/src/plugins/action-invoker.test.ts` (or the module's existing test file)

- [ ] **Step 1: Failing test** — invoking a slack action for an org with no org slack credential returns a deterministic error naming Settings → Organization (and is recorded like other deterministic failures).
- [ ] **Step 2: Verify fail**
- [ ] **Step 3: Implement** — resolve `connectModeFor` for the action's decl with `ctx.orgId`; `"unconfigured"` → deterministic failure result.
- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit** — `feat(api): block workflow actions for unconfigured services`

---

### Task 8: Web tri-state

**Files:**
- Modify: `packages/web/src/components/integrations/connect-dialog.tsx:78-81` (`connectPath`)
- Modify: `packages/web/src/components/integrations/integration-row.tsx`
- Modify: `packages/web/src/routes/integrations.tsx` (grid filter)
- Test: `packages/web/src/routes/-integrations.test.tsx`, `packages/web/src/components/integrations/connect-dialog.test.tsx`

- [ ] **Step 1: Failing tests** — an unconfigured+unconnected service renders no tile; an unconfigured+connected service renders Disconnect, no Connect, and the note "Not configured for this organization. An admin can set this up in Settings → Organization."
- [ ] **Step 2: Verify fail** — `pnpm --filter @valet/web test integrations`
- [ ] **Step 3: Implement** — filter unconfigured+unconnected plugins out of the Services grid; in `ServiceBlock`, when `connect === "unconfigured"` suppress the Connect control and add the note via the existing org-note slot; `connectPath` returns `"manual"` for `"unconfigured"` (unreachable — control suppressed — but total).
- [ ] **Step 4: Verify pass**
- [ ] **Step 5: Commit** — `feat(web): hide unconfigured integrations; explain connected leftovers`

---

### Task 9: Validation

- [ ] `pnpm typecheck`
- [ ] `pnpm --filter @valet/engine test happy-path` (tool-call persistence regression rule)
- [ ] `make e2e` — full scorecard captured untruncated; name any red row's environmental cause.
- [ ] Commit any doc touch-ups; done.
