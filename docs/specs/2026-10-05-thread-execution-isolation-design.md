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
The hibernation reaper also excludes legacy team roots. Isolated executions keep the normal retention policy.
Legacy team artifacts with an unknown source thread remain hidden on token, comment, version, and management routes as well as lists. Restore their provenance only from verified publication receipts.

## Shared briefing privacy

Team briefings require a public Slack classification checked within five minutes.
The same bound applies to collected evidence and cached responses, including event-only workflow runs and their effects.
Expired classifications exclude evidence until a successful channel check refreshes them. An outage must not extend a shared briefing's public classification.

## Slack delivery recovery

Slack ingress drains independently of workflow event delivery. One slow media download cannot block unrelated workflow events.
The durable inbox retains an encrypted delivery after ten failed processing attempts.
It records `failed_at` and a `slack_delivery_failed` problem. Automatic drains exclude these records.
An operator inspects the delivery's receipt stages and repairs the failing consumer before replay.
To replay, reset `attempts` to zero, `failed_at` to null, and `next_attempt_at` to zero for the verified organization and delivery ID.
Never delete the accepted payload to clear the error. Durable engine dispatch IDs prevent a previously admitted message from starting another turn.

## Blocking artifact cutover check

Run this check against each target database before enabling the refactored deployment.
Use an operator connection. Do not paste artifact content or publication tokens into shared review comments.

1. Back up the database and retained working directories.
2. Inventory affected artifacts with the query below.
3. Inspect the recorded source session for a successful `artifact_publish` or `mem_share` tool call and its paired tool result.
4. Match the exact artifact token, normalized publish key, and current version's content against that receipt.
5. Verify that exactly one existing thread satisfies the evidence. Verify its organization and owner.
6. Record the receipt entry IDs and version in the private deployment record.
7. Lock the artifact row in a transaction. Repeat the version, source session, and null-thread checks before updating `source_thread_id`.
8. Test access as the intended reader and as an unauthorized team member.
9. Repeat the inventory. Stop cutover if any row lacks verified provenance or an owner-approved recovery disposition.

```sql
SELECT a.id, a.org_id, a.owner_id, a.source_session_id,
       a.source_memory_path, a.version, a.updated_at
FROM artifacts a
WHERE a.owner_type = 'team' AND a.source_session_id <> ''
  AND a.source_thread_id IS NULL AND a.revoked_at IS NULL
ORDER BY a.org_id, a.owner_id, a.id;
```

A quoted URL in an ordinary message is not a publication receipt.
The publishing actor and default thread are not proof of audience.
If the latest version cannot be verified, keep the artifact quarantined.
Ask its owner to recover and republish it from an authorized conversation, or explicitly accept quarantine in the deployment record.
Never assign an arbitrary shared thread to clear this check.

This procedure is a release gate, not an automatic backfill. A code review cannot certify the target database's recovery state.

## Briefing refresh ownership

A refresh renews its lease during collection, generation, and validation, including background refreshes.
Only the worker holding the current lease token can publish or renew.
If its deadline expires without another worker taking ownership, it can publish its validated result.
A replaced worker cannot overwrite the new owner's result.
