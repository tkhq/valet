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
| `resolve_decision` | Answers a question, then optionally waits for the turn to continue. Approvals need a person. |

`whoami` and `list_sessions` stay for existing clients.

### Tool broker

Valet holds the organization's integrations: bundled plugins and the remote MCP servers in the instance config. Three more tools let a harness use them without holding any credential.

| Tool | Route | Purpose |
|---|---|---|
| `search_tools` | `GET /api/actions` | Finds tools by text and service. Returns `tool_id`s. |
| `describe_tool` | `GET /api/actions/:toolId` | Returns the description, the JSON Schema parameters, and the policy mode that applies to the caller. With `params`, the mode is resolved for that exact call, because a policy can match on params. |
| `call_tool` | `POST /api/actions/:toolId/invoke` | Runs the tool with the workspace owner's credential. |

The `valet tools search|describe|call` command calls the same routes, for a harness without MCP.

A remote MCP-backed service lists its tools over the network with the caller's credential. The routes keep each successful listing for two minutes per caller, owner, and service, so repeated searches do not contact every connected server. A call does not use the cache: the invoker resolves the action and checks credentials and policy again.

The routes run the headless `ActionInvoker` with `external` set. That mode resolves the policy hierarchy with `appliesIn: "session"`, the scope a person's own Valet agent uses, so org, team, and personal policies apply unchanged. Without `external` or a workflow run, the invoker enforces no policy, so every external caller must set it.

- `allow`: the tool runs. The response is `completed` or `failed`.
- `deny`: the tool does not run. The response is `failed` and names the policy.
- A team call that only a teammate's shared account can answer: the tool does not run. The response is `approval_required` and names that member. An external call never borrows the account, because the member's approval attaches to a thread or workflow run. The caller delegates with `start_thread` in the team workspace.
- `require_approval`: the tool does not run. The response is `approval_required` with a `next_step`. An external call cannot open an approval yet, because a decision gate resumes a paused agent turn and an external call has none. The caller delegates with `start_thread`, which raises a normal approval, or an admin changes the policy.

Each call writes an `action_invocations` audit row keyed `pol:ext:{invocationId}:{attempt}`, one row per attempt, so a retry after a policy change records its own decision, with the caller's user id, the caller type in `caller` (`mcp:<OAuth client id>`, `agentKey`, `apiKey`, or `session`), the decision, the parameters, and the outcome. With an `idempotency_key`, the invocation id is `ext:{userId}:{ownerType}:{ownerId}:{toolId}:{paramsDigest}:{key}`. A repeat with the same tool and params returns the stored result. The same key for another tool, other params, or another caller runs separately. A failed result is not kept, so a retry after a fix runs again. While a keyed call runs, it holds a `claim:` row, and a duplicate gets `in_progress` instead of a second run. A claim older than 15 minutes is treated as left over from a crash. Taking it over is one conditional `UPDATE`, so only one of two concurrent retries runs the action.

### Workspace tools

These tools give a local agent the rest of the workspace. Each one calls the route named here, so that route's ownership and permission rules apply.

| Tool | Route | Purpose |
|---|---|---|
| `list_skills`, `get_skill` | `GET /api/skills`, `GET /api/skills/:name` | Lists the skills the caller can use and returns one skill's instructions. `args` fills `{{placeholders}}` with the engine's `renderTemplate`. |
| `search_memory`, `read_memory` | `GET /api/memory/search`, `GET /api/memory` | Searches and reads personal or team memory. |
| `write_memory` | `PUT /api/memory` | Creates or replaces a memory file. A team write needs team admin rights, as in the web client. |
| `list_workflows`, `run_workflow`, `get_workflow_run` | `GET /api/workflows`, `POST /api/workflows/:id/runs`, `GET /api/workflows/runs/:runId` | Lists and starts workflows. A run waits on the server until it settles, stops for approval, or the wait ends. |
| `list_inbox` | `GET /api/notifications/decisions`, `GET /api/workflows/action-required` | Lists thread decisions and workflow approvals that wait for the caller. |
| `list_artifacts`, `publish_artifact` | `GET /api/artifacts`, `POST /api/artifacts/share` | Lists and publishes artifact pages. A repeated key adds a version at the same link. Artifacts are visible to the whole organization (the narrowest visibility), and the tool says so, so an agent does not publish what the person has not agreed to share. |

A team workspace maps to `ownerType=team&ownerId=<team id>` on the memory, skills, workflow, and artifact routes.

MCP prompts are not exposed. The server is created for each request, so listing skills as prompts would add a skill query to every MCP call.

### Agents answer questions; people approve

An MCP client is an agent, and so is the key that browser `valet login` mints (`authVia: "agentKey"`, see "CLI browser sign-in" in the auth spec), because the onboarding has the agent run that login. `isAgentCaller` covers both. The thread decision route refuses an `approval` or `credential_request` gate from an agent, and returns "A person must approve this request." Without this rule, one agent could approve another agent's `require_approval` action. An agent can still answer a `question` gate. `list_inbox` marks each thread decision with `agent_can_answer`.

