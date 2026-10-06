# Workspace upgrade checks

The maintained `drizzle-singleton.test.ts` suite checks retained workflows, transcripts, legacy memory quarantine, and repeated repairs.

## Target-data rehearsal for each deployment

1. Identify the running commit and database backend; do not substitute an older dev deployment.
2. Take a consistent database backup and preserve retained working directories. For embedded PGlite, use a supported consistent snapshot or stop its owner before copying; do not copy open database files.
3. Restore the backup to an isolated environment. Keep live provider credentials, schedules, webhook ingress and outbound network activity disabled. Do not start a copied production API with working integrations.
4. Record IDs and content hashes for workflows, versions, run history and transcripts; record schedules, subscriptions, pending work and approvals separately, including legacy personal allow overrides.
5. Apply the candidate migration to the copy. Compare retained records and explicitly inspect the expected status changes listed below. Apply it again and verify idempotence.
6. Perform the artifact provenance inventory and recovery decisions in the thread-execution isolation spec. Verify authorized and unauthorized history access before cutover.
7. Restore the pre-upgrade backup into another isolated database and repeat the preservation comparison. Record restore duration and retained file recovery.
8. Keep a private per-deployment result record. Missing provenance or unexplained differences block cutover.

## Expected changes, not data loss

Existing personal allow overrides require explicit reapproval because legacy workflow permissions lack workflow provenance; deny and approval rules remain enforced and override rows remain retained. Duplicate assistant identities retire; their session rows remain but are marked deleted in active listings. Legacy mixed-audience team conversations become read-only. Runtime restoration aborts their pending submissions and withdraws their decision gates without replaying tools. Workflow definitions and settled history remain; obsolete assistant routing fields are normalized. Missing or retired explicit workflow origins fail closed rather than redirecting to another audience. Team memory and artifacts with ambiguous provenance remain retained for authorized recovery instead of becoming shared automatically.

See [thread execution isolation](../specs/2026-10-05-thread-execution-isolation-design.md) for the required artifact inventory and the recovery boundaries. The schema rehearsal does not boot the runtime; cutover and access behavior is covered separately by the focused engine and API regression suites.
