---
name: workflows
description: Valet DAG workflow operations. Use when creating, updating, inspecting, or running workflows; when checking run progress; or when a run is waiting on an approval gate.
---

# Workflows

For a failure, unexpected output, missing data, or a missing report, load `workflow-troubleshooting` first.
Select repair focus before editing. Before an authorized test, select validate with the exact actions and native tools needed.
Focused discovery returns summaries. Use `list_tools` with `detail: "schema"` and an exact query to read parameters.
Select general focus when the person changes to another task. Existing approval policies always apply.

Workflows are dag/v1 definitions: a flat list of `nodes` plus directed `edges`. Runs execute on the server's checkpointed interpreter — they park on waits/approvals and resume on signals. Users see workflows as node diagrams in chat and at `/workflows`.

## Design the steps

Split the job by what each part needs. A workflow that does everything in one agent step fails in ways that are hard to see.

- Put an integration call with known inputs in a `tool` step. Put judgment in an `llm` step or an agent step (`session` or `orchestrator`). Put shell work, scripts, and data jobs with many calls in a `session` step.
- Put every action that a person approves on each run in a `tool` step. Policy stops that step for approval on each run. For a sign-off that no action covers, add an `approval` step before the work. Never tell an agent step to ask for approval, to wait for a person, or to tell someone that an approval is ready: a run refuses the request, and nobody gets a card.
- Publish a page or file from the step that writes it: `artifact_publish` with `path`, or `file_attach`. Pass only the URL, size, and hash to later steps. Never pass page content, base64, or chunks through a step's output, because a model copy corrupts them.
- For a list of unknown size, list the items in one step with an `outputSchema` array, handle one item in each iteration of a `foreach` step, then combine the results in a later step.
- Use `{{trigger.timestamp}}` for the run's date. Never write today's date into a prompt.
- Write team memory from an `orchestrator` step; a `session` step has no memory tools. Use the sandbox actions API only from a `session` step; an `orchestrator` step is refused.
- After each save, run `preview_workflow`. Fix each step warning it reports, or tell the person why it does not apply.

## Use the workflow tools, not raw API calls

Discover them with `list_tools` (service `workflows`), invoke with `call_tool`:

- `workflows.list_workflows` — list definitions (id, name)
- `workflows.get_workflow` — full definition by id
- `workflows.get_permissions` — each tool step's approval `mode` and the rule that set it (`provenance`), as the workflow page's Permissions section shows them
- `workflows.allow_permissions` — one approval card in which the person allows the steps that need approval and their shared accounts for every later run of the current steps
- `workflows.save_workflow` — create (omit `workflow_id`) or update (pass it)
- `workflows.patch_workflow` — small edits without re-sending the definition: rename, upsert/remove single nodes, add/remove edges (result is fully linted)
- `workflows.update_model` — set an approved model or org size tier on selected `llm` and `session` nodes
- `workflows.delete_workflow` — permanently delete a definition (refused while runs are active; settled history is kept). Team deletion requires a current admin in direct web chat.
- `workflows.request_workflow_deletion` — open or reuse a team workflow deletion request for admin review. Requires a signed-in person in direct web chat. This does not delete the workflow.
- `workflows.get_node_diagnostics` — trace selected response metadata and original or repair submissions
- `workflows.start_run` — start a run; returns `runId`
- `workflows.get_run` — run status, per-node checkpoints, pending waits
- `workflows.get_node_result` — a node's FULL checkpoint output, for debugging failures
- `workflows.list_runs` — a workflow's runs (find parked/active ones)
- `workflows.cancel_run` — terminate a run (settles asynchronously; re-check with `get_run`)
- `workflows.resolve_approval` — approve/deny a gate (an approval node, or a tool node that policy holds), ONLY when the user asks. Valet shows the user a card, and the gate resolves as the person who confirms it. Call it once per gate.
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
- `session` — start an agent session with a `prompt` (optional `title`, `model`, `outputSchema`, `maxModelCalls`, `wait`)
- `orchestrator` — prompt the workspace assistant in a durable workflow thread (optional `outputSchema`, `maxModelCalls`, `wait`). The app labels this step "Thread".
- `tool` — invoke a plugin action (`service`, `action`, `params`)
- `llm` — one-shot LLM call (`model`, `prompt`, optional `system`, `outputSchema`)
- `foreach` — iterate `items` over `body` nodes (optional `maxItems`, `concurrency`)
- `stop` — terminal node (`outcome`, optional `output`, `message`)

Edges may carry `"when"` (an expression) to gate a branch.

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

**Step budgets.** A `session` or `orchestrator` step stops after `maxModelCalls` model calls (default 150, at most 500) and fails with that reason. Do not raise the limit to fit a list of unknown size. List the items in one step with an `outputSchema` array, handle one item in each iteration of a `foreach` step, then combine the results in a later step. `preview_workflow` warns when a step asks one agent to handle every item in a list.

