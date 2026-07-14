# Plugin System v2 — Design Spec

> Defines the v2 plugin system and the in-place conversion of the existing plugin library (`packages/plugin-*`, ~56 actions across 14 services, 2 channel plugins, ~10 content skills): the `ValetPlugin` manifest contract, engine-native action shapes (no compat adapter, no dual trees — plugins simply become v2), channel-transport rewrites, trigger and credential-declaration contracts, and dual loading (bundled registry + dynamic node_modules). Also resequences the local-E2E roadmap: platform (auth + plugins) lands after workflows; Telegram ships as the first v2 channel plugin.

## Scope

Covers: the v2 plugin manifest and entry-point convention; the in-place action conversion (Zod `ActionSource` → engine `ActionPlugin`); channel-transport strategy; content plugins (skills/personas) mapping; the trigger contract; credential declarations; the two loaders; per-plugin conversion mechanics; roadmap resequencing.

Does NOT cover: OAuth/connect flow implementation, token storage UI, consent screens (platform/login spec); the HTTP webhook ingress route and trigger routing (lands with its consumers — workflows and channels); the Telegram/Slack transport implementations themselves (their phases); the legacy worker (frozen; pins pre-conversion — see Background).

## Background

Two plugin systems exist today:

- **Legacy (`@valet/sdk`)**: Zod-based `ActionSource` (`listActions`/`execute` with a flat resolved-credentials `ActionContext`), message-relay `ChannelTransport`, webhook trigger parsers, content files delivered to sandboxes. Compiled into the worker via `make generate-registries`. Serves production until worker sunset.
- **Engine v2 (`@valet/engine`)**: `plugin-catalog.ts` defines the engine-native `ActionPlugin`/`PluginAction` (TypeBox parameters, `ToolContext`-derived `PluginActionContext`, `ToolAttachment` results) exposed via `list_tools`/`call_tool` indirection, and explicitly does not accept legacy shapes. The engine spec defines the v2 `ChannelTransport` contract (verified ingress → conversationKey → `SignalContent`), `SkillSource`, `RoleSpec`, `CommandToolDef`, and `CredentialStore`.

Decisions (with the user): **no compat adapter, no migration period**. Every supported plugin is converted **in place** in one subagent-fleet wave — `src/actions/` is rewritten to engine-native shapes, the manifest becomes the package's only contract, and the legacy Zod exports are deleted. There is no version flag: a plugin in the tree IS a v2 plugin. Channels are rewritten to the v2 contract (payload helpers salvaged).

**Stated consequence:** the frozen legacy worker imports these packages via its generated registries; in-place conversion breaks those imports. The legacy stack therefore pins to the last pre-conversion commit for any future deploy (it is already frozen), and its registries are not regenerated. If a legacy deploy ever needs a plugin bugfix, it is cherry-picked onto that pin — the main branch carries v2 shapes only.

## The `ValetPlugin` Manifest

The single seam between plugins and hosts. Lives in `@valet/engine` (composes only engine-owned types; the engine gains no dependencies):

```typescript
export interface ValetPlugin {
  /** Service id, e.g. "github". Unique across loaded plugins. */
  name: string;
  version: string;
  description?: string;
  actions?: ActionPlugin[];              // plugin-catalog shape, unchanged
  transports?: ChannelTransportFactory[]; // v2 channel contract (engine spec)
  triggers?: TriggerDef[];               // this spec, below
  skills?: SkillSource[];
  roles?: RoleSpec[];
  credentials?: CredentialDeclaration[]; // declaration only, below
}
```

**Entry-point convention:** a plugin package declares `"valet": { "plugin": "./dist/plugin.js" }` in `package.json`; that module's default export is a `ValetPlugin` (or a `() => ValetPlugin | Promise<ValetPlugin>` factory for plugins needing async assembly). The source convention is `src/plugin.ts` building the manifest from the package's action/content modules. The marker's presence is the whole contract — there is no version flag; a package without the marker is not a plugin.

Empty scaffolds are deleted from the tree (not flagged). `plugin-memory-compaction` is retired outright (v2 compaction hooks + the memory service replaced it).

## Actions: the Fleet Port

Every action-bearing plugin is converted engine-native **in place** in one wave — one subagent task per plugin, each with its own review gate; the legacy Zod modules are replaced, not shadowed. The conversion is a **mechanical transform with a preservation rule**:

