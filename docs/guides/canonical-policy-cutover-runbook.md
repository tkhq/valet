# Canonical policy cutover runbook

Use this runbook before releasing the PR 9 action authorization cutover. This procedure does not validate a live cluster.

The new release has no legacy evaluator or runtime fallback. Rollback replaces the complete application and engine release set.

## Required records

Record these values in the release ticket before the cutover:

- Candidate application commit.
- Previous application release identifier.
- Candidate engine digest.
- Previous engine digest.
- Database backup identifier.
- Start time and operator.

Do not continue if any value is missing.

## Pre-cutover checks

1. Check out the exact candidate commit.
2. Confirm that the worktree is clean.

```bash
git status --short
git rev-parse HEAD
```

3. Run the required repository checks.

```bash
cargo test --workspace --locked
pnpm --filter @valet/engine test
pnpm --filter @valet/workflow test
pnpm --filter @valet/api test policies action-invoker authorization
pnpm typecheck
make e2e
```

4. Run the read-only compatibility report against the release database.

```bash
DATABASE_URL="$DATABASE_URL" pnpm --filter @valet/api policy:compatibility > canonical-policy-compatibility.json
```

The command must exit zero and every organization report must have `"compatible": true`. The report contains row IDs and corrective actions, but no policy evaluation or matcher values.

5. Stop if any required check or compatibility report fails.
6. Create a database backup with the approved platform procedure.
7. Record all active policy pointers.

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --csv \
  --command 'SELECT org_id,digest,generation,activated_at FROM policy_active_bundles ORDER BY org_id' \
  > canonical-policy-pointers-before.csv
```

8. Confirm that every organization has one active pointer and stored bundle.

```bash
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --tuples-only --no-align <<'SQL'
SELECT count(*)
FROM orgs o
LEFT JOIN policy_active_bundles p ON p.org_id = o.id
LEFT JOIN policy_source_bundles b ON b.digest = p.digest
WHERE p.org_id IS NULL OR b.digest IS NULL;
SQL
```

The command must print `0`.

9. When the release contract changes, start an isolated candidate with `VALET_POLICY_RELEASE_MIGRATION=<release-id>`.

The pre-listen migration takes a global advisory lock. It validates every replacement before it updates any pointer. It preserves authored policy files byte-for-byte.

The migration revokes each active legacy runtime grant that lacks complete canonical evidence. The next matching action must request approval again. The migration records each revocation as `legacy_runtime_grant_revoked`.

The migration preserves parked workflow approval nodes. When an operator resolves one, the workflow must pass canonical authorization before its action runs.

Concurrent candidates can use the same release identifier. A candidate with a different identifier fails if another candidate changes the release set while it waits.

10. Remove the variable after the migration succeeds.
11. Start one candidate API process against the release database in the approved isolated environment.
12. Stop if canonical policy readiness prevents startup.
13. Confirm that the process reports healthy only after readiness completes.
14. Stop the isolated process.
15. Compare active pointers with `canonical-policy-pointers-before.csv`.
16. Investigate every pointer change before release approval.

Readiness can add a missing initial pointer. It must not replace a stale or invalid pointer.

## Cutover

1. Stop or drain action execution with the approved platform procedure.
2. Release the recorded candidate application and engine set.
3. Wait for every API process to complete canonical policy readiness.
4. Stop the rollout if any API process fails readiness.
5. Confirm API health on every new process.
6. Resume action execution only after all checks pass.
7. Record the final application commit and engine digest.

## Rollback triggers

Start rollback if any of these conditions occurs:

- An API process fails canonical policy readiness.
- An authorization audit reservation blocks valid execution.
- A policy write succeeds without advancing its expected pointer.
- A failed policy write changes an active pointer.
- Interactive and workflow decisions differ without a scope or fact difference.
- The canonical evaluator cannot load an active bundle.

## Rollback

1. Stop or drain action execution.
2. Keep the database backup and pointer record unchanged.
3. Deploy the recorded previous application and engine release set.
4. Restore the compatible active bundle pointers with the approved database procedure.
5. Use `canonical-policy-pointers-before.csv` as the restoration source.
6. Do not restore policy tables separately from their compatible pointers.
7. Start one API process in the approved isolated environment.
8. Confirm health and policy readiness for the previous release.
9. Start the remaining API processes.
10. Confirm health on every process.
11. Resume action execution.
12. Record the rollback time, release identifiers, and restored backup identifier.

Do not enable a same-process fallback. Do not run both evaluators. Do not deploy later policy surfaces during this rollback.

## Evidence

Attach these records to the release ticket:

- Candidate commit and previous release identifier.
- Full validation output.
- Database backup identifier.
- `canonical-policy-pointers-before.csv`.
- Readiness and health results.
- Cutover or rollback timestamps.

This runbook supplies deterministic release steps only. It does not claim that a live-cluster cutover was performed.
