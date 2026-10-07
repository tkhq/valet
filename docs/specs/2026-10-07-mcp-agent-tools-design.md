# MCP agent tools

## Problem

A local coding agent (Claude Code, Codex, Cursor) should delegate work to Valet and follow it. MCP is the interface these agents already speak, and Valet already runs an MCP OAuth server. Before this change, `/mcp` exposed only `whoami` and `list_sessions`, so an agent could not start work, read a result, or answer a question.

The CLI is not a good substitute for an agent. `valet send` subscribes to its stream after it posts the prompt, so a fast turn can finish first and the command waits forever. `valet handoff --wait` has the same race. Their JSON output carries every thread's state frames, and the reply arrives as text fragments.

## Decision

`/mcp` exposes agent tools that delegate to a workspace, wait on the server, and return one structured result.

| Tool | Purpose |
|---|---|
| `list_workspaces` | Personal workspace and the teams the caller belongs to. |
| `list_threads` | Recent threads in a workspace. Optional text query. |
| `start_thread` | New thread, first prompt, optional wait for the reply. |
| `send_message` | Follow-up prompt in a thread, optional wait. |
| `get_thread` | Status, recent messages, pending decisions. Optional wait for the latest turn. |
| `list_decisions` | Pending approvals and questions in a thread. |
| `resolve_decision` | Answers a decision, then optionally waits for the turn to continue. |

`whoami` and `list_sessions` stay for existing clients.

### Tool broker

Valet holds the organization's integrations: bundled plugins and the remote MCP servers in the instance config. Three more tools let a harness use them without holding any credential.

| Tool | Route | Purpose |
|---|---|---|
| `search_tools` | `GET /api/actions` | Finds tools by text and service. Returns `tool_id`s. |
| `describe_tool` | `GET /api/actions/:toolId` | Returns the description, the JSON Schema parameters, and the policy mode that applies to the caller. |
| `call_tool` | `POST /api/actions/:toolId/invoke` | Runs the tool with the workspace owner's credential. |

The `valet tools search|describe|call` command calls the same routes, for a harness without MCP.

The routes run the headless `ActionInvoker` with `external` set. That mode resolves the policy hierarchy with `appliesIn: "session"`, the scope a person's own Valet agent uses, so org, team, and personal policies apply unchanged. Without `external` or a workflow run, the invoker enforces no policy, so every external caller must set it.

- `allow`: the tool runs. The response is `completed` or `failed`.
- `deny`: the tool does not run. The response is `failed` and names the policy.
- `require_approval`: the tool does not run. The response is `approval_required` with a `next_step`. An external call cannot open an approval yet, because a decision gate resumes a paused agent turn and an external call has none. The caller delegates with `start_thread`, which raises a normal approval, or an admin changes the policy.

Each call writes an `action_invocations` audit row keyed `pol:ext:{invocationId}`, with the caller's user id, the decision, the parameters, and the outcome. The invocation id is `ext:{userId}:{ownerType}:{ownerId}:{key}`. A repeated `idempotency_key` from the same caller and owner returns the stored result. The same key from another caller runs separately.

### Access control stays in the routes

The tools call the existing `/api` routes in-process (`app.fetch`). They add no queries that decide access. Thread privacy, team membership, and decision approver rules apply to an MCP caller exactly as they apply to the web client and the CLI.

The `/mcp` handler verifies the OAuth bearer token and attaches the user to each in-process `Request` object (`auth/mcp-caller.ts`). The auth middleware reads that attachment at rung 1b. The attachment lives in a `WeakMap` keyed by the `Request` object, so no header, cookie, or body can produce it. Rung 1b accepts the identity only on the routes the tools use (`MCP_ALLOWED_ROUTES`). Every other route returns 403. Add a route to the allow-list when a tool needs it.

### Waiting happens on the server

`wait_seconds` (default 60, maximum 300) polls the turn's queue item and the thread's pending decisions once a second. The wait ends when one of these happens:

- The queue item settles. The result carries the outcome and the final assistant text. A `merged` item follows `mergedIntoItemId`.
- A decision is pending. The result is `waiting_for_decision` with each gate's `gate_id` and options.
- The time runs out. The result is `running`, not an error. The agent calls `get_thread` with `wait_seconds` to wait again.

The queue item read uses ids that an authorized route call returned, so it widens no access.

### Results

Each tool returns JSON text and the same value as `structuredContent`. Message and reply text is capped at 8,000 characters. A failed route call returns an MCP tool error with a corrective action, for example "Thread not found, or you do not have access to it. Use list_threads or list_workspaces to find a valid id."

### Sign-in

The instance publishes OAuth protected-resource and authorization-server metadata and supports dynamic client registration. An MCP client that implements MCP authorization signs in by itself. `valet mcp setup` therefore writes only the endpoint URL, unless `--token` supplies a bearer token for a client that cannot run OAuth.

## Not included

- Approvals for external tool calls. This needs a decision gate that is not tied to an agent turn.
- File upload over MCP. Agents use `valet upload` until a tool exists.
- Streaming partial output. A long task returns `running`, and the agent polls with `get_thread`.
- Team API keys. MCP tokens are user tokens. A team acts through a member.

## Validation

`auth/mcp-tool-broker.test.ts` covers search, describe, policy inheritance (allow, deny, require_approval), credential isolation between users, idempotency, and audit rows. `cli/commands/tools.test.ts` covers the CLI command. `auth/mcp-agent-tools.test.ts` boots the API with real auth, seeds OAuth tokens, and drives JSON-RPC calls against the faux model provider: delegation with a wait, follow-ups, thread reads, the question-decision loop, cross-user isolation, the route allow-list, and wait timeouts.