- Zod parameter schemas → TypeBox (`inputSchema` raw-JSON-Schema fields, where present, translate directly).
- `ActionDefinition` metadata (id, name, description, riskLevel) → `PluginAction` fields verbatim.
- `execute(actionId, params, ctx)` dispatch → per-action `execute(args, ctx)`.
- **Execute bodies move line-for-line.** The fetch/API logic encodes production-learned quirks (pagination, rate limits, auth refresh); the port changes types around it, never the logic inside it. A reviewer flags any body diff that isn't type-plumbing.
- `ActionResult.images` → `ToolAttachment[]` (`{ type: 'image', data, mimeType }` — base64 decode at the boundary).
- Context bridging, engine-side per port:
  - `ctx.credentials` (flat `Record<string,string>`) ← resolved via v2 `CredentialProvider.get(service)` with a **per-service key mapping** declared in the plugin's v2 module (e.g. GitHub expects `{ token }`, Google expects `{ accessToken, refreshToken, … }`). The mapping is audited against how the worker builds `IntegrationCredentials` for that service today; each port task records it.
  - `callerIdentity` ← the orchestrator identity (name/handle) when the calling session is an orchestrator.
  - `analytics`, `guardConfig`, `attribution`: **absent in v2** until their v2 replacements exist (attention router / org policy / channel attribution). Actions that branch on them get the branch preserved with the v2 value hard-coded to the absent case, plus a `V2-GAP:` comment. This absence is a known, deliberate regression documented here — not a silent one.
- Tests per port: unit tests with mocked `fetch` asserting request shape (method, URL, headers, body) and response mapping for each action's happy path + one error path. No live external calls in CI.

Approval semantics carry over automatically: `riskLevel` maps through `plugin-catalog`'s existing defaultApprovalMode derivation (high/critical → require_approval), which resolves through the engine's decision gates — strictly better than the legacy worker's approval plumbing.

## Channels: Rewrite, Salvage Helpers

The legacy message-relay transport and the v2 contract (verified ingress before parsing → conversationKey codec → `SignalContent` admission with `dispatchId` = provider event id → outbound send → gate delivery with inline buttons and edit-on-resolution) share no seam worth adapting. Each channel plugin's transport is rewritten to the v2 contract in `src/transport/`, lifting payload-level modules (Telegram Bot API client, Slack block rendering, file handling) verbatim; the legacy channel modules are deleted with the rest of the Zod surface. Telegram's transport is written in its roadmap phase (the first v2 channel plugin); Slack follows. Until then, the channel plugins ship manifests with `transports: []` and their actions/content only.

## Triggers

```typescript
export interface TriggerDef {
  /** e.g. "github.pull_request" */
  id: string;
  service: string;
  description: string;
  /** Signature verification over exact raw request bytes, BEFORE parsing. Null = reject. */
  verify(req: { headers: Record<string, string>; rawBody: Uint8Array }, secrets: Record<string, string>): VerifiedEvent | null;
  /** Normalize a verified event into an admissible signal. */
  toSignal(event: VerifiedEvent): { signal: SignalContent; dispatchId: string; conversationKey?: string };
}

export interface VerifiedEvent {
  eventType: string;
  deliveryId: string;
  payload: unknown;
}
```

Same pipeline discipline as channels: verification before parsing, admission always as `SignalContent` with the provider's stable delivery id as `dispatchId`. This spec defines the contract and the port of the SDK's existing webhook parsers into `TriggerDef`s; the HTTP ingress route, secret management, and routing-to-consumers (workflow triggers, channel bindings) land with their consumers in the workflow and channel phases.

## Credential Declarations

Plugins declare what they need; the platform phase implements how users provide it:

```typescript
export interface CredentialDeclaration {
  service: string;                                  // defaults to plugin name
  type: 'oauth2' | 'api_key' | 'bot_token' | 'service_account';
  scopes?: string[];                                // oauth2
  /** Keys the plugin's actions expect in the resolved flat map. */
  configKeys: string[];
  /** Human copy for connect UI. */
  connectLabel?: string;
}
```

