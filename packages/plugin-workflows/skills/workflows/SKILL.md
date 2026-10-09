---
name: workflows
description: Valet DAG workflow operations. Use when creating, updating, inspecting, or running workflows; when checking run progress; or when a run is waiting on an approval gate.
---

# Workflows

Workflows are dag/v1 definitions: a flat list of `nodes` plus directed `edges`. Runs execute on the server's checkpointed interpreter — they park on waits/approvals and resume on signals. Users see workflows as node diagrams in chat and at `/workflows`.

## Use the workflow tools, not raw API calls

Discover them with `list_tools` (service `workflows`), invoke with `call_tool`:

- `workflows.list_workflows` — list definitions (id, name)
- `workflows.get_workflow` — full definition by id
- `workflows.save_workflow` — create (omit `workflow_id`) or update (pass it)
- `workflows.patch_workflow` — small edits without re-sending the definition: rename, upsert/remove single nodes, add/remove edges (result is fully linted)
- `workflows.update_model` — set an approved model or org size tier on selected `llm` and `session` nodes
- `workflows.delete_workflow` — permanently delete a definition (refused while runs are active; settled history is kept). Team deletion requires a current admin in direct web chat.
- `workflows.request_workflow_deletion` — open or reuse a team workflow deletion request for admin review. Requires a signed-in person in direct web chat. This does not delete the workflow.
- `workflows.start_run` — start a run; returns `runId`
- `workflows.get_run` — run status, per-node checkpoints, pending waits
- `workflows.get_node_result` — a node's FULL checkpoint output, for debugging failures
- `workflows.list_runs` — a workflow's runs (find parked/active ones)
- `workflows.cancel_run` — terminate a run (settles asynchronously; re-check with `get_run`)
- `workflows.resolve_approval` — approve/deny a gate, ONLY when the user has explicitly told you their decision (the call itself asks the user to confirm)
- `workflows.list_event_types` — event keys workflows can be triggered by
- `workflows.create_trigger` / `workflows.list_triggers` / `workflows.delete_trigger` — run a workflow automatically on matching events. Event data arrives as `{{trigger.data.payload...}}`.
- `workflows.create_schedule` / `workflows.list_schedules` / `workflows.delete_schedule` — cron schedules (5-field cron + IANA timezone, ~30s fire accuracy; downtime collapses to one catch-up run). Target a WORKFLOW (`workflow_id`; static `input` arrives as `{{trigger.data.input...}}`) or the ORCHESTRATOR (`prompt`: you receive the prompt each fire — use this for recurring assistant tasks like "review my inbox each morning").

Always surface returned `workflowId`/`runId` values — the chat UI uses them to render the diagram and run status.

## Definition format (dag/v1)

```json
{
  "version": "dag/v1",
  "nodes": [
    { "id": "start", "type": "trigger" },
    { "id": "greet", "type": "set", "values": { "greeting": "hello" } },
    { "id": "gate", "type": "approval", "prompt": "Proceed with the demo?" },
    { "id": "haiku", "type": "llm", "model": "s", "prompt": "Write a haiku about {{nodes.greet.result.greeting}}" },
    { "id": "done", "type": "stop", "outcome": "completed" }
  ],
  "edges": [
    { "from": "start", "to": "greet" },
    { "from": "greet", "to": "gate" },
    { "from": "gate", "to": "haiku" },
    { "from": "haiku", "to": "done" }
  ]
}
```

Node types:

- `trigger` — entry point; exactly one per workflow; optional `dataSchema` declares the run's inputs (see Trigger data)
- `set` — bind values into run state
- `if` — conditional; outgoing edges use `"fromOutput": "true"` / `"false"`
- `wait` — pause for a duration (`{ "mode": "duration", "duration": "5m" }`)
- `approval` — park until a human approves/denies (`prompt`, optional `summary`, `details`, `timeout`, `onDeny`)
- `session` — start an agent session with a `prompt` (optional `title`, `model`, `outputSchema`, `wait`, `files`)
- `orchestrator` — prompt the workspace assistant in a durable workflow thread (optional `outputSchema`, `wait`, `files`). The app labels this step "Thread".
- `tool` — invoke a plugin action (`service`, `action`, `params`)
- `llm` — one-shot LLM call (`model`, `prompt`, optional `system`, `outputSchema`)
- `foreach` — iterate `items` over `body` nodes (optional `maxItems`, `concurrency`)
- `stop` — terminal node (`outcome`, optional `output`, `message`)

