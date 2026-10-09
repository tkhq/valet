# Legacy continuity through the thread refactor

## Decision

Preserve existing work and behavior during upgrade. The user explicitly prioritizes continuity over introducing narrower information boundaries within an organization. Existing chats must remain writable, and existing workflows must retain their files, scripts, permissions and execution state.

This contract supersedes the legacy read-only, automatic cancellation, permission quarantine and automatic runtime redirection requirements in the thread execution isolation specification. It does not authorize access across organizations or grant new privileges to unrelated accounts.

## Runtime strategy

Retain existing runtime session IDs and working directories in place. Threads continue to own conversation history and agent turns; sessions continue to own sandboxes and recovery. Do not copy or relocate working directories during this cutover. Copying creates divergent files and can break absolute paths, running processes and workflow dependencies.

Record the existing conversation-to-runtime and workflow-to-runtime relationships durably before the first upgraded runtime restore. Classify existing relationships once, not by a timestamp heuristic or a process-local flag. Repeated migration must not classify newly created conversations as legacy.

Existing relationships take precedence over allocating an isolated execution. An existing Slack conversation, helper or workflow report must resolve to its original thread and runtime. New conversations use the new execution model. New runs of existing workflows retain their established file/runtime dependencies; a new run ID must not silently select an empty working directory.

Where an execution mapping already exists from an earlier prerelease, preserve that mapping and its files. Never merge two divergent working directories automatically or redirect an admitted dispatch to another runtime.

## Required behavior

- Existing chat URLs and thread IDs remain usable for reading and prompting.
- Runtime restoration does not abort submissions or withdraw approvals merely because the runtime predates isolation.
- Existing sandbox file, terminal and supported credential access remains available under the prior ownership rules.
- Existing personal allow overrides retain their prior effect. Keep their original user, organization, action and parameter restrictions. New workflow-scoped grants retain their new scope.
- Workflow definitions, versions, schedules, subscriptions, checkpoints and dispatch receipts retain their identities.
- Workflow reporting and channel replies return to their existing conversation.
- Existing team memory retains its shared paths and read/write behavior, including from legacy runtimes and workflow steps.
- Retained artifact links preserve their prior access contract. Do not require new source-thread metadata solely to keep a previously authorized artifact available.
- The new model must not introduce audience-based rejection for an existing supported workflow combination within its original ownership boundary.
- Explicit user deletion, revocation and archival remain effective. Migration must not resurrect intentionally deleted work.

## Carried-over assistant profile

The workspace runtime removed `assistants.name`, `avatar_url`, and `personality` from the Drizzle schema and from a fresh database. An upgraded database still holds these columns. `assistants/legacy-profile.ts` reads them read-only through `to_jsonb`, so a database without the columns reads null and does not fail. Nothing writes them.

- **Reply identity.** The name and avatar are the workspace's base channel identity (`services/workspace-sender.ts`). Workflow, subscription, and action presence still override each field. Without a carried-over name, team and organization posts use the owner's name and personal posts use the bot identity.
- **Prompt name.** A carried-over name opens the persona prefix: "You are <name>."
- **Personality precedence.** Before the upgrade, a set column won over the `assistant/personality.md` memory file, and `""` in the column was an explicitly neutral persona. The file could already exist then: `PATCH /api/orchestrator/info` wrote it on every personality save, and the assistant could write it with its memory tools. After the upgrade the file is the only personality that anyone can change. The prompt therefore uses the column while the file is absent or unchanged since the upgrade, and the file when someone wrote it after the upgrade. The upgrade time is the `applied_at` of the `legacy-runtime-continuity-v1` row in `__valet_app_migrations`, compared with the file's `updated_at`. A null column uses the file, as before. An OKF import keeps the bundle's timestamp, so an imported pre-upgrade file does not count as a later edit.

## Recovery and external actions

Use the existing fenced queue, approval and checkpoint recovery protocols. Preserve completed tool results and dispatch IDs. Do not replay completed external actions to reconstruct state.

If the old system cannot establish whether an external action completed, retain its state and report that uncertainty through the existing recovery mechanism. Do not mark it completed or repeat it merely to make migration appear successful.

Keep internal credentials runtime-managed. The dashboard script's legacy RUNNER_TOKEN dependency is a separate script/API compatibility issue; substituting a token name does not establish endpoint compatibility.

## Implementation surfaces

1. Database repair and assistant routing: persist compatibility relationships and consult them before ensureAssistantExecution allocates a runtime.
2. EngineHost and session responses: remove migration-only read-only behavior for retained runtimes; preserve pending work on restore.
3. Session resource access: restore established legacy access while retaining ownership checks and new execution rules.
4. Workflow dispatch, report targeting and memory resolution: preserve legacy targets, file dependencies and memory scope across new runs and restart.
5. Policy loading and artifact access: honor existing grants and access contracts without inventing broader grants.
6. Web and CLI: keep existing links writable and verify that selecting an existing conversation does not silently create another one.

Update the existing isolation and migration-check documents with the implementation. Do not leave contradictory upgrade guidance.

## Acceptance evidence

Use an old-schema fixture with two team chats sharing a working directory, a script, a relative file dependency, shared memory, an existing allow rule, an artifact, a scheduled workflow, a pending approval and a completed external tool result.

Upgrade and restart twice. Verify stable conversation/runtime IDs, unchanged file hashes, working script execution, writable old chats, preserved approval state, unchanged permission decisions and a new scheduled run using the original files. Verify the completed external action executes only once. Verify new conversations still use the new runtime model and another organization cannot access retained state.

Run the repository's full validation and an independent review. Rehearse the same assertions on an isolated copy of each deployment's database and working directories before rollout. Disable outbound integrations and schedules in that copy. Preserve and test the pre-upgrade restore path. Repository tests alone cannot certify production data or infrastructure readiness.

## Workspace history discovery

The current workspace thread list includes snapshot-proven legacy runtimes with matching organization and ownership. This includes duplicate identities retired by the singleton migration. Threads keep their original runtime, files, identifiers, titles and archive state. Search covers their persisted messages. Opening or continuing a listed thread addresses that original runtime. Deleted sessions and explicitly retired identities remain excluded.

The regression seeds retained history, replaces the workspace entry point, and checks listing, reading, continuation, search and archive transitions.