`refuseAgentAuthority` also gives an agent 403 on writes where a person decides: workflow approvals, policies (a preview is allowed), policy overrides, grants, security needs, and team deletion requests. Otherwise an agent could turn a `require_approval` policy into `allow`. A key created in Settings keeps full authority.

### Agent onboarding

Onboarding is one link. A person tells their agent to read `<instance>/agent-setup.md` and follow it. The instance serves two public markdown pages (`onboarding/routes.ts`) and fills `{{VALET_URL}}` with its public URL:

- `/agent-setup.md`: install the CLI, run `valet login` (the person approves it in the browser, see "CLI browser sign-in" in the auth spec), connect MCP, install the skill, and check the setup. The page forbids the agent to request, print, or save a secret, or to approve a Valet approval.
- `/agent-skill.md`: the `valet` skill (`SKILL.md` format). It maps tasks to MCP tools and CLI commands and repeats the safety rules.

The pages hold no secrets or per-user data. The build inlines the markdown, so the bundle and the binary serve it.

### Access control stays in the routes

The tools call the existing `/api` routes in-process (`app.fetch`). They add no queries that decide access. Thread privacy, team membership, and decision approver rules apply to an MCP caller exactly as they apply to the web client and the CLI.

The `/mcp` handler verifies the OAuth bearer token and attaches the user to each in-process `Request` object (`auth/mcp-caller.ts`). The auth middleware reads that attachment at rung 1b. The attachment lives in a `WeakMap` keyed by the `Request` object, so no header, cookie, or body can produce it. Rung 1b accepts the identity only on the routes the tools use (`MCP_ALLOWED_ROUTES`). Every other route returns 403. Add a route to the allow-list when a tool needs it.

### Waiting happens on the server

`wait_seconds` (default 45, maximum 55) polls the turn's queue item and the thread's pending decisions once a second. The wait ends when one of these happens:

- The queue item settles. The result carries the outcome and the final assistant text. A `merged` item follows `mergedIntoItemId`.
- A decision is pending. The result is `waiting_for_decision` with each gate's `gate_id` and options.
- The time runs out. The result is `running`, not an error. The agent calls `get_thread` with `wait_seconds` to wait again.

The maximum stays under 60 seconds because an ingress commonly ends a request at 60 seconds (nginx's default) while the turn keeps running. The wait finds the turn by its queue item, the thread's newest one for `get_thread` and `resolve_decision`, because a long turn's tool messages can push its prompt out of any fixed message window.

The queue item read uses ids that an authorized route call returned, so it widens no access.

### Results

Each tool returns JSON text and the same value as `structuredContent`. Message and reply text is capped at 8,000 characters. A failed route call returns an MCP tool error with a corrective action, for example "Thread not found, or you do not have access to it. Use list_threads or list_workspaces to find a valid id."

### Sign-in and consent

Every MCP authorization goes through Valet's consent page (`routes/oauth-consent.ts`, web `/oauth/consent`). A handler before better-auth adds `prompt=consent` to each authorize request, so no client can skip the page. A signed-out request is sent to `/login?next=<authorize URL>`, and the login page loads `next` after sign-in, which resumes the authorization. The client receives its code only after the person chooses Allow. A consent decision is accepted from the public origin (`VALET_PUBLIC_URL` or `BETTER_AUTH_URL`) or the request origin, because a TLS-terminating ingress shows the server an `http` request origin.

### Sign-in

The instance publishes OAuth protected-resource and authorization-server metadata and supports dynamic client registration. An MCP client that implements MCP authorization signs in by itself. `valet mcp setup` therefore writes only the endpoint URL, unless `--token` supplies a bearer token for a client that cannot run OAuth.

## Not included

- Approvals for external tool calls. This needs a decision gate that is not tied to an agent turn.
- File upload over MCP. Agents use `valet upload` until a tool exists.
- Skills as MCP prompts and a `valet skills pull` command that writes native Claude Code skills.
- Skill supporting files. Sync stores only `SKILL.md` text and frontmatter.
- Streaming partial output. A long task returns `running`, and the agent polls with `get_thread`.
- Team API keys. MCP tokens are user tokens. A team acts through a member.

## Validation

`auth/mcp-workspace-tools.test.ts` covers skills, memory, workflows, the inbox, artifacts, and the refusal of an MCP approval, each with two users. `auth/mcp-tool-broker.test.ts` covers search, describe, policy inheritance (allow, deny, require_approval), credential isolation between users, idempotency, and audit rows. `cli/commands/tools.test.ts` covers the CLI command. `auth/mcp-agent-tools.test.ts` boots the API with real auth, seeds OAuth tokens, and drives JSON-RPC calls against the faux model provider: delegation with a wait, follow-ups, thread reads, the question-decision loop, cross-user isolation, the route allow-list, and wait timeouts.