Edges may carry `"when"` (an expression) to gate a branch.

## Pass data to an agent step as files

Use `files` on `session` and `orchestrator` nodes instead of pasting data into prompts.
The host writes the files before the first turn. The prompt receives absolute paths and byte sizes.
Tell the agent to read those files. Do not ask it to retype the data.

```json
{
  "id": "build", "type": "session", "mode": "start",
  "prompt": "Build the dashboard from the input files listed below.",
  "files": {
    "jobs.json": "{{nodes.jobs.result.data}}",
    "scorecards.json": "{{nodes.scorecards.result.items}}",
    "notes.md": "Run for {{trigger.data.team}}"
  }
}
```

Keys are literal, normalized relative paths. Use `/` between segments of letters, digits, dots, underscores, and hyphens.
Do not use templates, dot segments, empty segments, absolute paths, or backslashes in keys.
Do not define a file and its child path (`a` and `a/b`).
Values are template strings. A single expression preserves its type: strings are UTF-8 text; other values become pretty-printed JSON.
Missing paths follow `policy.onUnresolvedPath`: `empty` uses the existing empty/null rendering; `fail` stops the node before dispatch.
A foreach body can use `item` and `index` in values. Each iteration has its own directory.
The host scopes directories by run, node, and iteration. Limits are 100 files, 10 MiB per file, and 25 MiB total.
Inputs are ephemeral. The host removes them when the consuming step settles and removes the run directory on every settlement outcome.
Use the default `until_idle` wait mode. `files` cannot use `wait.mode: "none"` because settlement would remove data before consumption.
A bounded sweep removes crash leftovers older than 7 days. Cleanup failures are logged without failing the run.
Shared legacy team sandboxes and unverifiable audiences cannot receive files. Use a session step or start a new private thread.
Provisioning and transport failures retain normal retries. Before admission, retries replace incomplete inputs atomically.
After admission, duplicate dispatch skips all file operations, even if the agent edited or deleted an input.
Personal roots allow the owner's own linked DMs. Archived conversations and settled workflow-run threads do not block files.
Active shared channels, group DMs, and DMs with known other participants block files.
The host uses durable authors and identity links. Without participant data, only non-DM conversations count as shared.
The error is: "Workflow files cannot be delivered to a personal sandbox with another participant. Use a session step or archive the shared conversation."
Cleanup never wakes a sandbox. Skips emit a warning and `valet.workflow.inputs.cleanup_skipped`.
Residual sweeps protect only live runs with the same org and owner. Foreign runs count as absent.
Sweeps apply a seven-day floor to absent or settled runs. Without another file write, residual inputs persist until sandbox destruction.
`llm` and `tool` nodes do not accept `files`.

## Model selection

Use a size tier (`xs`, `s`, `m`, `l`, or `xl`) when the org should control the concrete model. Use an approved catalog id when the workflow needs a fixed model. An `llm` node requires `model`. A `session` node uses its `model` when set and otherwise uses the session default. An `orchestrator` node has no model field. It uses the workspace assistant's saved model. Its result includes `threadId` in both dispatch-only and settled modes. `update_model` changes `llm` and `session` nodes only, including a `foreach` body.

## Templates: reading data between nodes

Templates are `{{path}}` reads over `{ trigger, nodes }`. Property paths drill into objects and arrays: `{{nodes.fetch.result.runs[0].id}}`.

**Node outputs.** A completed node's checkpoint result is `nodes.<id>.result` (`.output` is a legacy alias for the same value). Nothing else exists under a node id — the linter rejects any other segment. Result shapes by node type:

