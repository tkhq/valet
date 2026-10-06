# Thread execution isolation

Workspace ownership controls credentials, policy and billing. Conversation audience controls transcripts, files, memory and sandbox tokens.
Keep one workspace assistant in the UI. New team conversations use an execution session and governing thread under a unique mapping.
The [legacy continuity contract](2026-10-06-legacy-continuity-design.md) governs existing runtimes and takes precedence over new allocation.
Concurrent creation shares the team-deletion lock. Restart restores the stored execution identity; missing or cyclic ancestry fails closed.
Helpers, editors, web threads, events and workflow reports resolve their execution before uploads or prompt admission. Children inherit their parent audience.
Runtime ensure returns a writable helper target and the team workspace root separately. The web rail lists/creates through the root; shared conversations keep their own execution IDs. Empty roots never synthesize read-only default chats.
Deleting a person's helper allows a fresh helper identity on next open, without restoring its deleted execution or files. Deleted shared execution keys stay retired.
Private Slack audiences require current membership. Team API keys cannot access private executions. Configuration changes evict all mapped execution catalogs.

Shared web conversations and originless team workflows use the existing team memory corpus, including writes, exports and imports. Private and external conversations retain execution namespaces; their reads, searches and snapshots expose shared team memory under `team:<id>/`. Shared projections are read-only; publication requires a separately authorized copy.
Workflow agent steps inherit their origin's memory scope. A legacy mixed-audience origin resolves by its thread, never by the root alone. Slack-event workflows use a stable workflow/channel scope, narrowed by the origin when present. New thread-step dispatch with both a Slack event and a separate conversation origin is rejected because the runtime cannot enforce both audiences. Recorded legacy workflow/runtime relationships retain their existing behavior. Missing channel or origin provenance fails closed. A new run ID does not reset persistent memory.
Filesystem, terminal, artifacts, memory and child-work routes apply governing-thread authorization; team administration alone cannot read another member's private helper.

## Upgrade and recovery

Retain legacy working directories and writable runtimes in place. A one-time upgrade snapshot records their original ownership, conversations and workflow targets. Existing execution mappings take precedence.
Restore queued/interrupted submissions and pending approvals through the existing fenced recovery protocol. Keep completed tool results and admission receipts; do not replay work merely because routing changed.
Workflow nodes and reports use recorded legacy targets. Migration-retired duplicate identities keep their original runtime and ownership through the compatibility snapshot. Explicit deletion and archival remain effective.
Existing team memory retains its original paths and team permissions; personal memory is unchanged. The namespace column isolates new private writes without reclassifying old team files. Back up the database and working directories before cutover.
Earlier pre-release databases may contain team files in `legacy`. Boot restores them to the shared namespace atomically. A shared-path collision stops boot with both versions retained: inspect and explicitly rename or reconcile the conflict before retrying. Private execution namespaces are untouched.
This is a one-way schema cutover: stop old writers before repair. Rollback requires restoring the pre-upgrade database and files, not reusing migrated data.
Existing personal overrides retain their prior effect under their original user, organization, action and parameter restrictions, including rows marked `legacy_unscoped`. New workflow grants remain scoped to their definition.
Upgrade the server before shipping the new CLI. Retired assistant profile/read endpoints are intentionally removed; integrations must use workspace runtime/thread routes before cutover. Legacy POST ensure aliases remain for older clients against the new server.

`GET /api/workspaces/:workspace/history` lists retained root/retired conversation IDs without waking sandboxes.
Its encrypted viewer/workspace-scoped `nextCursor` is accepted as `before`; `sessionId` and `threadId` select authorized transcript pages, newest first.
Current membership and thread audience apply to every page. Hidden identifiers never appear in cursors.
Sandbox reconciliation retains legacy working directories and reports their age. Operators export before explicit deletion.
The hibernation reaper excludes legacy team roots. On hibernation-capable backends, executions leave cache after the existing idle window when submissions, gates and exec jobs finish; mappings, history and files remain.
Runtime presence checks only running sessions and active child watches. Thread lists filter archived-only executions before loading histories; archived history remains available on request.
Originless workflow runs receive separate report executions. Report archival evicts only after submissions and decisions finish; origin executions remain available.
Execution directories and histories are retained deliberately; archival is not deletion. Idle compute follows backend hibernation, and explicit execution/team deletion owns sandbox and token teardown. Do not merge working directories or purge retained data to reduce conversation counts; production-copy rehearsals must verify retained-file capacity and recovery.

## Artifact cutover gate

Run this procedure against both target database copies before release. Keep content, tokens and receipts in private deployment records.
Inventory live team artifacts with a source session and no source thread:

```sql
SELECT id, org_id, owner_id, source_session_id, source_memory_path, version, updated_at
FROM artifacts WHERE owner_type = 'team' AND source_session_id <> ''
  AND source_thread_id IS NULL AND revoked_at IS NULL ORDER BY org_id, owner_id, id;
```

Compare existing artifact IDs, tokens, owners, visibility and revocation state before and after migration. Verify intended readers keep access and unrelated organizations do not gain it.
Retained publications do not require reconstructing source-thread metadata. New publications still record and enforce their source audience.
Artifacts from snapshot-proven legacy runtimes retain their prior access contract and publication token. Missing source-thread metadata alone does not quarantine them. New unverified sources remain restricted.
Record access/recovery dispositions and repeat the inventory. Unexplained changes block cutover; code review cannot certify target data.

## Delivery and briefing recovery

Slack-event workflow chaining stays blocked until child runs carry the channel audience. Linked-account admission remains required.
Slack ingress and workflow events drain independently. At most ten inbox rows process concurrently, with renewed fenced leases.
After ten failures, retain the encrypted payload, set `failed_at`, and record `slack_delivery_failed` atomically.
Operators inspect receipt stages and repair consumers before resetting the verified organization's delivery to `attempts=0`, `failed_at=null`, `next_attempt_at=0`.
Do not delete accepted payloads. Durable dispatch IDs prevent replay from starting another admitted turn.
Shared briefing evidence and cached responses require public Slack classifications checked within five minutes, including event-only sources and effects.
Outages exclude expired evidence. Refreshes renew leases through collection/generation/validation; replaced workers cannot publish or renew.

## Validation

Owned workflow starts and definition deletion share a row lock; team starts also hold the team ownership lock. Repository cleanup rechecks unsettled runs under that row lock. A deleted definition cannot start from a stale snapshot.

Test Alice/Bob isolation across tools, memory, uploads, terminal, children and restart; preserve team credentials and current lender grants.
Test missing origins, allocation/deletion races, repeated repairs and retained history without importing ambiguous state.
Workspace channel/history reads match session and thread IDs before limits and retain governing visibility.
Run the separate [database-copy checks](../testing/migration-checks.md) for both deployments.
