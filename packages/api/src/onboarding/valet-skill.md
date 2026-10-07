---
name: valet
description: Use Valet, the organization's agent platform at {{VALET_URL}}. Use it to call integrations the organization connected (GitHub, Slack, Linear, Google, and others) without local credentials, to hand long or remote work to the Valet assistant, and to read or save team memory, skills, workflows, and artifacts. Use it when a task needs an organization integration or team context, or when the person mentions Valet.
---

# Valet

Valet runs at {{VALET_URL}}. It holds the organization's integration credentials, applies its tool policies, and keeps shared team context. Reach Valet through its MCP tools when they are connected. Use the `valet` CLI otherwise. If neither works, follow {{VALET_URL}}/agent-setup.md.

## Rules

- Never ask for, print, or save an API key, token, or password. Valet keeps the credentials. You never need them.
- Do not approve Valet approval requests. You can answer a question with `resolve_decision`. An approval needs the person: give them the link.
- Do not save secrets or personal data to Valet memory or artifacts.
- When a result says `approval_required`, the action did not run. Do not retry it to get around the policy.

## Choose the right tool

| Need | MCP tool | CLI |
|---|---|---|
| Call an integration (create an issue, read a channel, query a dashboard) | `search_tools`, `describe_tool`, `call_tool` | `valet tools search`, `describe`, `call` |
| Hand off long, remote, or team work | `start_thread`, `send_message`, `get_thread` | `valet threads new`, `valet send --thread` |
| Find what the team already knows | `search_memory`, `read_memory` | none |
| Save a durable decision or convention | `write_memory` | none |
| Follow the team's playbook for a task | `list_skills`, `get_skill` | none |
| Run a saved automation | `list_workflows`, `run_workflow`, `get_workflow_run` | none |
| See what waits for the person | `list_inbox` | `valet gates list` |
| Share a report or page | `publish_artifact` | none |

Use your own tools for local work: files, the shell, and the local repository. Use Valet for what needs the organization's accounts, shared context, or Valet's cloud sandboxes.

## Call an integration

1. Search: `search_tools` with a few words and an optional `service`, for example `{"query": "create issue", "service": "github"}`.
2. Read the schema: `describe_tool` with the `tool_id`. Check `policy`. If it is `deny`, stop. If it is `require_approval`, the call will not run without a person.
3. Call: `call_tool` with `tool_id` and `params` that match the schema. Set `idempotency_key` when you might retry, so a retry returns the first result instead of acting twice.
4. Read `status`: `completed` (use `result`), `failed` (read `error` and fix the params or connection), or `approval_required` (follow `next_step`).

If a service is listed as not connected, tell the person to connect it at {{VALET_URL}}/integrations.

## Hand off work to the Valet assistant

1. Write the prompt as a complete brief: the goal, the repository, the context you have, the constraints, and what done looks like. The assistant cannot see your conversation.
2. Call `start_thread` with the brief. It waits up to `wait_seconds` (default 45, maximum 55) and returns `status`:
   - `completed`: use `reply`.
   - `running`: call `get_thread` with `wait_seconds` to wait again.
   - `waiting_for_decision`: read `pending_decisions`. Answer a question with `resolve_decision`. For an approval, give the person the `url`.
   - `failed` or `aborted`: read `error`.
3. Follow up in the same thread with `send_message`.

## Use team memory and skills

- Before you start work in a shared area, run `search_memory` for its name. Read what you find with `read_memory`.
- When you learn something the team should keep, such as a decision, a convention, or a fix for a recurring problem, save it with `write_memory` at a clear path, for example `projects/<repo>/decisions.md`.
- Before a task the team has a playbook for, run `list_skills`, then `get_skill`, and follow the instructions with your own tools. Where a skill names a Valet tool, use the Valet MCP tool with that name.

## CLI reference

```sh
valet status                                   # instance health and login
valet tools search "<words>" [--service <s>]   # find integration tools
valet tools describe <tool_id>                 # schema and policy
valet tools call <tool_id> --params '<json>' [--idempotency-key <k>]
valet threads list | new --title "<t>"         # Valet assistant threads
valet send --thread <id> "<prompt>"            # send and stream the reply
valet gates list                               # pending questions and approvals
```

Add `--json` for machine-readable output. Exit codes: `0` done, `2` usage error, `3` waiting on a decision or approval, `4` failed, `5` authentication failed (the person logs in again), `6` Valet not reachable.
