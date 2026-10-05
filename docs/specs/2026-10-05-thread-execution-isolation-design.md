# Thread execution isolation

## Release requirement

A private transcript must not write files or memory that another audience can read.
Workspace ownership controls credentials, policy, billing, and configuration. It does not define the audience of every conversation.
Keep one workspace assistant in the UI. Reuse existing engine sessions for isolated execution instead of creating a second sandbox lifecycle.

## Execution identity

Persist a mapping from the workspace assistant and conversation key to an execution session.
Each execution keeps the workspace owner and a durable governing thread in the workspace runtime.
The governing thread supplies the existing reader boundary, including current Slack channel membership.
Different conversation keys receive separate working directories, sandbox tokens, and default memory namespaces.
Concurrent creation uses a unique database constraint. Restart resolves the same stored execution identity.

New helper, editor, web, event, and workflow-report conversations resolve their execution before uploads or prompt admission.
Children retain separate sandboxes and memory namespaces. Their reader audience follows the parent conversation.
Credential ownership remains the workspace owner; execution isolation does not grant access to personal credentials.

## Data access

Thread history and decisions continue to use the existing thread APIs.
Workspace lists include execution threads and exclude empty governing threads.
The chat page selects the listed execution session. Private helper and editor labels follow their governing audience.
Legacy conversation views replace the composer with an instruction to start a new thread.
Session-wide filesystem and terminal requests require access to the execution's governing audience.
A team API key cannot access a private execution. An unknown or missing governing thread denies access.
Default memory reads, writes, snapshots, searches, exports, and imports use the execution namespace.
An explicit publication or memory copy remains a separate audience-changing operation with existing authorization.

## Upgrade

Do not copy a legacy shared working directory into each new execution.
Legacy mixed-audience runtimes retain read-only transcript access. New work starts in isolated execution sessions.
Block writes and terminal access to ambiguous legacy sandboxes until an operator exports or classifies their data.
Retain old memory and artifacts for authorized recovery; never reinterpret ambiguous data as team-shared.
Retired assistant state must remain exportable before sandbox cleanup can destroy it.

## Acceptance evidence

Alice writes a marker from her team helper; Bob cannot read it through tools, memory, uploads, terminal, or a child.
The same checks pass after an API restart. Private Slack audiences retain live membership checks.
A scheduled team turn still uses team credentials or a current explicit lender grant.
Missing origins and stale mappings fail closed. Concurrent first opens produce one execution.
Upgrade tests preserve old history and prevent ambiguous state from entering a new execution.

## Scope

Slack-event workflow chaining remains unavailable until its audience can be carried into child runs.
That limitation is explicit and does not prevent this isolation change from shipping.

## Recovery

`GET /api/workspaces/:workspace/history` lists retained root and retired conversation IDs without waking a sandbox.
The response includes `nextCursor`; send it as `before` to read the next page.
Cursors are encrypted and scoped to the viewer and workspace. They do not expose hidden thread IDs.
Add `sessionId` and `threadId` to export one authorized transcript page. Entries are newest first.
This route applies current workspace membership and each conversation's reader boundary, including private helper ownership.
It never grants team administrators access to another member's private helper.

On upgrade, existing team memory moves to the `legacy` namespace. Personal memory stays in its existing namespace.
The database retains these rows; normal memory routes cannot select that namespace.
Operators must preserve a database backup before cutover. Recover notes only after the owner confirms their intended audience.
Do not bulk-copy the legacy namespace into shared team memory.

The sandbox reconciler retains working directories for identities marked `<owner>:retired:<assistant-id>`.
It continues to report their age. Operators export retained data before explicitly deleting the sandbox.
This retention does not make a retired sandbox available through terminal or file routes.
Artifacts without a verifiable source thread remain hidden. Restore their provenance only from verified publication receipts.
