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

GitHub attributes action writes to the resolved user account or App bot.
The v2 actions do not add personal co-author trailers or an on-behalf-of suffix.

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

### Attach images to a PR comment

Use any supported sandbox image files. No browser or capture step is required.

```
call_tool github:github.create_comment params={
  "owner": "acme", "repo": "widgets", "issueNumber": 42,
  "body": "Updated views",
  "images": [{"path": "/workspace/view.png", "alt": "Updated view", "caption": "New layout"}]
} summary="Post PR comment with images"
```

`body` is optional with images. Images appear after the body.
Supply 1 to 10 PNG, JPEG, GIF, or WebP files, up to 10 MiB each and 20 MiB total.
The result includes normal comment fields plus `imageUrls`, `assetsBranch`, and `assetsCommit`.
Images stay on `valet-pr-assets-<PR number>`, outside the PR diff.
Public repository images are public. Private images require GitHub repository access.
The App needs contents write, pull requests read, and issues write permissions.
Keep the assets branch while comments need the images. Branch deletion does not securely erase Git objects or cached images.
If storage succeeds but commenting fails, retry with the returned URLs in `body`, without `images`.
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
