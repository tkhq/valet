# Thread refactor rollback compatibility

The application migration preserves retired assistant profile fields, default flags,
and follow/schedule assistant addresses. Current models omit these fields, while
older binaries can still read them. New singleton identities default to the legacy
default flag. Both the workspace uniqueness index and legacy default index remain.
The upgrade keeps one assistant per owner and moves extra profiles to a retired
owner key, so no history is deleted.

Accepted limits during a rolling update or after a rollback:

- The workspace uniqueness index stays in place. A dev-v2 pod still reads and uses
  each owner's default assistant, but it cannot create a second assistant profile
  for that owner. One assistant per workspace is the point of this change.
- Do not delete an assistant while a dev-v2 build runs. Its delete archives the
  owner's default assistant, and the next delivery or orchestrator open then
  fails with "no default assistant ... after an insert conflict" until the
  current build runs again and restores the row. Keep the rollback window short.
- An open tab running the previous web bundle must reload. `GET` and `POST
  /api/orchestrator` and `POST /api/teams/:id/orchestrator` still answer, so older
  CLI builds keep working. The other routes that bundle calls, such as
  `/api/orchestrator/info`, `/api/orchestrator/children`, and `/api/assistants`,
  return 404.

Stored workflows keep the dev-v2 step type `orchestrator`, which the app labels
"Thread", so dev-v2 can validate and run them after a rollback or during a
rolling update. Boot removes only the top-level `assistantId`, which dev-v2 reads
as the owner's default. An older pod can write `assistantId` during a rolling
update. The new binary also removes the field when it reads a definition or a
version, so editing tools and run starts accept that workflow before the next boot.

Run `mise x node@22 -- node scripts/rollback/check-thread-rollback.mjs`.
The default baseline is `d3e9ede2e7788314dcbd319bfa9aaaa343d21b6a`.
The harness compiles actual migration, store, and routing code from the baseline
and current checkout. Four separate processes seed, upgrade, roll back, and
reopen one isolated on-disk PGlite database. Evidence is retained in the printed
temporary directory. It verifies identity, history, pending decisions, profile
values, followed-thread routing, and schedule addresses, including writes after
upgrade and rollback.

This is bounded storage and service compatibility, not a full older web/API server
deployment. The older binary cannot create a second assistant in a workspace while
the singleton index remains. Columns already deleted by an earlier development
build can be recreated, but their lost values require a backup to recover.

Validation on 2026-09-29: all four phases passed, and singleton migration tests
passed (2 tests). Live Slack interactivity has a separate
[validation procedure](../guides/live-slack-child-approval.md).

## Local validation environment recovery

The `rancher-desktop` context points to k3d in Colima on this machine. Docker
browser tests use the separate Docker Desktop daemon. Recovery kept that Docker
context unchanged. The Colima data filesystem was full and had orphan inode and
bitmap errors. After stopping its services and unmounting the data filesystem,
we saved a copy-on-write copy of the data disk, repaired the filesystem, and grew
it from 50 to 80 GiB. Kubernetes then reported `DiskPressure=False`, with about
30 GiB free. No application volumes or stopped user containers were deleted.

The backup remains at
`~/.colima/_lima/_disks/colima/datadisk.before-thread-repair`.
Do not restore it over a running VM. Keep it until the local environment has been
checked. The separate worktree PGlite data was not changed by this operation.

The nested Docker failure was independent: fuse-overlayfs mounted successfully
but executable files returned EINVAL. The startup probe now tests execution as
well as mounting and falls back to vfs. Real Docker browser lifecycle and API
checks passed after rebuilding the sandbox image.