- `set` — the rendered `values` object itself. `{ "values": { "owner": "tkhq" } }` → `{{nodes.x.result.owner}}` (NOT `.values.owner`).
- `tool` — the action's data, verbatim. Check the shape with `get_node_result` on a real run.
- `llm` — `{ text, output?, usage }`. The raw completion is `{{nodes.x.result.text}}`; with `outputSchema` set, the parsed object is `{{nodes.x.result.output...}}`.
- `if` — `{ result: boolean }`; `approval` — `{ approved: boolean, ... }`; `foreach` — `{ items: [{ status, data }...], completedCount, ... }` (per-item data at `result.items[0].data`).
- `stop` — `{ outcome, output? }` with `output` rendered.

**Trigger data.** `trigger` is the run's start envelope: `{ type, timestamp, data, metadata }`. What `trigger.data` holds depends on how the run started:

- `start_run` (manual): the `input` you passed → `{{trigger.data.<field>}}`.
- Event trigger: `{ key, summary, refs, payload }` — `payload` is the provider's event body. GitHub example: `{{trigger.data.payload.pull_request.number}}` (single `payload`, then GitHub's own webhook shape).
- Webhook: the raw JSON POST body.
- Schedule: `{ scheduleName, cron, input }` → static input at `{{trigger.data.input...}}`.

**Declared trigger inputs (`dataSchema`).** When a workflow expects manual input, declare it on the trigger node instead of documenting it in prose. `dataSchema` (NOT `inputSchema` — it is a field map, not a JSON Schema) maps each input field to `{ type, required?, default?, description?, enum?, label?, placeholder?, hidden? }` with `type` one of `string | number | boolean | object | array` (`integer` is an accepted alias for `number` and adds no integer-only check, so a non-integer value like `7.5` is accepted):

```json
{ "id": "start", "type": "trigger", "dataSchema": {
  "owner": { "type": "string", "required": true, "description": "GitHub org or user" },
  "number": { "type": "number", "required": true, "label": "PR number" }
} }
```

`start_run` validates its `input` against the schema (defaults merge in, missing required fields and type mismatches are rejected with per-field errors), and the web UI's Run button opens a form generated from it. Declare a `dataSchema` whenever downstream nodes read `{{trigger.data.<field>}}` from manual runs — it turns a silent `null` render into a named validation error.

**Rendering rules.** A field that is exactly one `{{...}}` keeps the value's type (objects/arrays/numbers survive). Mixed text stringifies each expression. A path that resolves to nothing renders as `null` in a single-template field and `""` in mixed text — the save-time linter and the run-time error messages both name bad paths, but a syntactically-valid path to a missing key only surfaces at run time. When a tool param fails validation ("must be string"), suspect a template that rendered null; the node error lists the unresolved paths.

**Structured LLM output.** Give `llm` (and `session`/`orchestrator`) nodes an `outputSchema` (JSON Schema object). The runtime parses and validates the response, retries once with a repair prompt on mismatch, and puts the parsed object at `result.output`. Use this instead of prompt-engineering JSON or chaining a second extraction LLM node.

**Distinguish empty inventory from failed inspection.** A schema-valid empty array does not prove that inspection succeeded. If that distinction matters, require an explicit inspection status and evidence, such as inspected sources and failures. Branch incomplete or failed inspection to review or failure before consuming candidates. Never use `candidates: []` as a fallback for failed inspection. Format repair must reuse successful tool results without repeating actions with side effects.

**Let the model abstain.** When an `outputSchema` field feeds a tool param, a required plain string forces the model to invent a value it does not have ("Unable to determine…" as a GitHub username) — and the invented value fails nodes later, at the tool, with a confusing API error. Give the field an explicit abstain value (`""`, or an enum member like `"none"`), tell the prompt when to return it, and branch on it with `when`-guarded edges to a stop node:

```json
{ "id": "pick", "type": "llm", "model": "xs",
  "prompt": "... Return an empty assignee when the data does not name one.",
  "outputSchema": { "type": "object", "properties": { "assignee": { "type": "string" } }, "required": ["assignee"] } }
```

