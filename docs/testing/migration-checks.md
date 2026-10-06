# Workspace upgrade checks

The maintained `drizzle-singleton.test.ts` suite checks retained workflows, transcripts, shared memory read/write continuity, and repeated repairs.

## Target-data rehearsal for each deployment

1. Identify the running commit and database backend; do not substitute an older dev deployment.
2. Take a consistent database backup and preserve retained working directories. For embedded PGlite, use a supported consistent snapshot or stop its owner before copying; do not copy open database files.
3. Restore the backup to an isolated environment. Keep live provider credentials, schedules, webhook ingress and outbound network activity disabled. Do not start a copied production API with working integrations.
4. Record IDs and content hashes for workflows, versions, run history and transcripts; record schedules, subscriptions, pending work and approvals separately, including legacy personal allow overrides.
5. Apply the candidate migration to the copy. Compare retained records and explicitly inspect the expected status changes listed below. Apply it again and verify idempotence.
6. Perform the artifact provenance inventory and recovery decisions in the thread-execution isolation spec. Verify authorized and unauthorized history access before cutover.
7. Restore the pre-upgrade backup into another isolated database and repeat the preservation comparison. Record restore duration and retained file recovery.
8. Keep a private per-deployment result record. Unexplained access or data changes block cutover.

## Expected changes, not data loss

Existing personal allow overrides retain their prior effect. The one-time continuity snapshot preserves original runtime ownership, thread IDs and workflow targets before singleton normalization. Migration-retired duplicate identities remain usable through those recorded relationships. Explicitly deleted or archived work stays deleted or archived.

Legacy chats remain writable on their original working directories. Runtime restoration preserves pending approvals and uses existing fenced submission recovery. New runs of recorded workflows retain their runtime dependencies. Existing team memory keeps its paths and permissions; conflicting recovery paths retain both versions and stop repair rather than overwrite data. Legacy artifact links retain their prior access contract and token. New execution mappings and new artifact access rules remain effective.

After two restarts, run an existing script with its relative file dependencies, continue an old chat, inspect its pending approval, and start a new run of an old workflow. Confirm original runtime IDs, file hashes and permission decisions. Retry an event admitted before cutover and confirm it does not create another submission.

See [thread execution isolation](../specs/2026-10-05-thread-execution-isolation-design.md) for the required artifact inventory and the recovery boundaries. Schema preservation checks do not prove runtime cutover or access behavior. Verify those separately with the focused engine and API regression suites.
