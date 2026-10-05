# Workspace upgrade checks

Run the disposable schema rehearsal from a known deployment commit:

```sh
pnpm --filter @valet/api exec tsx scripts/rehearse-workspace-upgrade.ts <baseline-commit-sha>
```

The command reads the baseline's engine and application SQL from Git. It seeds an in-memory PGlite database with synthetic sessions, transcripts, workflow definitions, versions, settled runs and memory. It checks record preservation, expected memory quarantine, a second migration pass, and restoration of the pre-upgrade snapshot. It never reads `DATABASE_URL`, opens an existing database, starts the API or executes workflows.

A pass validates the seeded cases against repository schema. It does **not** certify the target database, large-data performance, stored files, production configuration, or rolling back by running an old binary against the migrated database. Restore is tested by loading a pre-upgrade snapshot.

## Target-data rehearsal for each deployment

1. Identify the running commit and database backend; do not substitute an older dev deployment.
2. Take a consistent database backup and preserve retained working directories. For embedded PGlite, use a supported consistent snapshot or stop its owner before copying; do not copy open database files.
3. Restore the backup to an isolated environment. Keep live provider credentials, schedules, webhook ingress and outbound network activity disabled. Do not start a copied production API with working integrations.
4. Record IDs and content hashes for workflows, versions, run history and transcripts; record schedules, subscriptions, pending work and approvals separately.
5. Apply the candidate migration to the copy. Compare retained records and explicitly inspect the expected status changes listed below. Apply it again and verify idempotence.
6. Perform the artifact provenance inventory and recovery decisions in the thread-execution isolation spec. Verify authorized and unauthorized history access before cutover.
7. Restore the pre-upgrade backup into another isolated database and repeat the preservation comparison. Record restore duration and retained file recovery.
8. Keep a private per-deployment result record. Missing provenance or unexplained differences block cutover.

## Expected changes, not data loss

Duplicate assistant identities retire; their session rows remain but are marked deleted in active listings. Legacy mixed-audience team conversations become read-only. Runtime restoration aborts their pending submissions and withdraws their decision gates without replaying tools. Workflow definitions and settled history remain; obsolete assistant routing fields are normalized. Missing or retired explicit workflow origins fail closed rather than redirecting to another audience. Team memory and artifacts with ambiguous provenance remain retained for authorized recovery instead of becoming shared automatically.

See [thread execution isolation](../specs/2026-10-05-thread-execution-isolation-design.md) for the required artifact inventory and the recovery boundaries. The schema rehearsal does not boot the runtime; cutover and access behavior is covered separately by the focused engine and API regression suites.