**Structured LLM output.** Give `llm` (and `session`/`orchestrator`) nodes an `outputSchema` (JSON Schema object). The runtime parses and validates the response, retries once with a repair prompt on mismatch, and puts the parsed object at `result.output`. Use this instead of prompt-engineering JSON or chaining a second extraction LLM node.

An incomplete or failed transport does not get schema repair. For awaited session and orchestrator submissions, adapted `length`, `error`, and `aborted` stops fail completion even when partial JSON validates. A clean-stop empty reply can be intentional silence without a schema. An awaited submission with a schema receives the existing one repair opportunity for that empty reply.

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

- Before you create a workflow, restate the plan in two or three lines: what starts it, what each step does and its step type (see Design the steps), and where the result goes. If a gap would change the build, such as which event, channel, repo, or account to use, call `ask_question` once with the plan as `detail` and the likely answers as `options`. Otherwise, build it and list what you assumed.
- `save_workflow` runs a full linter over the definition: field shapes per node type (with did-you-mean hints), template syntax, `nodes.<id>` references and segments, edge semantics, reachability, model ids, tool service/actions, and tool `params` keys against the action's own parameter schema (missing required parameters and unknown parameter names, with did-you-mean hints; templated values are never type-checked). On error it returns a bulleted list — fix each item and retry; never save around validation.
- Fields live FLAT on the node (`model`, `prompt`, `values`, …) — never nested under a `config` object.
- Node ids containing `-` need bracket form in templates: `nodes["my-id"].result`.
- To modify a workflow: `get_workflow` first, edit the returned definition, then `save_workflow` with the same `workflow_id`. Updates never affect in-flight runs (runs snapshot their definition at start) — a parked run can be waiting on a node from an OLDER definition version; read the run's own checkpoints, not the current definition.
- After `start_run`, read `followUp` and follow `next`. Promise an automatic reply only when `followUp.registered` is true. End your turn when the run reports here. Otherwise use `get_run` to check progress.
- After `resolve_approval`, follow the result's `next` field. Name any steps that still wait and who must approve each. If the run reports here, end your turn and continue from its signal. Do not poll a run that reports here. If the run reports elsewhere, use `get_run` to check its result.
- A `workflow.approval_needed` signal means a human must approve. A `workflow.settled` signal reports completion, failure, or cancellation. Read `get_run` and tell the user. If they ask you to approve, call `resolve_approval` once per gate. Each call shows a card and records the person who confirms it.
- `tool` nodes can park WITHOUT an approval node in the definition: when org policy resolves the action to require_approval, the node raises a policy gate and parks on `approval:<nodeId>` until a human resolves it (optional `approvalTimeout`, `onDeny` on the tool node). `list_runs` shows each parked run's `waitingOn`.
- Before you tell a user that a step needs approval, read `get_permissions`. Mode `allow` means no policy gates the step, whatever its risk level. A step with `sharedAccount: true` can ask the member whose shared account it uses on every run, unless a team 1Password item covers the service; a human can authorize their own shared accounts for this workflow through Review permissions, or connect an account owned by the team. With `runtimeParams: true`, a policy rule keys on a parameter the step fills in at run time, so a run can decide differently. Rows with `agentStep: true` are exact actions an agent step lists in `toolScope.actions`. A row with `granted: true` is already allowed by the workflow's saved permissions, even though its mode is `unknown`. Other agent-step calls and sub-workflow steps are checked when they run. To confirm, read a recent run's `waitingOn` with `get_run` or `list_runs`.
- No save allows anything: not a browser save, an assistant save, a copy, or a template install. Saved steps can come from untrusted content, so a person allows them explicitly, once, when the workflow is built. A save result lists `needsApproval` when steps wait for approval or use the person's shared accounts. Call `workflows.allow_permissions` once after the build and before a test run. It shows the person one card with those actions and accounts, and on approval allows them for the current steps. The person can also use Review permissions on the workflow page. Any later step change, by anyone, revokes those grants, and a run that started on other steps does not use them. A member can choose Allow my shared accounts without granting tool actions, or Remove my account permission to revoke only their own consent. Explicit policies and other members' account consent still apply. Reset saved permissions revokes workflow action and account grants.
- Runs never ask a person from an agent step: a run refuses `ask_approval` and `ask_question`. If the person wants to approve an action on every run, put that action in a `tool` node: it stops for approval on each run while policy requires approval. The person clicks Approve once on each run's card. Approve and stop asking ends the per-run ask. For a sign-off that no action policy covers, add an `approval` node. Never tell an agent step's prompt to ask for approval.
- A `session` or `orchestrator` step that sends, writes, or uses a teammate's shared account needs `toolScope.actions` with the exact action ids, such as `slack.send_message`. The permission review allows only exact entries; a `service.*` entry limits the step but allows nothing. Keep `service.*` for steps that only read. A run that an agent starts on its own, without the person's own signed-in prompt, uses no allowed permissions in its agent steps.
- If a step is `require_approval` from `risk_default` or `plugin_default`, the workflow owner or a team admin can allow it for every later run. They click "Approve and stop asking" on the run's approval card, or "Review permissions" in the workflow page's Permissions section. Review permissions cannot allow a `tool` step's MCP action, because `get_permissions` reports it as `unknown`; the run's card can. For a step on a member's shared account, that member can click "Always allow for this workflow" on the run's card. It covers later runs until the steps change. A workflow mirrored from a repository takes no such grant; change the policy instead.
- If the provenance is `org_policy`, only an org admin can change it, in Settings → Organization → Policies. For `team_policy`, a team admin changes the team's Policies page.
- A `session` step's script can call the same integrations its run can: POST `{"params": {...}}` to `$VALET_API_URL/api/sandbox/actions/<service.action>/invoke` with header `x-valet-sandbox` set from `/etc/valet/creds/token` (or `$VALET_SANDBOX_TOKEN`). The reply is `{status, result}`. Use it for data jobs with many calls; the script never holds a credential and has the step agent's permissions, no more. Add `"idempotencyKey"` to make a retry safe. If the reply is `in_progress`, the first call still runs; call again with the same key and params. An action that policy holds for approval is refused, so put it in a `tool` node instead.
- Debug a surprising node with `get_node_result` — it returns the checkpoint result verbatim, the same value templates read via `nodes.<id>.result` (oversized results come back as `{ truncated: true, jsonPrefix }`).
- To learn WHY a session or orchestrator step produced its result, read `get_node_transcript`: the prompt it received with templates filled in, its replies, each tool call with its result or error, and any format-repair prompt. `get_run` marks a step with `repairAttempted` and `schemaError` when its first reply failed the output schema. Page back with `before`. The transcript includes saved compaction summaries and flags synthetic continuation prompts. For clipped content, pass `message_id`, `content_field` (`text`, `tool_args`, `tool_result`, or `tool_error`), `call_id` for tool fields, and `offset`. Follow `data.content.nextOffset` until null. These slices use the same step access checks. Shared orchestrator transcripts exclude compaction entries that have no submission ID.
- For empty or failed agent output, call `get_node_diagnostics`. It traces original and repair submission IDs, the selected message, stored text lengths, stop reason, provider error, model, usage, and cost. Pass `iteration` for a foreach step. Missing receipts or fields mean evidence is unavailable. These readers do not expose raw provider responses. If selected stored text is empty but text parts exist, report a stored content/parts mismatch. Do not claim the provider returned empty. Use `get_node_transcript` for the same run, node, and iteration to inspect content. If `entriesMayBeTruncated` is true, qualify conclusions about message selection.
- Interpret `modelResponse.stopReason` as adapted, and `rawStopReason` as the stop label exposed by the adapter. Null effective limits, request IDs, provider terminal status, or incomplete reasons mean unknown. Requested limits do not establish effective limits. Text lengths count UTF-16 code units. Matching stored, parts, adapted, and streamed lengths show recorded consistency. Report full provider-response capture as not verified when the raw response is unavailable. Use the Observed, Inference, and Unknown format in `workflow-troubleshooting`.
- To check automatic follow-up, read `get_run.followUp`. `awaiting_settlement` means the run has not reported yet. `queued` and `running` describe the follow-up turn. `settled` describes that turn, not external delivery. `not_recorded` means the run settled without a stored completion signal; inspect its results and tell the user. Do not claim monitoring is active when `registered` is false.
- A `workflow.settled` signal resumes the task. Inspect the run and relevant node results, then report the requested checks. Verify Slack delivery from posting results, including message IDs. Do not end with another promise to check later.
- A run is finished when `status: "settled"`; report the `outcome`.
- To test a workflow, first state 2 to 4 concrete checks that the result must pass. Then call `preview_workflow` to find template and structure errors. It runs only `trigger`, `set`, `if` and `stop` steps and describes the other steps, so it has no side effects. Start a real run only after the person agrees, because a real run posts messages and calls integrations. Read the result in the `workflow.settled` report and with `get_node_result`. Fix the workflow and run it again, at most 3 times. End the test with each check marked passed or failed.


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
An event subscription's `target.appearance` overrides individual workflow fields. Unset fields inherit the workflow, then workspace default.
Tool steps, agent tool calls, automatic replies, and approval cards inherit this identity without extra prompt instructions or `set` nodes.
Explicit Slack `sender_name` / `sender_avatar_url` arguments still override one message; use them only for deliberate exceptions.
These settings customize messages, not the Slack account or DM conversation. See the `slack-tools` skill.

For an existing event subscription, call `events.list_subscriptions` in its personal or team workspace.
Use the exact `name` filter or follow `nextOffset` with `offset` to find its ID.
Call `events.set_subscription_presence` with `subscription_id` and `presence: { displayName?, avatarUrl? }`.
This replaces the override. Send `presence: null` to clear it. The tool preserves matching rules, target, and enabled state.
`workflows.create_trigger` and `workflows.propose_trigger` also accept optional `presence`.
