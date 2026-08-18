# Assign reviewers: event-driven design

`github.assign-reviewers` picks reviewers for a pull request from CODEOWNERS and
a roster, the way `docs/specs/` has no prior entry for because the workflow
shipped as a manually-triggered template (#313). This spec covers the
overhaul that removes the manual trigger, restores the Slack notifications the
original request asked for, and adds the one bonus feature that turned out to
be buildable: swapping out a reviewer who declines.

## Why

The template requires typing a repository and a pull request number into a
run form. Every pull request that wants a reviewer needs a person to notice
it, open the workflow, and start it by hand — which is the opposite of what
"assign reviewers" should mean. It also never sends the Slack messages the
original request asked for, because Slack was marked not-ready in the
template gallery at the time it shipped. Slack readiness has since landed
(`dev-v2` identity-linking, PR #321), so that gap can close.

## What changes

### Trigger

The trigger node drops `repositoryOwner`, `repositoryName`, `pullNumber`, and
`excludeHandles` from `dataSchema`. It keeps one hidden `payload` field, the
same shape `github.pull-request-review` already uses — the webhook body an
event trigger maps in, that nobody types. `policy.onUnresolvedPath: "fail"`
stays, so a template mistake fails the node it is in rather than rendering a
message built from empty strings.

CODEOWNERS and roster *location* (path, owning repository) stay as ordinary
`dataSchema` fields, set once at install — they are deployment config, not
per-event data, the same split `unclaimed-pull-request-routing` already
makes for its routing file.

Installing the template arms its own subscriptions. `WorkflowTemplate.events`
declares them and `installWorkflowTemplate` writes them in the same
transaction as the definition, the way `schedule` has always armed a cron —
before this, an event template installed inert, which reads as a broken
workflow rather than an unfinished setup.

Two subscriptions, not one: `github.pull_request.opened` plus
`.ready_for_review` for the assignment, and `github.issue_comment.created`
for the decline swap. Separate, so the comment watcher can be disabled on its
own. Both filter on `repo`, whose value comes from a `repository` field the
installer fills in (`filters[].fromInput`) — the template knows it needs the
filter, and only the installer knows the repository. Without that filter the
subscription matches every repository the webhook reaches.

The comment subscription cannot be narrowed further. GitHub fires
`issue_comment` for issues as well as pull requests, and the catalog declares
no filter that separates them, so every comment in the repository starts a
run. The run decides: a comment on an issue reaches a `stop` with outcome
`success` and does nothing. Deliberately not a failure — a failed run per
issue comment fills the run list with red that names no fixable problem. A
run that carried no recognizable event at all is still a failure, and still
names the keys to subscribe to.

An event template's inputs are resolved at install for the reason a
scheduled template's are: the dispatcher builds `trigger.data` from the
webhook body and merges no `dataSchema` defaults, so a required value
missing at install is missing forever.

### The roster is optional

CODEOWNERS is required; the roster is not. A repository with no roster
still gets reviewers — `shortlist` falls back to the CODEOWNERS tokens
themselves. Only a plain `@handle` survives that fallback: a `@org/team`
token names a group nothing here can resolve into people, and the
assignees field takes users only, so a team token is reported in
`rosterProblems` rather than written into an assignment GitHub would
silently drop. A roster is what buys team membership, PTO checking,
working hours and Slack ids.

This is why `assignReviewers` carries no `policy.onUnresolvedPath: "fail"`
while `pullRequestReview` does. `read_repo_file` answers a 404 with
`success: false`, so a missing roster FAILS its node, and an `llm` prompt
is an enforceable surface — under the policy, `shortlist` would fail
before running rather than read an empty roster. Making the roster
optional under the policy meant a second shortlist node behind a gate,
and therefore duplicating every node downstream of it, because a second
shortlist has a second id and nothing downstream could read both.

What the policy protected against is now covered by the branch gates: a
run carrying no recognizable event reaches `unrecognized_trigger` before
any node reads the payload. Unresolved paths are still reported either
way — the interpreter runs its template audit regardless, and the policy
only decides whether a finding also fails the node.

### Two branches, one definition

The engine audits every node's templates against the run's actual trigger
data before the node runs, and under `onUnresolvedPath: "fail"` a template
that reads a path neither side of a fallback expression can supply fails the
node — even when the *other* side of the fallback would have resolved. A
`pull_request` webhook payload and an `issue_comment` webhook payload share no
path, so no node downstream of the trigger can serve both without either a
fallback template (unsafe, per the audit rule above) or a shared sub-workflow
call (unavailable — `WorkflowCallNode.workflowId` names an already-installed
workflow belonging to the same owner; a template's `definition` cannot
install a second workflow alongside itself). The definition therefore branches
early into two independent node chains that happen to share the same
CODEOWNERS-matching and calendar-checking shape.

**Branch A — fresh assignment.** Gate: `trigger.data.payload.pull_request`
exists and `trigger.data.payload.action` is `opened` or `ready_for_review`.
Reads owner/repo/pull number from `trigger.data.payload.repository.*` /
`trigger.data.payload.pull_request.number`. The rest is today's shape: read
CODEOWNERS and the roster, read the pull request, shortlist candidates,
check calendars, select, write `assignees`, read it back, report.

**Branch B — decline swap.** Gate: `trigger.data.payload.comment` and
`trigger.data.payload.issue.pull_request` both exist (the second is how a
GitHub `issue_comment` payload says the issue is a pull request), the
commenter is not a bot, and — after a fresh `inspect_pull_request` read —
the commenter is a *current assignee* of an open, non-draft pull request.
That gate is nearly free (no model call) and rejects the overwhelming
majority of ordinary comments before anything else runs. What passes it goes
to a small classifier (`claude-haiku-4-5`, the comment body only) that
answers whether the comment is a decline. A `false` stops the run,
successfully, with nothing written. A `true` proceeds: exclude the
commenter, read CODEOWNERS and the roster (fresh copies, own node ids),
compute which required owners the *other* current assignees still cover,
and select replacements only for the owners that lost coverage. The write
replaces the assignee list with (remaining valid assignees) + (new picks) —
`update_pull_request` has no "add one assignee" call. Verify and confirm
follow the same shape as branch A.

A reply the workflow itself might later post on the pull request (naming the
swap) is exactly the kind of comment that would re-enter branch B on its own
webhook. The classifier reading it and answering `false` is the loop guard —
cheaper than a bot-login check, and correct even if the reply is posted by a
GitHub App whose login the classifier has never seen.

Known gap, stated rather than hidden: a person who declines twice for two
different owners on the same pull request is handled by two independent
comment events, each excluding only its own commenter — nothing here
remembers who declined an earlier round beyond what the pull request's own
assignee list already shows.

### Slack

The roster's `slack_user_id` column is read for the first time. Two uses,
both through `slack.dm_user` (no identity-link needed — the roster supplies
the id directly):

- Every landed assignee — read back from `nodes.confirm.result.output.landed`,
  so nobody GitHub silently dropped gets a message claiming they were
  assigned — gets a DM naming the pull request and why they were picked.
- The pull request author, when their `github_handle` has a roster row with a
  `slack_user_id`, gets a DM with the outcome: who was assigned, or why
  nobody was. This is the closest event-driven analog to "message the
  requester" now that no person starts the run — the author is the one who
  asked for review by opening the pull request. An author absent from the
  roster gets nothing extra; the orchestrator report (unchanged) is still
  the durable record either way.

A `foreach` body cannot skip an item conditionally — no `if` node is in its
allowed body union. Both DM loops reuse the pattern `nodes.shortlist` already
established for `withCalendar`: the LLM step that produces the recipient list
filters to entries that actually carry a `slackUserId`, so the loop itself
never has to ask.

`SERVICES_NOT_READY` in `packages/api/src/workflows/templates.ts` drops
`"slack"`. It has hidden every Slack-using template from the gallery,
including this one before this change and the daily triage digest already
shipped — Slack readiness landed on `dev-v2` (identity-linking, PR #321)
after that flag was set, and nothing since has turned it back off.

### What stays a documented limit

Everything the original template's caveats already said "this platform
cannot do" still holds: no action reads GitHub team membership, so the
roster is still the only source of group membership; nothing reports a
timezone, so the roster still carries it; there is still no signal for who
last worked on the changed code beyond the roster's `areas` column. The
coverage gate in front of the write is unchanged. `MAX_ASSIGNEES`,
`MAX_CANDIDATES`, `CHANGED_PATHS_LIMIT`, `TIME_OFF_WINDOW_DAYS` are unchanged.

## Testing

`packages/plugin-github/src/templates.test.ts` gets new coverage for: the
event-only trigger (hand-started run stops with the corrective message),
branch selection on both webhook shapes, the decline gate (non-assignee
comment, bot comment, decline classified false, decline classified true),
the coverage-preserving reselection, and the Slack DM pre-filter pattern.
`packages/api/src/workflows/template-catalog.test.ts`,
`template-definitions.test.ts`, and `templates.test.ts` get updated for the
new `dataSchema` shape and the `SERVICES_NOT_READY` removal (which also
changes the daily-triage-digest template's visibility — expected, not a
regression).
