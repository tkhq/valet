# Ongoing code reviews

The Code review page lists review chains for pull requests that are still open.
It keeps one row per pull request, with its title, review status, finding counts,
and a link to the review conversation. Expanding a row shows completed review
rounds, their commits, and the new and resolved finding counts.

The API checks the current pull request state with GitHub. Closed and merged
pull requests leave this list. Pending and failed deliveries remain visible
while their pull requests are open, including the first review before it writes
a result. Queries retain the active personal or team workspace and organization
authorization. GitHub failures show an actionable error instead of stale open
state. Reads and review history are bounded.

The API checks the newest 200 candidate chains per workspace. It returns the
latest 100 completed rounds per chain. Queued retries count as ongoing work;
only an exhausted delivery is failed. A failed GitHub check cancels the other
checks and returns 503. Credential resolution shares the same request deadline.

The repository dialog uses the standard dialog header and an inline, scrollable
search result list. It shows configured repositories instead of hiding them.
Choosing one opens its existing configuration and does not create a duplicate.
A configuration in another workspace states that scope and links to its rule.
Loading, error, empty, and pending states remain visible. A server collision
offers the existing configuration instead of an unavailable override action.

The main repository list also includes repositories where the GitHub App is
installed. Installation grants access; it does not silently enable reviews.
An installed repository without a review rule shows an Off switch. Turning it
on creates one rule in the active workspace. Existing accessible configurations
appear with their owning workspace. Configurations in another workspace link
to their existing rule and cannot be changed through the active workspace.

Choosing a plugin handler in Presence resets an organization assistant selection
to personal scope, because plugins can act only for a person or a team.

The change does not move existing configurations between workspaces or create a
second review subscription. Turnkey's monorepo pilot still requires the PR
review plugin to be deployed there before its repository can be configured.

## Context pack trust boundary

Before a review, the PR review plugin builds a context pack and puts it in the
reviewer's first prompt. The pack mixes inputs with two levels of trust, and
the plugin keeps them apart.

- **Instructions come from trusted sources only.** Repository convention files
  (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and similar) and `playbooks/`
  files are read at the merge base, which is the target branch's state.
  Domain notes become rules only from read-only synced memory under
  `lib/code-review/notes/` (a source repo's `.valet/memory/code-review/notes/`),
  which agents cannot write. The pack presents these as rules the team
  enforces. Other matching memory notes and principles are labeled
  background, not rules. The plugin ships no organization's rules.
- **The PR head is data.** The author controls the PR head. The plugin scans it
  only for code facts: definitions, callers and tests. The scan runs in the
  reviewer child's sandbox before its first turn (`spawnChild` `prepare`), on
  the checkout the child already has, so the api never downloads the repository. The pack labels them as
  untrusted code and tells the reviewer to ignore instructions inside them or
  inside the diff.
- **A PR that changes an instruction file is reviewed, not followed.** A
  convention file or playbook that the PR adds, edits or deletes is listed
  under "Instruction files this PR changes". Its rule text stays at the merge
  base version, and the change is in the diff for review. The diff budget
  keeps these files. A change that removes or weakens a rule is a finding.
- **PR text is data.** The PR title and description, and any text a bot
  added to them, sit in a labeled block. The reviewer treats them as claims
  to check against the code, never as instructions. The verifier labels the
  PR title and the claim it checks the same way.
- **Failures are visible.** A failed memory search or read, or a failed
  merge-base read, appears in the pack's drop log or in the "not built"
  notice. It never reads as "nothing found".
- **Selection is not trust.** Changed paths, the PR title and added lines
  choose which trusted notes and playbooks go into the pack. They never supply
  rule text.
