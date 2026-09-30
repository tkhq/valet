# Threads and Events local review

This branch contains the workspace routing foundation and local review fixtures.

## Start

Use Node 22 and the repository's pinned pnpm version.

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm typecheck` to build workspace dependencies.
3. Configure `ANTHROPIC_API_KEY` in the local `.env` file.
4. Set `VALET_LOCAL_AUTH=1` in that file.
5. Keep `DATABASE_URL` unset to use the isolated worktree database.
6. Run `make dev-local`.
7. Open `http://localhost:5173`.

If a native module reports a Node ABI mismatch, run `pnpm -r rebuild better-sqlite3` under Node 22.

## Seed examples

The seed uses only localhost and requires the local stub identity.
It creates personal and team threads through existing APIs.
It writes labeled transcript and diagnostic fixtures while the API is stopped.
It does not send model prompts, receive Slack callbacks, or connect an integration.

1. With the API running, run `node scripts/seed-threads-demo.mjs bootstrap`.
2. Run `make dev-stop`.
3. Run `node scripts/seed-threads-demo.mjs offline`.
4. Run `make dev-local`.
5. Open a conversation URL printed by the seed command.

The manifest lives in `.valet-dev/threads-demo.json`, or in `VALET_DATA_DIR` when `.env` sets it. Export the same value before you run the seed.
Repeated offline seeding preserves later conversation branches.
Use a new empty worktree database to repeat the initial setup from scratch.

## Review

- Open Threads. Switch between Personal and Threads Demo.
- Open the labeled release and NDA conversations. Reload to verify persisted history.
- Create a new thread using the existing thread control.
- Open Events, then Problems. Read each explanation without opening a disclosure.
- Search Problems for `NDA`, then for a term with no matches.
- Confirm Sessions and Artifacts are absent from primary navigation.
- Open team settings. Confirm its Threads link opens that team workspace.
- Open an unavailable workspace URL. Confirm it reports an error without personal history.

The fixtures prove persistence and UI behavior. They do not prove live Slack admission or successful workflow execution.
Work discovery, artifact placement, home-channel delivery, and event presets remain subsequent phases.

## Pull request and unread state

With the API running, run `node scripts/seed-threads-demo.mjs pull-requests`.
Stop the API, run `node scripts/seed-threads-demo.mjs offline`, and start it again.
The seed adds two personal threads that name xors-software/xors-valet pull requests.
The XORS deployment shows the same two threads.

- "[Demo] Dependency bump PR (open)" shows the open icon and an unread dot. It also appears under **Waiting on you**.
- "[Demo] Typebox lockfile fix (merged)" shows the merged icon and reads as read.

The seed writes pull request state directly. It does not call GitHub.

## Team workflow check

With the API running, run `node scripts/seed-threads-demo.mjs workflow`.
Open the printed workflow URL. Confirm that the switcher adopts Threads Demo.
Select Run. Expand the check node result after the run completes.
The expected model response is `team-workflow-check-ok`.

This workflow uses a Thread node with the team owner and has no assistant selector.
Its node result exposes the durable `threadId` alongside the response. Running it uses
the configured model key. It does not call Slack or other integration tools.
