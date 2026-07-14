# Plugin System v2 — Design Spec

> Defines how the existing plugin library (`packages/plugin-*`, ~56 actions across 14 services, 2 channel plugins, ~10 content skills) moves onto the v2 engine: the `ValetPlugin` manifest contract, the fleet port of actions to engine-native shapes (no compat adapter), channel-transport rewrites, trigger and credential-declaration contracts, and dual loading (bundled registry + dynamic node_modules). Also resequences the local-E2E roadmap: platform (auth + plugins) lands after workflows; Telegram ships as the first v2 channel plugin.

## Scope

Covers: the v2 plugin manifest and entry-point convention; the action port (Zod `ActionSource` → engine `ActionPlugin`); channel-transport migration strategy; content plugins (skills/personas) mapping; the trigger contract; credential declarations; the two loaders; per-plugin migration mechanics and sunset rules; roadmap resequencing.

Does NOT cover: OAuth/connect flow implementation, token storage UI, consent screens (platform/login spec); the HTTP webhook ingress route and trigger routing (lands with its consumers — workflows and channels); the Telegram/Slack transport implementations themselves (their phases); legacy worker changes (frozen until sunset).

## Background

Two plugin systems exist today:

- **Legacy (`@valet/sdk`)**: Zod-based `ActionSource` (`listActions`/`execute` with a flat resolved-credentials `ActionContext`), message-relay `ChannelTransport`, webhook trigger parsers, content files delivered to sandboxes. Compiled into the worker via `make generate-registries`. Serves production until worker sunset.
- **Engine v2 (`@valet/engine`)**: `plugin-catalog.ts` defines the engine-native `ActionPlugin`/`PluginAction` (TypeBox parameters, `ToolContext`-derived `PluginActionContext`, `ToolAttachment` results) exposed via `list_tools`/`call_tool` indirection, and explicitly does not accept legacy shapes. The engine spec defines the v2 `ChannelTransport` contract (verified ingress → conversationKey → `SignalContent`), `SkillSource`, `RoleSpec`, `CommandToolDef`, and `CredentialStore`.

Decision (with the user): **no compat adapter**. All action plugins are ported engine-native in one subagent-fleet wave. Channels are rewritten to the v2 contract (payload helpers salvaged). Legacy code paths stay in place, untouched, solely for the worker until sunset.

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

**Entry-point convention:** a v2 plugin package declares `"valet": { "plugin": "./dist/plugin.js" }` in `package.json`; that module's default export is a `ValetPlugin` (or a `() => ValetPlugin | Promise<ValetPlugin>` factory for plugins needing async assembly). The source convention is `src/v2.ts` (or `src/plugin.ts`) building the manifest; legacy `src/actions/`, `src/channels/` remain for the worker and are ignored by v2 loaders.

`plugin.yaml` gains a `v2: true|false` flag. Empty scaffolds and retired plugins mark `v2: false` and are skipped by both loaders. `plugin-memory-compaction` is retired outright (v2 compaction hooks + the memory service replaced it).

## Actions: the Fleet Port

Every action-bearing plugin is ported engine-native in one wave, one subagent task per plugin, each with its own review gate. The port is a **mechanical transform with a preservation rule**:

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

The legacy message-relay transport and the v2 contract (verified ingress before parsing → conversationKey codec → `SignalContent` admission with `dispatchId` = provider event id → outbound send → gate delivery with inline buttons and edit-on-resolution) share no seam worth adapting. Each channel plugin gains `src/transport/` implementing the v2 contract, lifting payload-level modules (Telegram Bot API client, Slack block rendering, file handling) verbatim. Telegram is rewritten in its roadmap phase (the first v2 channel plugin); Slack follows. Until then, channel plugins load in v2 with `transports: []` and their actions/content only.

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

## Migration Mechanics and Sunset Rules

1. **Wave 0 (framework):** `ValetPlugin` type + manifest validation schema in `@valet/engine`; both loaders + assembler in `packages/api`; `generate-registries` v2 target; orchestrator/session wiring (catalog tools + content into `EngineHost` session options).
2. **Wave 1 (fleet port):** one subagent task per action-bearing plugin (github, slack-actions, gmail, google-calendar, google-workspace, cloudflare, deepwiki, figma, linear, notion, sentry, stripe, typefully, browser/sandbox-tunnels/workflows content) — each: `src/v2.ts` manifest, TypeBox schemas, verbatim bodies, credential key mapping, mocked-fetch tests, per-plugin review.
3. **Wave 2 (integration):** orchestrator dogfood with real credentials for 2–3 services; `list_tools`/`call_tool` end-to-end; unavailable-credential UX.
4. **Channel transports:** Telegram in its roadmap phase, Slack after.
5. **Sunset:** when the legacy worker retires, delete `src/actions/`+`src/channels/` legacy trees, the SDK's Zod `ActionSource`/channel contracts, and the worker registries. Until then legacy code is frozen — bugfixes land in the v2 port; backporting is per-case and explicit.

New plugins author engine-native from day one; the Zod contract accepts no new plugins effective immediately.

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
- **Dual-tree period:** legacy and v2 action trees coexist until sunset; the freeze rule (bugfixes land v2-first) prevents silent divergence.