Hosts use declarations to validate configuration at load time (a plugin whose credentials can't resolve loads with its actions marked unavailable, surfaced in `list_tools` output — not silently absent). Connect flows, token storage, and consent UI are the platform (login) spec's territory.

## Loading: Two Loaders, One Contract

Both produce `ValetPlugin[]`; everything downstream is loader-agnostic.

- **Bundled registry** (required for Cloudflare-class runtimes; available everywhere): `make generate-registries` gains a v2 target scanning `packages/plugin-*/plugin.yaml` for `v2: true` and emitting `packages/api/src/plugins/registry.gen.ts` with static imports of each manifest. Deterministic, typechecked, tree-shaken.
- **node_modules loader** (Node hosts): at boot, discover plugin packages via the `package.json` `valet.plugin` marker across dependencies (plus an optional `VALET_PLUGINS` allowlist/denylist env). Dynamic `import()` per entry; **shape-validate the manifest at the boundary** (TypeBox schema for `ValetPlugin`); **quarantine failures** — a plugin that fails import or validation logs a structured error and is skipped; it never prevents boot. Drop a package into node_modules, restart, it's live.

Host assembly (`packages/api`): `assemblePlugins(plugins, config)` → catalog tools via `pluginCatalogTools`, skills/roles merged into session options, transports/triggers registered with their (future) consumers. Per-deployment enable/disable is config on the assembler, not loader logic. Name collisions across plugins fail assembly loudly.

## Conversion Mechanics

1. **Wave 0 (framework):** `ValetPlugin` type + manifest validation schema in `@valet/engine`; both loaders + assembler in `packages/api`; `generate-registries` retargeted to emit the v2 registry (worker registry generation is retired along with the worker's plugin wiring); orchestrator/session wiring (catalog tools + content into `EngineHost` session options).
2. **Wave 1 (fleet conversion):** one subagent task per action-bearing plugin (github, slack-actions, gmail, google-calendar, google-workspace, cloudflare, deepwiki, figma, linear, notion, sentry, stripe, typefully, browser/sandbox-tunnels/workflows content) — each: replace the Zod modules with engine-native ones, `src/plugin.ts` manifest, TypeBox schemas, verbatim bodies, credential key mapping, mocked-fetch tests, delete dead legacy files, per-plugin review. The SDK's Zod `ActionSource` and legacy channel contracts are deleted at the end of the wave.
3. **Wave 2 (integration):** orchestrator dogfood with real credentials for 2–3 services; `list_tools`/`call_tool` end-to-end; unavailable-credential UX.
4. **Channel transports:** Telegram in its roadmap phase, Slack after.

New plugins author engine-native from day one.

## Roadmap Resequencing

`docs/plans/2026-07-11-engine-v2-local-e2e-roadmap.md` is amended in the same commit as this spec:

- **Phase 5 — Workflow run host**: unchanged, next up.
- **Phase 6 — Platform: auth + plugin system** (new): real login replacing `VALET_LOCAL_AUTH`, org/user provisioning, and this spec's implementation (framework + fleet port + credential declarations feeding connect flows).
- **Phase 7 — Telegram channel**: as previously specced, now implemented as the first v2 channel plugin over this framework.

## Testing

- Manifest validation: TypeBox schema round-trip; malformed manifests quarantined by the node_modules loader without killing boot (test with a fixture bad plugin).
- Loader parity: both loaders produce identical `ValetPlugin[]` for the same plugin set (fixture assertion).
- Per-port: mocked-fetch request-shape + response-mapping tests per action (happy + one error), credential key-mapping test, and a body-diff review gate (reviewer confirms execute logic moved verbatim).
- Catalog integration: `list_tools` lists ported actions with correct schemas; `call_tool` executes with bridged context; unavailable credentials mark actions visible-but-unavailable.
- Trigger contract: verify-before-parse enforced (unverified request never reaches `toSignal`), fixture webhooks for the GitHub parsers.

## Risks

- **Verbatim-body rule erosion:** subagents "improving" logic during ports is the main quality risk — the per-plugin review explicitly diffs bodies against legacy and rejects non-type changes.
- **Credential key-map drift:** a wrong mapping fails at first real use, not in mocked tests; Wave 2's real-credential dogfood on 2–3 services is the mitigation, and declarations make the expected keys auditable.
- **Legacy worker pin:** in-place conversion breaks the frozen worker's plugin imports; any future legacy deploy builds from the pre-conversion pin, with cherry-picks per case. This is accepted — the worker was already frozen.

## Implementation notes (2026-07-14)

Recorded during implementation (Task 14: content-plugin manifests, tree cleanup, SDK legacy deletion, worker typecheck exclusion). These are decisions made while executing this spec, not changes to the spec's scope.

- **`transports` deferred to Phase 7.** `ValetPlugin` has no `transports` field today — the v2 `ChannelTransport` contract doesn't exist in code yet. Telegram's manifest (`packages/plugin-telegram/src/plugin.ts`) is a stub (`{ name, version, description }`, `enabled: false` in `plugin.yaml`) so the package is loader-visible without shipping an empty/misleading entry in the bundled registry; Phase 7 adds the transport contract and flips `enabled` on.
- **`TriggerDef.verify` may be async.** The spec's earlier sketch showed a synchronous signature; GitHub HMAC verification (`crypto.subtle`/node `crypto`) is naturally async, and nothing downstream requires sync, so `verify` returns `Promise<boolean> | boolean`.
- **MCP plugins use the `ActionPlugin.resolveActions` dynamic seam**, not a static `actions` array: `resolveActions(ctx: { credentials: CredentialProvider })` is invoked lazily by `list_tools`/`call_tool`, cached per catalog instance (i.e. per session — no cross-user leakage) with a short TTL, and instantiated fresh per session rather than shared globally. This is how `mcpActionPlugin` (`packages/sdk/src/mcp/action-plugin.ts`) replaces the legacy `McpActionSource` (deleted this task).
- **Connect UX is manual token entry for this phase.** Users paste a token/API key per service; there is no OAuth client/redirect/consent flow yet. OAuth lands with the separate auth/login design pass — the "connect one OAuth service" style exit criteria in this plan are satisfied by pasting an OAuth access token directly, not by driving a real OAuth dance.
