# Thread sharing

A person can share one personal thread with the other members of their organization. The thread stays in the owner's workspace and keeps running as the owner. A typical use: share an incident investigation in a Slack channel so that teammates can watch it live, or join in.

## Modes

The owner picks one mode in the **Share** dialog in the thread header.

| Mode | Who can open the thread | What they can do |
|------|-------------------------|------------------|
| Off (default) | The owner | Everything, as before |
| View | Any live member of the owner's organization who has the link | Read the history, watch the thread live, see that an approval is pending |
| View + reply | Same as View | Also send prompts, stop a running turn, and resume a stopped queue |

The link is the thread address, `/threads/:threadId`. The owner opens the full thread there. A guest opens a page with only that thread: no sidebar entry, no sandbox tabs, no settings, and no reply ratings (ratings are session-addressed). A share never makes the thread public. A person outside the organization, and a team API key, cannot open it.

Only the owner changes the mode. Setting it to Off revokes access on the guest's next request. A guest's live stream reads the share again before a frame or keepalive: at once after a share change in the same process, and otherwise when its last answer is five seconds old. When the share is gone, the server closes the stream with code 4040.

The thread shows a "Shared" mark to everyone: a badge in the owner's header, an icon on the owner's sidebar row, and a "Shared by {owner}" badge on the guest page.

## What runs as whom

A guest's prompt runs in the owner's session, in the shared thread:

- The prompt carries the guest as its author (`MessageEntry.author`). The UI shows the guest's name. The model sees a `[from: …]` sender line on that prompt (`AuthorAttribution` in `packages/engine/src/submission.ts`). The owner's own prompts in a personal session still carry no sender line.
- Tools use the owner's connected accounts. A personal session resolves credentials from its owner (`EngineHost.buildCredentialResolver`), whoever wrote the turn.
- The owner's permission settings apply. `loadPolicyRows` reads the personal overrides of the session's owner, not of the turn's author. The owner's session grants ("allow for this session") do not cover a guest's turn, so an "Ask first" action asks the owner again.
- A guest's turn cannot read the owner's other threads or memory. `thread_read`, `list_threads`, and the `mem_*` tools set `ToolDef.ownerOnly`, and the engine refuses such a tool when a personal session runs a turn from someone other than its owner. The owner's own turns are unchanged.
- The audit record (`action_invocations.user_id`) names the guest as the actor. Its session is the owner's, so the record reads as "the guest, acting in the owner's session".
- Approvals go to the owner only. The attention router already sends a personal session's approvals to its owner. A guest sees that an approval is pending but gets 403 on resolve and withdraw.

The dialog states the consent in plain words: "People who reply can use your connected accounts and tools, with your permission settings."

A guest cannot change the thread. The server refuses a guest's thread PATCH (title, archive, model, share), slash commands that run (`/model`, for example), and file references. The guest composer has no attachment control and no command list. The browser still refuses a guest's turn: its existing rule allows only the owner to drive a personal browser.

## Access model

The share lives on the thread's app metadata row: `session_threads.share_mode` (null, `view`, or `reply`), with a `SCHEMA_REPAIRS` entry for deployed databases. `services/thread-share.ts` owns the rule:

1. The session is personal (`owner_type = user`) and not deleted.
2. The caller is a user principal, is not the owner, and is a live member of the session's organization (`org_members`).
3. The thread's row has a share mode.

A share admits a person to the thread, never to the session. Only two entry points consult it:

- The thread-addressed routes (`routes/threads.ts`). Each route names what a guest may do there: `read` (thread metadata, history, channel activity, pending decisions) or `reply` (prompt, abort, resume). A route that names nothing is the owner's alone and returns 403 to a guest. After the check, the route sets `threadShareGuest` on the request context. `loadOwnedSession` admits that one session and thread for the rest of the request.
- The session stream, `GET /api/sessions/:id/ws?threadId=…`. A guest stream sends frames for that thread and keepalives only. Session-wide frames, such as `sandbox.status`, never reach a guest. The `init` frame leaves out the session's workspace label and title.

Every session-addressed route (`/api/sessions/:id/...`) keeps `canViewSession` and returns 404 to a guest. So the owner's other threads, the session detail, the thread list, the session's decisions, child sessions, sandbox files, terminal access, and memory all stay private. A guest's own thread lists, notifications, and briefings never include the shared thread.

Artifacts need no change. A personal artifact is visible to its organization by default, so a link the thread shows already opens for a guest. Comments on an artifact do not reach the owner's session from a guest, because `canSendToSourceSession` still requires `canViewSession`.

## Known limits

- A guest cannot open a child session that the shared thread started. The child card links to a page that returns 404.
- The orchestrator's system prompt holds a memory snapshot (pinned files, recent journals, and the index). It is fixed when the thread starts, so a guest's turn can still see it.
- A guest's stream does not replay events from before the page loaded. History loads over REST, and pending approvals load from `GET /api/threads/:id/decisions`.
- The recheck of a guest stream is per process. If the API runs on more than one process, a revoke made on another process reaches the stream within five seconds.

## Move to team (not built)

A personal workspace is one runtime session with many threads. A team's conversations run in separate execution sessions (`assistant_executions`), one for each conversation. The existing owner move (`PATCH /api/sessions/:id` with `teamId`) moves a whole standalone session, and it refuses a workspace runtime. So it cannot move one thread out of the personal workspace.

A real move must re-home one thread's rows from the personal runtime into a team execution session. The engine keys these by session: `engine_threads`, `engine_entries`, `engine_queue_items`, `engine_decision_gates`, `engine_decision_gate_refs`, `engine_suspended_turns`, `engine_attempt_markers`, and the per-session event stream offsets in `engine_events`. Child sessions point at the old session through `parent_session_id`. App rows (`session_threads`, read state, action invocations, artifacts, notifications, channel thread bindings) also carry the session id. Files the thread wrote stay in the owner's sandbox. This is an engine-level change with its own conformance tests, so it is out of scope here.

The smallest design that keeps history:

1. The owner picks a team that they belong to. The server refuses while a turn runs or an approval is pending on the thread.
2. The server creates a team execution session (`ensureAssistantExecution`) under a new conversation key.
3. A new engine store operation, `copyThreadHistory(from, to)`, copies the thread's entries in order. It gives each entry a new id and keeps the parent links. It does not copy queue items, gates, or events.
4. The personal thread is archived and gets a "Moved to {team}" system entry with a link. Its share is cleared.
5. From then on, the thread runs under team accounts and team policies, because its session is team-owned.

Child sessions, sandbox files, and artifacts stay with the owner. The move dialog must say so.
