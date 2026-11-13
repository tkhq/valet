# Canonical action ids

Status: implemented (Phase 1). Phase 2 is a proposal.

## Problem

An action has more than one spelling, and different code paths read the spelling differently.

A plugin declares each action with an id. The canonical id (`qualifiedActionId`) keeps a declared id that has a dot and prefixes a bare id with the service. Three bundled plugins declare ids that start with a product name, not with their service:

| Plugin service | Declared id prefix | Example canonical id |
|---|---|---|
| `google_workspace` | `docs.`, `drive.`, `sheets.`, `slides.` | `sheets.write_spreadsheet` |
| `google_calendar` | `calendar.` | `calendar.list_events` |
| `slack-user` | `slack_user.` | `slack_user.search` |

The router (`parseToolId`) and the engine catalog also accept the service-prefixed spelling, `google_workspace.sheets.write_spreadsheet`. Before this change, about 15 call sites guessed the canonical id with `id.includes(".") ? id : service + "." + id`. Two sites found the service of a scope entry from the text before the first dot. Tool scopes and grants compared raw strings.

So each spelling broke a different path:

- **Service-prefixed spelling in a step scope** (`google_workspace.sheets.write_spreadsheet`): the sandbox route passed, then the invoker computed the canonical id `sheets.write_spreadsheet` and refused it as "outside this task's tool scope". This failure stopped a scheduled Google Sheets workflow for four days in November 2026.
- **Canonical spelling in a step scope** (`sheets.write_spreadsheet`): the permission review and step grants read the service as `sheets`, so the credential service and the grant were wrong.
- **Service wildcard** (`google_workspace.*`): `actionInScope` matched no `sheets.*` action, so the wildcard allowed none of the service's own actions.

## How other agents name tools

- **Codex** (openai/codex, `codex-rs`) stores each tool as a structured identity: the server key and the raw tool name, recorded at registration. It never parses a qualified name back into parts. Calls route through a map keyed by that structure. Allow lists are nested per server and match the raw tool name only.
- **Claude Code** names tools `mcp__<server>__<tool>` and matches permission rules on that string. Its docs record the same class of ambiguity: a server named `reports__v2` reads as a server named `reports`.

The lesson is the same in both: compute an identity once from the registry, and never recover the parts from a string.

## Phase 1 (this change)

1. **One rule builds the canonical id.** `@valet/shared` `qualifiedActionId(service, declaredId)` replaces every inline copy in `api` and `engine`.
2. **The registry resolves spellings.** `actionIdResolver(actionPluginByService)` (`packages/api/src/plugins/action-id.ts`) maps the canonical id, the service-prefixed id, and the `list_tools` service spelling (`slack_user` for `slack-user`) to `{ service, canonical }`. A runtime (`resolveActions`) service resolves any `service.tool` spelling. The resolver takes each candidate service from the registry. It does not split on a dot to guess one.
3. **Scopes hold canonical ids before any check reads them.** `canonicalizeToolScope` rewrites exact entries to canonical ids. It expands `service.*` to `service.*` plus the exact canonical ids of the service's foreign-prefixed actions, so `google_workspace.*` covers `sheets.write_spreadsheet` and no other plugin's actions. An entry the resolver does not know stays as written, so it can only narrow. `workflowStepToolScope` canonicalizes the run ceiling and the step before it intersects them. The sandbox route canonicalizes the session and thread scopes and the requested action. The invoker and the workflow `invokeAction` port compare canonical ids.
4. **Services come from the registry.** `entryService`, the permission review (`agentStepRefs`, `workflowCredentialServices`), and step grants resolve the owning service through the resolver.
5. **Saves store canonical ids and refuse unknown ones.** `createWorkflowDefinition` and `updateWorkflowDefinition` run `canonicalizeDefinitionScopes`. An exact scope entry that no registered service claims fails the save with a `ValidationError` that names the step and the fix. Such an entry allows nothing, so before this change the step failed only at run time.

6. **One resolver for the api and the engine (2026-11-13).** Phase 1 left the agent path out. The engine compared its own canonical id with the scope as written, so a thread focus or a delegated task scoped to `google_workspace.*` refused `sheets.write_spreadsheet`. Now:
   - `@valet/shared` `buildActionIdResolver` is the one implementation. `actionIdResolver` builds it from the plugin map, and the engine's `catalogActionIdResolver` builds it from the catalog. It also accepts the service with the action's last segment when exactly one of the service's actions ends with it (`google_calendar.list_events`). That rule came from the engine's former `canonicalActionId`, which this change deletes.
   - `Thread.effectiveToolScope` and `Thread.toolScopeCeiling` canonicalize each layer (session, submission, continuation, thread focus) before the layers intersect. Every tool context reads its scope through them.
   - The `task` tool canonicalizes the requested scope (`ToolContext.canonicalToolScope`) before it meets the ceiling. The child spawner canonicalizes each stored layer with the registry resolver (`ChildrenDeps.actionIds`).

Stored policies, grants, and audit rows already use the canonical form, so Phase 1 needs no data migration. A saved definition with the prefixed spelling still works, because readers canonicalize it. The next save rewrites it.

### Tests

- `packages/shared/src/action-id.test.ts`: the canonical rule, scope canonicalization, and every spelling `buildActionIdResolver` accepts.
- `packages/engine/test/tool-scopes.test.ts`: a thread focus that names the action as `google_workspace.*`, the service-prefixed id, or the canonical id allows a call under another spelling. The first two cases fail on the code before item 6.
- `packages/api/src/plugins/action-id.test.ts`: every spelling, wildcard expansion, save validation, and a check over every bundled action. For each action, the canonical and service-prefixed spellings resolve to the same owner, a scope that names either allows the action, and `service.*` allows it.
- `packages/api/src/routes/sandbox-actions.test.ts`: the regression test for that failure. A step that allows `google_workspace.drive.search_files` calls the action under both spellings. This test fails on the code before this change.

## Phase 2 (proposal)

Make the identity structural, as Codex does:

1. Validate at registration that a declared id is bare or starts with `${service}.`. Rename the three plugins' ids to that form, and keep the old ids as registry aliases.
2. Store scope entries and grants as `{ service, action }` pairs, or keep the flat string but always with the service prefix, so that the text before the first dot is always the service.
3. Migrate stored policies, grants, and workflow definitions to the new form in one pass, and keep the resolver for old spellings in model output and memory.

Phase 2 removes the foreign-prefix wildcard expansion and lets any reader find the service without the registry.
