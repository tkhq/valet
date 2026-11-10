# Fewer permission asks

**Date:** 2026-11-10
**Status:** A and B built. C and D are follow-ups.
**Related:** `2026-07-16-action-policies-audit-design.md` (policy engine), `2026-10-04-thread-api-cleanup-design.md` (tool discovery), `2026-10-07-mcp-agent-tools-design.md` (MCP tool broker).

## Problem

People get approval cards for work they asked for, or for work that has nothing to do with their task. Each card that a person did not need makes the next card easier to approve without reading it.

## Model

Valet's permission model already matches Claude Code's model in its main parts:

| Claude Code | Valet |
|---|---|
| A managed deny wins over all other rules | An org deny wins, then a team deny |
| Allow, ask, and deny rules at each scope | Org and team policies, personal overrides |
| "Yes, and don't ask again" saves a narrow rule | Always allow for me, for this team, or for the org |
| A file-edit approval lasts for the session | Allow in this thread (B) |
| Auto mode, with limits | Run without asking, limited to what the owner could allow |
| Read-only tools never ask | A broad tool search never asks (A) |
| A headless run denies what would ask | Unattended runs and external senders refuse, with no card |

The extra asks come from the places where Valet differs from this table.

## A. A broad tool search does not ask

`list_tools` with no `service` filter runs discovery for every MCP-backed service. In a team, discovery that needs another member's shared account opened a card for that member, even when the task did not use the service. A search is a read-only lookup, and Claude Code never asks for one.

A broad search now reads the discovery decision before it runs discovery, and opens no card. A service whose discovery would ask a person is left out. Its warning names the member and tells the model to call `list_tools` with that `service`. A `service` filter, or a `call_tool` on one of the service's tools, still asks.

## B. Allow in this thread

The assistant's session spans every thread in its workspace, so a session grant was close to permanent. The card hid "Approve for this session" when a lasting allow existed. A person who meant "go ahead for this task" clicked "Approve once" on each call.

Every chat policy card now offers "Allow in this thread". It writes a runtime grant with `thread_id` set, and the grant matches only calls from that thread. Its rung, its revocation, and its limits are those of a session grant: deny rules still win, and external-sender turns ignore it. The details are in the policy spec, decision 2b.

## C. MCP and API-key callers (follow-up)

`/api/actions/:id/invoke` returns `approval_required` and tells the caller to use `start_thread`. Agents cannot answer approvals, and that rule stays. The follow-up records an approval request for the exact call (tool, params digest, workspace, caller) in the person's Needs-you inbox. It returns a link, and the call runs once after a person approves. MCP elicitation is not used for approvals: a client can answer an elicitation without a person, so the answer does not prove that a person decided.

## D. "I just asked for it" (no blanket change)

Valet cannot prove that the model's call matches what the person typed, and injected text can ask in the person's name. Claude Code needs a classifier for this in auto mode. So a request is not an approval. B and the always-allow options remove the repeats. Each Valet action whose risk level asks too often gets its own review, as `events.set_subscription_enabled` did.

## Properties kept

- Unattended runs, workflow agent steps, child sessions, and channel senders with no Valet account cannot take a `require_approval` action alone. Their code paths do not change.
- Org and team policy can always make a rule stricter.
- A deny always wins.
- Only a person who answers a card can write a thread grant, and the grant covers only that thread.
