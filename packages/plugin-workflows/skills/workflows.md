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
- `workflows.create_trigger` / `workflows.list_triggers` / `workflows.delete_trigger` — run a workflow automatically on matching events (event-driven only; no cron yet). Event data arrives as `{{trigger.data.payload...}}`.

Always surface returned `workflowId`/`runId` values — the chat UI uses them to render the diagram and run status.

## Definition format (dag/v1)

```json
{
  "version": "dag/v1",
  "nodes": [
    { "id": "start", "type": "trigger" },
    { "id": "greet", "type": "set", "values": { "greeting": "hello" } },
    { "id": "gate", "type": "approval", "prompt": "Proceed with the demo?" },
    { "id": "haiku", "type": "llm", "model": "claude-sonnet-4-6", "prompt": "Write a haiku about {{greet.greeting}}" },
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

- `trigger` — entry point; exactly one per workflow
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

## Working practices

- `save_workflow` runs a full linter over the definition: field shapes per node type (with did-you-mean hints), template syntax, `nodes.<id>` references, edge semantics, reachability, model ids, and tool service/actions. On error it returns a bulleted list — fix each item and retry; never save around validation.
- Fields live FLAT on the node (`model`, `prompt`, `values`, …) — never nested under a `config` object.
- Read node outputs in templates as `{{nodes.<id>.result...}}`; trigger data as `{{trigger.data...}}`. Node ids containing `-` need bracket form: `nodes["my-id"].result`.
- To modify a workflow: `get_workflow` first, edit the returned definition, then `save_workflow` with the same `workflow_id`. Updates never affect in-flight runs (runs snapshot their definition at start).
- After `start_run`, use `get_run` to report progress. `status: "parked"` with an approval in `waitingOn` means a human must approve — tell the user and point them at the approval card; you cannot approve on their behalf.
- A run is finished when `status: "settled"`; report the `outcome`.
