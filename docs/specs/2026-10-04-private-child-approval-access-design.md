# Named approval access for private child sessions

## Problem

A child session inherits the access of the private thread that started it.
Its named credential approver can receive an inbox gate but cannot read or answer that gate.
The session loader rejects the private parent before the gate filter checks the named approver.

## Access rule

Decision endpoints can load a private child when a pending gate explicitly names the requesting user.
The user must belong to the session organization and pass the existing session ownership or team membership check.
A thread address requires a named pending gate in that requested thread.
A gate in another thread grants no access to the requested thread.

The gate filter still hides unrelated private gates, including gates in the same child thread.
Resolve still checks the gate approver before it submits an answer.
The exception ends when no matching named gate remains pending.

Metadata, message history, prompts, and other session operations keep their strict access checks.
The thread router distinguishes metadata access from decision access.
Workflow agent access continues to follow the workflow run owner and origin.

## Validation

A durable child fixture stores the private parent session and thread IDs in the engine store.
The regression fails before this change: the inbox contains the named gate, but decision listing returns 404.
Tests cover session and thread resolution, hidden sibling gates, metadata and message denial, organization isolation, and revoked membership.
Tests also check that a resolved gate no longer grants decision access.
