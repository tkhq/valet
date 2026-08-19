# Code review on mention, not on push

Date: 2026-08-19
Status: implemented
Packages: `plugin-github` (trigger catalog, `github.pull-request-review` template)

## Problem

The `github.pull-request-review` template subscribed to
`github.pull_request.opened`, `.synchronize`, `.reopened`, and
`.ready_for_review`. GitHub fires `synchronize` for every push to a pull
request branch, so every commit started a review run. Dev-v2 users reported
the reviews as noise: they wanted a review when they ask for one, by
mentioning the agent, not one per push.

Nothing in the trigger path could express "when a comment mentions the
agent". The filter matcher (`api/src/events/match.ts`) already had a
`contains` operator, but a filter can only name a field the event's catalog
entry declares, and the GitHub catalog declared no field over comment text.

## Decision

Gate the review at the subscription layer, on a mention in a comment.

1. **Catalog**: `plugin-github/src/triggers.ts` declares a `comment_body`
   filter field (path `comment.body`) on the `issue_comment` and
   `pull_request_review_comment` families. No matcher change — `contains`
   already existed.
2. **Template trigger**: the template subscribes to
   `github.issue_comment.created` with two filters: `repo eq` from the
   `repository` install input, and `comment_body contains` from a new
   required `mention` install input (e.g. `@valet`). The `pull_request.*`
   keys are gone. An unwanted event is now dropped at ingest, before a run
   starts, not inside a run that already paid to start.

The subscription layer is the right place for the gate because a workflow
run is the unit of cost. A guard node inside the DAG (the pattern
`github.assign-reviewers` uses for its decline watcher) still starts a run
per comment; a subscription filter starts none.

## Template consequences

The `issue_comment` payload names the pull request as `issue.number` and
carries no `pull_request` object, so the definition changed shape:

- **PR-versus-issue is a gate.** `issue_comment` fires for plain issues
  too, and the only payload marker is the `issue.pull_request` object — not
  a scalar, so no subscription filter can read it. A mention on an issue
  ends in a `stop` with outcome `success` (ordinary traffic, not a fault).
- **The bot guard moved to the commenter.** The run stops when
  `comment.user.login` contains `[bot]`. This is the loop guard: a bot that
  quotes the mention back — this workflow's own posts included — must not
  start the next run. The matcher has no negation, so this stays a node.
- **Drafts are reviewed.** The push-triggered shape skipped drafts because
  nobody had asked yet. A person who writes the mention on a draft has
  asked.
- **The supersede recheck is gone.** The old shape got one run per push, so
  a run that found a newer head could stand down and let the newer run
  post. A mention starts exactly one run; standing down would answer the
  ask with nothing. The posted review stays pinned to the inspected commit
  via `commitId`.

## Alternatives rejected

- **Drop only `synchronize`, keep `opened`/`ready_for_review`.** Kills the
  per-commit noise but reviews arrive nobody asked for, and there is no way
  to request a re-review after an update. The feedback asked for
  mention-driven.
- **Mention check as a DAG guard only.** Still one run per comment in the
  repository. On a busy repository that is the same cost problem in a
  different unit.
- **A dedicated `issue_number` or `is_pull_request` catalog field.** The
  payload offers no scalar for PR-ness; `issue.pull_request.url` as a
  proxy would encode a GitHub implementation detail into subscriptions.

## Caveats carried into the card copy

- The mention match is `contains`: case-sensitive, matches inside words. A
  short mention over-matches; the card tells the installer to pick an
  @handle-like token.
- Anyone who can comment on the repository can start a review. The
  per-event cost stays one bounded model call over a byte-capped diff.
- Two mentions racing produce two reviews. Accepted: each was an explicit
  ask, and the old delivery-id dedupe already covers webhook redelivery.
