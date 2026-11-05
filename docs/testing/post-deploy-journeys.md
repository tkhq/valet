# Post-deploy journeys

`scripts/post-deploy.ts` runs four real user journeys against a deployed Valet through the public API. It reports pass or fail for each journey, with the ids and timings it saw. Each journey creates throwaway resources and removes them after it finishes, pass or fail.

The journeys catch regressions that unit tests miss because the parts only fail together: an event delivery that never runs its turn, a turn that ends at the output limit, a workflow branch held behind a waiting step, and a saved permission that a tool step ignores.

## Journeys

| Id | What it does | Passes when |
|----|--------------|-------------|
| `event-delivery` | Creates two `github.push` rules for one repo and sender, then creates a throwaway branch in that repo. Rule A delivers to the assistant in its own thread. Rule B pins a thread that the journey archived first. | Rule A's delivery is `delivered`, the assistant turn ends with `end_turn`, no question is pending, and the event has no failed turn. Rule B's delivery is `dead`, and the event is in the events Log under the Problems filter with a reason. |
| `workflow-branches` | Runs a workflow with two branches: a 10-minute timer, and two `set` steps in sequence. | The run parks on the timer after both `set` steps complete. |
| `workflow-approval` | Saves an "ask first" permission for `workflows.get_workflow`, scoped to the journey's workflow id. Runs a workflow whose tool step calls that action. | The step parks with a tool approval card. Approve once lets the run finish with every step completed. |
| `mcp-call` | Calls one read-only integration tool through the tool broker (`linear.get_workspace` by default). | The call completes, or it fails with an error that names the integration and has no raw server text. |

The event journey does not forge a webhook. GitHub sends a real push event to the instance's GitHub App, as it does for any new branch.

## Run it

1. Create a personal API key for the test account in Settings > API keys. Agent credentials (`valet login`, MCP apps) cannot create workflows, approve, or write event rules.
2. Save the key in a file that only you can read, for example `~/.valet/post-deploy.key`.
3. Run the journeys:

```bash
VALET_API_KEY_FILE=~/.valet/post-deploy.key VALET_JOURNEY_GITHUB_REPO=tkhq/valet VALET_JOURNEY_GITHUB_TOKEN=$(gh auth token) make post-deploy
```

4. Read the report. The command exits 1 when a journey failed.

Other arguments go in `POST_DEPLOY_ARGS`:

```bash
make post-deploy POST_DEPLOY_ARGS="--list"
make post-deploy POST_DEPLOY_ARGS="--only workflow-branches,mcp-call --json"
```

## Settings

| Variable | Default | Use |
|----------|---------|-----|
| `VALET_URL` | Turnkey dev | The instance. |
| `VALET_API_KEY` or `VALET_API_KEY_FILE` | none (required) | The test account's personal API key, or a file that holds it. |
| `VALET_EXPECT_BUILD` | none | Wait until `/api/health` reports this commit before the journeys run. |
| `VALET_EXPECT_BUILD_TIMEOUT_MIN` | `45` | How long to wait for that build. |
| `VALET_JOURNEY_GITHUB_REPO` | none | The repo for the event journey. The instance's GitHub App must receive its events. |
| `VALET_JOURNEY_GITHUB_TOKEN` | `GITHUB_TOKEN`, then `GH_TOKEN` | A token that can create and delete branches in that repo. |
| `VALET_JOURNEY_GITHUB_SENDER` | the token's login | The GitHub login that the push comes from. In GitHub Actions, the default is `github-actions[bot]`. |
| `VALET_JOURNEY_MCP_TOOL` | `linear.get_workspace` | A read-only tool that the account can call without approval. |
| `VALET_JOURNEY_MCP_PARAMS` | `{}` | The tool's params as a JSON object. |

If the event journey has no repo or token, it is skipped. A skipped journey does not fail the run, and the report gives the reason.

## Read the report

Each journey prints one line with its status, then the evidence: resource ids, step states, and timings. A failed journey also prints `reason:` with the state it saw last.

If a cleanup does not finish, the report prints `LEFTOVER:` with the resource. To remove leftovers that an interrupted run left, run:

```bash
VALET_API_KEY_FILE=~/.valet/post-deploy.key make post-deploy POST_DEPLOY_ARGS="--sweep"
```

The sweep deletes the test account's workflows and event rules whose names start with `post-deploy journey`. It also deletes a saved permission that points at one of those workflows. Archived journey threads stay in the assistant's archive, because no route deletes a thread.

## Run after each rollout

`.github/workflows/post-deploy.yml` runs the journeys after each dev-v2 push reaches Turnkey dev:

1. It waits for CI on the commit. If CI does not pass, nothing rolled out, and the job stops.
2. It waits until dev reports the commit at `/api/health`.
3. It runs the journeys. The event journey uses the repo's own `GITHUB_TOKEN` to create and delete a branch in `tkhq/valet`.
4. It adds the report to the job summary. A failed journey fails the job.

The job does nothing until a repository admin adds this secret:

| Secret | Value |
|--------|-------|
| `VALET_POST_DEPLOY_API_KEY` | A personal API key of a dedicated Turnkey dev test account. |

Use a dedicated test account for the secret. The approval journey saves a permission on the account during the run, and the event journey adds turns to the account's assistant.

If CI cancels a superseded run, the script removes what the running journeys created before it exits.

## Limits

- The event journey forces a dead delivery with an archived thread. It does not force a failed assistant turn: no API input makes a turn fail on demand. A failed turn shows under Problems by the same Log query.
- No journey runs the long tool-heavy turn that hit the output limit after a prune. A turn that ends at the output limit fails the event journey, but a short turn rarely gets there.
- The journeys use the test account's personal workspace. Team workspaces and team permissions are not covered.
- The approval journey checks a saved permission on a tool step, not on an agent step.
