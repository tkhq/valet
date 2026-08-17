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
- `workflows.delete_workflow` — permanently delete a definition (refused while runs are active; settled history is kept)
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
    { "id": "haiku", "type": "llm", "model": "claude-sonnet-4-6", "prompt": "Write a haiku about {{nodes.greet.result.greeting}}" },
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
- `session` — start an agent session with a `prompt` (optional `title`, `model`, `outputSchema`, `wait`)
- `orchestrator` — prompt the user's orchestrator (optional `outputSchema`, `wait`)
- `tool` — invoke a plugin action (`service`, `action`, `params`)
- `llm` — one-shot LLM call (`model`, `prompt`, optional `system`, `outputSchema`)
- `foreach` — iterate `items` over `body` nodes (optional `maxItems`, `concurrency`)
- `stop` — terminal node (`outcome`, optional `output`, `message`)

Edges may carry `"when"` (an expression) to gate a branch.

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

**Declared trigger inputs (`dataSchema`).** When a workflow expects manual input, declare it on the trigger node instead of documenting it in prose. `dataSchema` (NOT `inputSchema` — it is a field map, not a JSON Schema) maps each input field to `{ type, required?, default?, description?, enum?, label?, placeholder?, hidden? }` with `type` one of `string | number | boolean | object | array`:

```json
{ "id": "start", "type": "trigger", "dataSchema": {
  "owner": { "type": "string", "required": true, "description": "GitHub org or user" },
  "number": { "type": "number", "required": true, "label": "PR number" }
} }
```

`start_run` validates its `input` against the schema (defaults merge in, missing required fields and type mismatches are rejected with per-field errors), and the web UI's Run button opens a form generated from it. Declare a `dataSchema` whenever downstream nodes read `{{trigger.data.<field>}}` from manual runs — it turns a silent `null` render into a named validation error.

**Rendering rules.** A field that is exactly one `{{...}}` keeps the value's type (objects/arrays/numbers survive). Mixed text stringifies each expression. A path that resolves to nothing renders as `null` in a single-template field and `""` in mixed text — the save-time linter and the run-time error messages both name bad paths, but a syntactically-valid path to a missing key only surfaces at run time. When a tool param fails validation ("must be string"), suspect a template that rendered null; the node error lists the unresolved paths.

**Structured LLM output.** Give `llm` (and `session`/`orchestrator`) nodes an `outputSchema` (JSON Schema object). The runtime parses and validates the response, retries once with a repair prompt on mismatch, and puts the parsed object at `result.output`. Use this instead of prompt-engineering JSON or chaining a second extraction LLM node.

## Working practices

- `save_workflow` runs a full linter over the definition: field shapes per node type (with did-you-mean hints), template syntax, `nodes.<id>` references and segments, edge semantics, reachability, model ids, and tool service/actions. On error it returns a bulleted list — fix each item and retry; never save around validation.
- Fields live FLAT on the node (`model`, `prompt`, `values`, …) — never nested under a `config` object.
- Node ids containing `-` need bracket form in templates: `nodes["my-id"].result`.
- To modify a workflow: `get_workflow` first, edit the returned definition, then `save_workflow` with the same `workflow_id`. Updates never affect in-flight runs (runs snapshot their definition at start) — a parked run can be waiting on a node from an OLDER definition version; read the run's own checkpoints, not the current definition.
- After `start_run`, use `get_run` to report progress. `status: "parked"` with an approval in `waitingOn` means a human must approve — tell the user and point them at the approval card; you cannot approve on their behalf.
- `tool` nodes can park WITHOUT an approval node in the definition: when org policy resolves the action to require_approval, the node raises a policy gate and parks on `approval:<nodeId>` until a human resolves it (optional `approvalTimeout`, `onDeny` on the tool node). `list_runs` shows each parked run's `waitingOn`.
- Debug a surprising node with `get_node_result` — it returns the checkpoint result verbatim, the same value templates read via `nodes.<id>.result` (oversized results come back as `{ truncated: true, jsonPrefix }`).
- A run is finished when `status: "settled"`; report the `outcome`.
