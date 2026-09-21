# Approval authority for personal event assistants

Status: proposed. This document changes no runtime authorization.

## Problem

A reported event-driven bot session was owned by the Applied AI team. Another
team member could resolve its approval gate, although the reporter expected
only the subscription creator or personal bot owner to approve it.

The incident has not been reproduced against a captured subscription, assistant,
session, and gate. The current team behavior is deliberate, not an omitted
membership check. Changing it globally would restrict genuinely shared assistants.

## Current behavior verified in code

- `events/dispatcher.ts` delivers an assistant event with the subscription owner.
  Ordinary events use the subscription creator as actor; team mentions resolve
  the current sender through the rule's invocation audience.
- `events/assistant-delivery.ts` checks the named assistant against the owner and
  organization before resolving its session.
- `services/session-access.ts` lets live team members resolve team-owned session
  gates. Its `userId` stamp identifies an actor, not the owner of a shared assistant.
- `channels/host.ts` and the decision endpoints in `routes/messages.ts` use the
  same named gate check. Workflow sessions instead derive ownership from their run.
- `2026-09-14-slack-workflow-approval-callbacks-design.md` documents shared team
  approval and the organization-admin requirement for organization-owned workflow gates.

## Proposed decision

Personal assistants retain a user owner even when they use team resources or
receive events from a team workspace. Team context must not change their approval
owner. Genuinely shared assistants retain team ownership and the existing live
membership rule. Subscription creation must make that distinction explicit.

The assistant owner, event actor, resource context, and gate resolver are separate
concepts. Do not infer a personal owner from `agent_sessions.userId`, the first
person to open a team assistant, the last Slack sender, or a display name.

| Assistant mode | Gate resolver | Other team members |
| --- | --- | --- |
| Personal, including authorized team context | Personal assistant owner | Cannot resolve |
| Shared team assistant | Current owning-team members and its team principal | Can resolve while members |
| Organization-owned workflow session | Current owning-organization admin | Cannot resolve by membership alone |

Team context does not grant additional credentials by itself. Existing resource
and credential authorization remains required. An organization-wide invocation
audience permits invocation only; it does not widen session or gate access.
The `always_allow` action also requires organization-admin authority, as it does
today. This action check applies after gate eligibility. Admin status alone does
not grant access to another user's personal gate.

## Implementation contract

1. Capture the incident's persisted subscription target, assistant owner, session
   owner, gate identifier, and callback actor. Reproduce the unexpected permission.
2. Preserve user ownership when a personal assistant is configured with team
   context. Persist context separately if the existing target cannot represent it.
3. Validate the target owner's organization and the creator's resource access at
   subscription creation and delivery. Reject owner and target mismatches.
4. Derive approval authority from the durable assistant or workflow owner. Apply
   one policy in web resolution, withdrawal, Slack callbacks, and attention routing.
5. Re-check required membership at decision time. Do not reconstruct authority
   from callback input or from the notification recipient list.
6. Keep rejected gates pending. Record a diagnostic rejection without disclosing
   the gate to an unauthorized caller.

## Existing sessions and pending gates

Do not reinterpret existing team sessions as personal sessions automatically.
Their actor stamps cannot establish intent. An owner must explicitly classify a
reported personal bot. Reclassification must not mutate a shared assistant in place.
Create the correctly owned assistant and rebind its subscription after validation.
Withdraw affected pending gates and regenerate them under the new ownership.
Unrelated shared team assistants keep their current approval behavior.

## Required regression matrix

Run the same cases through web resolve, web withdraw, and Slack callback paths:

- A personal owner can resolve; a teammate, team key, and organization admin cannot.
- A current shared-team member can resolve; a removed member and unrelated team cannot.
- An invocation-only organization member cannot resolve a shared-team gate.
- A subscription creator who does not own the selected personal assistant cannot approve.
- A stale or cross-organization target fails before session creation or gate resolution.
- API restart restores the same authority from persistence.
- Notification delivery does not change authority; rejected clicks leave gates pending.
- A non-admin personal owner or team member can make ordinary decisions but cannot
  choose `always_allow`. Organization-admin status does not bypass personal ownership.

## Review boundary

Approve the ownership decision and reproduce the reported configuration before
implementing a runtime change. This draft provides the design review surface; it
must not be described as fixing the incident or closing its authorization report.
