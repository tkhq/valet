# Task tool scopes

Valet narrows tools by task. Scopes reduce unrelated choices. Existing authorization and approval policies still apply.

## Contract

- A scope lists native tool names and integration action IDs. `service.*` selects one service's actions.
- An omitted list adds no restriction. An empty list permits no entries in that list.
- Session ceilings, submission ceilings, and thread focus intersect. A child inherits the effective parent scope.
- Persist scopes in existing session, thread, submission, and run metadata. Restore them before execution.
- An invalid stored scope permits no tools. A missing scope keeps existing behavior.
- Filter discovery and visible tools. Check execution again, including pinned actions and sandbox calls.
- A thread focus belongs to one thread. Cached team sessions never store focus in their shared catalog.
- Workflow runs carry the starting scope through agent steps, tool steps, and nested runs.
- Nobody answers a decision in an unattended workflow task. This covers a workflow step's own session, a workflow task sent to an assistant thread, including repairs (`metadata.unattendedWorkflow`), and every turn on a run's own thread that a person did not type, such as `child.settled` (the `unattendedThread` session hook). `Thread.requestDecision` refuses each new request before a gate opens. `ask_question`, `ask_approval`, and `call_tool` approvals return a fail-closed result, and the step reports what it needs. The author settles decisions when the workflow is saved. A person's reply on the run page keeps normal gates. Restart replay still resolves a gate opened before this rule.
- A `foreach` body is one node. Its declared scope applies to each iteration, including calls before a session exists.
- Child steering, collected messages, and completion signals retain their originating ceilings.
- Child gate notifications retain the gate submission's scope. Missing source records permit no tools or actions.
- Security dispatch and handoff carry the active submission scope through their HTTP route into the child spawner.
- Each thread retains its last started task ceiling in durable metadata. A new task replaces that continuation ceiling without changing the session ceiling.
- Security driver nudges and stall reports intersect the session ceiling, thread focus, and durable continuation ceilings. They cannot recover broader access by starting a new turn or pruning queue history.
- Continuations recheck all session thread ceilings when they claim a turn. The claim atomically persists the result on the queue item, closing races with newer scoped tasks and preserving scope for restart and signal readers.
- A workflow report retains the starting member's authority. Private team run evidence still requires that member's access.
- Workflow approval and completion reports inherit `originToolScope`, the starting task's authorization ceiling. The run's `toolScope` separately includes mutable thread focus.
- An empty `originToolScope` records an unrestricted starting task. Older runs without this field retain their execution scope as the report ceiling.
- A headless tool action has no mutable focus. Nested starts use its delegated execution scope as the origin ceiling.
- A retry preserves both stored scopes. Legacy retries keep their execution scope as the report ceiling.
- Thread saves update metadata in each store. A restored focus must match the last saved focus.

## Workflow troubleshooting

`focus_tools` selects diagnose, repair, validate, or general focus. It never expands a session or submission ceiling.
Diagnose exposes workflow evidence reads and previews. Repair adds definition edits, automation proposals, and automation corrections.
Validate retains previews and adds run controls and explicitly named integration actions.
Every focused phase retains replies, reactions, and files to the originating Slack conversation, and replies to the originating Telegram conversation.
These actions resolve the existing origin. They do not accept an arbitrary destination, and inherited ceilings still apply.
Automation activation still requires the person's request and existing policy checks. Prefer disabled proposals for review.
General clears thread focus. It does not remove inherited ceilings or change action policies.
Use general for other workflow management tasks, such as copying or deleting a workflow.
The workflow skill loads the troubleshooting procedure for failures. It records checks, inspects evidence, repairs one cause, and verifies results.
The workflow editor starts in diagnose focus. An edit request selects repair. An authorized test selects validate.
The patch action rejects unknown parameters. An unsupported patch format must not appear to save a successful edit.
Focused discovery returns eight compact summaries by default. Request an exact schema before calling an unfamiliar action.
`outside_focus` discovers summaries within the inherited ceiling. It does not enable calls or return schemas.
Exact action scopes still permit the internal account-discovery approval needed to resolve dynamic services.

Scopes constrain tools and brokered integration actions. They do not restrict network access from an explicitly allowed shell.
Do not describe a tool scope as a sandbox firewall.

A run started by a scoped task inherits its effective scope, including nested runs.
Its approval and completion reports can change from validate focus to repair focus within the captured origin ceiling.
This change does not widen the run's execution scope or remove inherited authorization limits.
Saving a definition does not bind future independent UI, schedule, event, or webhook runs to the authoring task's ceiling.
Those runs are new executions under their existing owner and action policies. Scopes do not constrain every future use of an edited configuration.

## Evidence

Codex MCP configuration supports tool allowlists and denylists. Claude Code subagents support tool allowlists and inherited permissions.
Both load task instructions on demand. Claude skill preapproval alone does not restrict tool availability.

Sources:
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/skills
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

## Validation

Exercise personal and team owners. Cover concurrent threads, restarts, stale tool calls, scope widening, missing credentials, and denied actions.
Use deterministic provider tests for enforcement. Run live synthetic workflow checks without sending messages to external recipients.
Compare small and larger configured models on clarification, diagnosis, bounded repair, verification, and false completion claims.

The comparison uses disposable workflows and test accounts. It does not change organization model defaults.
