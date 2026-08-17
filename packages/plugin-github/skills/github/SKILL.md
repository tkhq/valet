---
name: github
description: How to use GitHub integration tools — list repos, create PRs, manage issues, read files. Covers token model, available actions, attribution behavior, and common patterns.
---

# GitHub Integration Tools

You interact with GitHub through integration actions, NOT the `gh` CLI (which is not available in sandboxes).

## Quick Start

```
list_tools service=github    # Discover available GitHub actions
call_tool github:github.<action_id> params={...} summary="..."
```

## Token Model

GitHub actions use a single token resolved automatically:

- **User token (primary)** — personal OAuth token linked on the integrations page. Access to the user's own repos (public + private).
- **Bot token (fallback)** — org GitHub App installation token. Access to repos in organizations where the App is installed. Used when the user has no personal token or the action targets an org repo covered by the App.

The system resolves the best available token for each request. You do not pass a `source` parameter — credential routing is handled automatically based on the `owner` of the target repo.

**Anonymous access:** If configured by an admin, unauthenticated access to public repos may be available.

## Attribution

When acting under a bot token (App install), actions automatically add attribution so the user's identity is visible:

- **Commits** — `Co-Authored-By: <name> <email>` trailer appended to commit message
- **PR and issue bodies** — a suffix noting the action was performed on behalf of the user

Users connect their personal GitHub account at **Settings → Integrations → GitHub**.

## Available Actions

### Repository
- `github.list_repos` — list repositories accessible via the resolved token
- `github.get_repository` — get repo details by owner/name
- `github.create_repository` — create a new repository
- `github.fork_repository` — fork a repository
- `github.read_repo_file` — read a file from a repository

### Issues
- `github.list_issues` — list issues for a repo
- `github.get_issue` — get a specific issue by number
- `github.create_issue` — create a new issue
- `github.update_issue` — update an issue (title, body, state, labels)

### Pull Requests
- `github.list_pull_requests` — list PRs for a repo
- `github.get_pull_request` — get a specific PR by number
- `github.inspect_pull_request` — get detailed PR info (files, comments, check runs); set `includePatch` for the diff and `pathPrefixes` to scope to a folder
- `github.create_pull_request` — create a new PR
- `github.update_pull_request` — update a PR (title, body, state, labels)
- `github.merge_pull_request` — merge a PR
- `github.create_comment` — comment on an issue or PR
- `github.create_review` — post a PR review with optional inline comments; set `updateExisting` to replace its own previous review

### Branches & Commits
- `github.create_branch` — create a branch from a ref
- `github.commit_files` — create or update files and commit them to a branch, all in one commit
- `github.delete_branch` — delete a branch
- `github.list_commits` — list commits on a branch

### Search
- `github.search_code` — search code across repositories
- `github.search_issues` — search issues and PRs

### Releases & CI
- `github.create_release` — create a release with tag
- `github.list_workflow_runs` — list GitHub Actions workflow runs

## Common Patterns

### Create a PR after committing changes
```
# Use git CLI for local operations
git checkout -b feature/my-change
# ... make changes, commit ...
git push -u origin feature/my-change

# Use integration tool for PR creation (not gh CLI)
call_tool github:github.create_pull_request \
  owner=<owner> repo=<repo> \
  title="My change" body="Description" \
  head="feature/my-change" base="main" \
  summary="Create PR for feature/my-change"
```

### Write files to a branch without a clone
Use this when the sandbox has no clone of the repository, or when git push is
not available. `github.create_branch` makes an empty branch, and a pull request
needs a branch that carries commits — `github.commit_files` is the step between.

```
call_tool github:github.create_branch \
  owner=<owner> repo=<repo> branch="feature/my-change" \
  summary="Branch for my change"

call_tool github:github.commit_files \
  owner=<owner> repo=<repo> branch="feature/my-change" \
  message="Add the design note" \
  files='[{"path":"docs/design.md","content":"# Design\n..."}]' \
  summary="Commit the design note to feature/my-change"

call_tool github:github.create_pull_request ...
```

Rules that action holds you to:

- Name the branch. The action never picks one, and it refuses the repository's
  default branch unless you pass `allowDefaultBranch=true`. Pass the name
  exactly as `github.create_branch` made it — a name Git itself refuses, such
  as one holding `..`, is rejected before any request goes out.
- To REPLACE a file, read it first with `github.read_repo_file` and pass its
  blob `sha` as that file's `expectedSha`. Without `expectedSha` the action
  only creates a file that is not there yet, so it cannot overwrite work you
  have not read. A stale `expectedSha` is refused, and the error carries the
  current SHA.
- Send every file of one change in ONE call. All the files land in a single
  commit, so a failure leaves the branch untouched instead of half written.
- The action only adds a commit. It never forces a branch and never rewrites
  history.

### List all repos you have access to
```
call_tool github:github.list_repos summary="List accessible repos"
```

### Read a file without cloning
```
call_tool github:github.read_repo_file \
  owner=<owner> repo=<repo> path="README.md" \
  summary="Read README from owner/repo"
```

## Important Notes

- The `gh` CLI is NOT available. Always use `call_tool` with GitHub actions.
- Use git CLI for local operations (checkout, add, commit, push, pull).
- Use `report_git_state` after checking out branches or making commits.
- The `summary` parameter on `call_tool` is required for medium/high risk actions (like creating PRs). Make it descriptive.
- If a GitHub action fails with an auth error, the user may need to connect their account at Settings → Integrations → GitHub.
