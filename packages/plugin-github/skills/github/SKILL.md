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
- `github.read_repo_file` — read a file from a repository. A PDF comes back as extracted text.

### Issues
- `github.list_issues` — list issues for a repo
- `github.get_issue` — get a specific issue by number
- `github.create_issue` — create a new issue
- `github.update_issue` — update an issue (title, body, state, labels, assignees)

### Pull Requests
- `github.list_pull_requests` — list PRs for a repo
- `github.get_pull_request` — get a specific PR by number
- `github.inspect_pull_request` — get detailed PR info (files, comments, check runs); set `includePatch` for the diff and `pathPrefixes` to scope to a folder
- `github.create_pull_request` — create a new PR
- `github.update_pull_request` — update a PR (title, body, state, labels, assignees)
- `github.merge_pull_request` — merge a PR
- `github.create_comment` - comment on an issue or PR. Supply optional `images` to attach sandbox images to a PR.
- `github.create_review` — post a PR review with optional inline comments; set `updateExisting` to replace its own previous review
- `github.request_reviewers` — request GitHub users, team slugs, or both for PR review; this does not change assignees

### Branches & Commits
- `github.create_branch` — create a branch from a ref
- `github.delete_branch` — delete a branch
- `github.list_commits` — list commits on a branch

### Search
- `github.search_code` — search code across repositories
- `github.search_issues` — search issues and PRs, up to 1000 results in one call. `@now-7d` and `@today-1w` in a date qualifier become ISO dates, so a workflow tool step can ask for the last 7 days.

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

### Attach images to a PR comment

Use any supported sandbox image files. No browser or capture step is required.

```
call_tool github:github.create_comment params={
  "owner": "acme", "repo": "widgets", "issueNumber": 42,
  "body": "Updated views",
  "images": [{"path": "/workspace/view.png", "alt": "Updated view", "caption": "New layout"}]
} summary="Post PR comment with images"
```

`body` is optional with images. Images appear before the body so open Markdown or HTML containers cannot hide them.
Supply 1 to 10 PNG, JPEG, GIF, or WebP files, up to 10 MiB each and 20 MiB total.
The result includes normal comment fields plus `imageUrls`, `assetsRef`, `assetsCommit`, and readable `activityText`.
Images stay on `refs/valet/pr-assets/<PR number>`, outside the PR diff and default branch fetches.
Public repository images are public. Private images require a logged-in GitHub browser with repository access.
Email, mobile push, Slack unfurls, and Valet channel views can show broken private images.
The App needs contents write, pull requests read, and issues write permissions.
Image operations have a 120-second deadline. On expiry, check the PR before retrying.
A single token (often the org's App installation token) supports roughly 50 to 60 image writes per 120 seconds, and interleaved heavy bursts time out together (8 of 9 ten-image batches timed out in review), with same-token upload serialization a possible follow-up, not implemented here.
Each alt text and caption accepts up to 1,000 characters. Body, encoded text, and reserved URL space must fit within 60,000 characters.
Keep the assets ref while comments need the images. Ref deletion does not securely erase Git objects or cached images.
Custom refs are invisible in the branch and tag UI. Branch and tag rulesets do not cover this namespace.
Owners list refs with `git ls-remote origin 'refs/valet/*'`.
Owners delete a selected ref with `git push origin :refs/valet/pr-assets/<PR>`.
API equivalents: `GET /repos/{owner}/{repo}/git/matching-refs/valet/pr-assets/` and `DELETE /repos/{owner}/{repo}/git/refs/valet/pr-assets/{PR}`.
Deletion can break image retrieval. Retention relies on standard Git ref reachability, not a demonstrated garbage-collection test.
If storage succeeds but commenting fails, the error includes recovery Markdown. Retry with that Markdown in `body`, without `images`.
Check the PR before retrying after a lost response, because a comment might already exist.

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