The schema alone does not enforce abstention — it still requires a string — so keep both halves: the abstain value the schema accepts and the prompt line that says when to return it. Drop either and the model invents a value again.

```json
{ "from": "pick", "to": "assign", "when": "nodes.pick.result.output.assignee" },
{ "from": "pick", "to": "no_assignee", "when": "!nodes.pick.result.output.assignee" }
```

For list-shaped output, abstain with an empty array and gate on `if` with `lengthGreaterThan`.

## Working practices

- `save_workflow` runs a full linter over the definition: field shapes per node type (with did-you-mean hints), template syntax, `nodes.<id>` references and segments, edge semantics, reachability, model ids, tool service/actions, and tool `params` keys against the action's own parameter schema (missing required parameters and unknown parameter names, with did-you-mean hints; templated values are never type-checked). On error it returns a bulleted list — fix each item and retry; never save around validation.
- Fields live FLAT on the node (`model`, `prompt`, `values`, …) — never nested under a `config` object.
- Node ids containing `-` need bracket form in templates: `nodes["my-id"].result`.
- To modify a workflow: `get_workflow` first, edit the returned definition, then `save_workflow` with the same `workflow_id`. Updates never affect in-flight runs (runs snapshot their definition at start) — a parked run can be waiting on a node from an OLDER definition version; read the run's own checkpoints, not the current definition.
- After `start_run`, use `get_run` to report progress. `status: "parked"` with an approval in `waitingOn` means a human must approve — tell the user and point them at the approval card; you cannot approve on their behalf.
- `tool` nodes can park WITHOUT an approval node in the definition: when org policy resolves the action to require_approval, the node raises a policy gate and parks on `approval:<nodeId>` until a human resolves it (optional `approvalTimeout`, `onDeny` on the tool node). `list_runs` shows each parked run's `waitingOn`.
- Debug a surprising node with `get_node_result` — it returns the checkpoint result verbatim, the same value templates read via `nodes.<id>.result` (oversized results come back as `{ truncated: true, jsonPrefix }`).
- A run is finished when `status: "settled"`; report the `outcome`.


### Team workflow deletion

An ordinary tool approval does not grant team administration rights. In direct web
chat, `delete_workflow` checks the authenticated author's current admin role.
Members use `request_workflow_deletion` with the exact `workflow_id` and an optional
`reason`. Report its `deleted: false` and pending status accurately. The returned
`reviewUrl` opens team settings, where an admin decides the request.

Automated workflows, child sessions, signals, and unlinked channel senders cannot
borrow a creator's admin role or submit a deletion request as that person. Ask a
signed-in person to continue in web chat or team settings. Do not repeat an
ordinary tool approval as a substitute for the resource's admin check.

### Slack sender identity

Set top-level `definition.presence: { displayName: "Hestia · People", avatarUrl: "<supplied HTTPS URL>" }`.
Omit `avatarUrl` if no image was supplied. `patch_workflow` accepts `presence` directly; `null` clears it.
For an uploaded photo, call `profile_pictures.publish_avatar` in its chat and save the returned `avatar_url` as `presence.avatarUrl`.
An event subscription's `target.presence` overrides individual workflow fields. Unset fields inherit the workflow, then workspace default.
Tool steps, agent tool calls, automatic replies, and approval cards inherit this identity without extra prompt instructions or `set` nodes.
Explicit Slack `sender_name` / `sender_avatar_url` arguments still override one message; use them only for deliberate exceptions.
These settings customize messages, not the Slack account or DM conversation. See the `slack-tools` skill.

For an existing event subscription, call `events.list_subscriptions` in its personal or team workspace.
Use the exact `name` filter or follow `nextOffset` with `offset` to find its ID.
Call `events.set_subscription_presence` with `subscription_id` and `presence: { displayName?, avatarUrl? }`.
This replaces the override. Send `presence: null` to clear it. The tool preserves matching rules, target, and enabled state.
`workflows.create_trigger` and `workflows.propose_trigger` also accept optional `presence`.
