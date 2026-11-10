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

The reviewer's prompt holds at most 50,000 characters of the PR diff, the
engine's `read` cap (`READ_MAX_CHARS`, about 25,000 tokens), in the plugin and
in the standalone runner (2026-11-10). Before, it held 150,000 characters.
`cutPatch` keeps whole files and lists the files it leaves out, and the
reviewer runs `git diff` for them.
