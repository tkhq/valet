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
  A nested convention file applies when the PR touches any path under its
  directory: an added, changed or deleted file, or either side of a rename.
  Domain note paths match the same set of paths.
  Domain notes become rules only from read-only synced memory under
  `lib/code-review/notes/` (a source repo's `.valet/memory/code-review/notes/`),
  which agents cannot write. The same directory in a team's or org's memory
  (`team:{id}/lib/...`, `org:{id}/lib/...`) also holds rules. A `lib/`
  directory deeper in the tree is writable, so its notes are background.
  The pack presents these as rules the team enforces. Other matching memory
  notes and principles are labeled background, not rules. The plugin ships
  no organization's rules.
- **Every rule note is checked.** The plugin lists every note in the rule
  directory through the read-only memory port's `list`, which uses the same
  org scope as `search` and `read`. It reads at most 100 notes and matches
  each one by its own paths, terms and title pattern. A rule note with no
  paths, terms or title pattern applies to every change, like a root
  convention file. A keyword search finds only background notes, so a
  search that returns other notes first cannot hide a rule. One drop-log
  line counts the rule notes that do not match.
- **The team sees which rules applied.** The summary review lists the
  memory path of each rule note the reviewer was given, and the review round
  records them (`rules`). The Code review page shows the count per round.
- **Matched rules fill the pack first.** Matched rule notes take budget
  before conventions and code sections, with no section share. The pack cuts
  a matched rule only when the rules alone pass the budget, and it logs the
  cut.
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
- **Failures are visible.** A failed memory list, search or read, or a failed
  merge-base read, appears in the pack's drop log or in the "not built"
  notice. It never reads as "nothing found".
- **Selection is not trust.** Changed paths, the PR title and added lines
  choose which trusted notes and playbooks go into the pack. They never supply
  rule text.

## Focused reviewer passes

A repository's review rule can add focused reviewer children with the
`focuses` setting. Each entry starts one more reviewer child beside the general
one, with one extra section in its role prompt that limits it to one defect
class:

- `failure`: error, cleanup and timeout paths, state transitions, and what an
  attacker can do with one leaked credential.
- `concurrency`: races, async misuse, and performance waste.
- `tests`: tests that cannot fail, broken contracts with callers, and text the
  change made false.

The general child starts first. Its findings come first when the handler merges
by location, and its summary is the review's summary. A focused finding within
three lines of an earlier finding on the same file is a repeat and is dropped.
Focused findings rated below `focusMinConfidence` (default 0.7) are dropped
before the merge, so a low-confidence repeat cannot hide a confident finding.
The eval pipeline keeps them in its draft, but a dropped finding never makes an
accepted one a repeat.

Each focused child adds about one review's cost. The default is no focused
children. A focused child that cannot start, for example at the per-session
child cap, is logged and skipped, so the review still posts.

On 2026-11-10 the eval measured all three focuses with the 0.7 threshold. The
private history suite caught 11 of 20 human-raised issues, against 8 in two
baseline runs. Martian F1 fell from 53.5 to 48.7. Turn focuses on per
repository, and measure them in shadow mode first.

## Learning from review feedback

When a reviewed pull request closes (`github.pull_request.closed`), the handler
learns from what people did with the review. The `learn` setting turns this on
and is on by default. A shadow line does not learn. A line made before
2026-11-13 lists only the review events, so add `github.pull_request.closed`
to its event keys to turn learning on.

1. The handler reads the feedback from people with push access (write,
   maintain or admin role). Anyone can comment on a public repository, so the
   handler ignores everyone else. A finding counts when such a person replied
   to it, reacted with a thumbs-up or thumbs-down, or resolved its thread with
   no fix. A comment of theirs that starts a thread counts as a miss, with
   whether a later commit changed its lines.
2. With no such feedback, the pass ends without a model call.
3. A `pr-learner` child reads the feedback, the existing lessons for the
   repository, the learned principles, and the titles of the other
   principles. It answers with at most five lessons, each a `create` or an
   `update`, with a kind: `check` (flag this) or `skip` (do not flag this).
4. The plugin writes each lesson to the line owner's memory through the
   plugin memory port:
   - A repository lesson goes to
     `code-review/learned/<owner>/<repo>/<slug>.md`. Memory keeps no
     frontmatter from a plugin write, so `Kind:`, `Paths:`, `Terms:` and
     `Evidence:` are lines in the body.
   - A general lesson goes to `principles/review-<slug>.md`. It is a real
     principle: every agent of the owner lists it at its next wake.
   - An update may replace only an existing learned note of the repository or
     a learned principle. A person's own notes and principles are never
     overwritten.
5. The plugin thread gets a note that lists what was written or skipped. The
   pointers record `learnedHead`, so a retry or a second close does not learn
   twice.

At review time, the context pack lists the repository's learned lessons,
matches them by paths and terms like rule notes, and puts them in their own
section after the team rules: "Learned from past reviews". A lesson with no
paths or terms applies to every change in the repository. A lesson with
`Status: retired` is skipped. The pack tells the reviewer that a repository
rule wins over a learned lesson. A learned principle
(`principles/review-*.md`) loads in the same section with its full text, as
a lesson for every change in every repository. The owner's other principles
are listed by title. Keyword search skips learned files, so a lesson does not
appear twice. A person edits or
deletes a lesson in Memory like any other file.

## Verifier

Every review rechecks each open finding on a file the new commits changed.
A recheck that refutes the claim resolves the finding as fixed or withdrawn.
With `verify` on, each new finding also gets a check before it posts. The
verifier is a fact-checker. It answers one question: is the claim true at the
PR head? It does not judge severity, style, or whether the finding is worth
posting. Other review tools found that a model that rates the worth of its
own findings does little better than chance. That judgment belongs to the
team, through review feedback.

- **Same inputs as the reviewer.** The verifier prompt carries the PR title,
  the PR description, the whole PR diff with the claim's file first (60,000
  characters), the line's instructions, and the context pack's conventions,
  domain notes and learned lessons. It reads code at the PR head with read-only tools.
- **Three verdicts.** `confirmed` names the trigger and wrong result, or
  quotes a false statement and the code it contradicts. `refuted` needs one
  reason: `not_found`, `guarded` or `misread` (both cite code as path:line),
  or `pre_existing`. `unverifiable` says what the repository does not show.
  A small or intended-looking problem that is true is confirmed.
- **The handler checks the verifier.** A confirmation whose quoted code is
  not in the file is unverifiable. A `pre_existing` refutation of a line
  the PR adds or deletes breaks the scope rule. With a quoted line and a trigger it
  counts as confirmed, else as unverifiable. A refutation of a claim that
  cites a rule file must cite the same file.
- **Verdicts set where a finding goes.** Confirmed findings, and findings
  with no verdict, post inline. Refuted findings are dropped. Unverifiable
  findings post inline at high or critical severity. Below that, the summary
  lists them under "Findings the verifier could not confirm", with no inline
  comment. The pointer keeps `unconfirmed`, so later reviews keep them there.
- **The verifier must try to refute before it confirms.** It looks for
  formatter and CI config, module versions and release rules, library
  behavior, and whether the trigger is reachable, and records the search. A
  confirmation with no refutation attempt is unverifiable.

On 2026-11-13 a replay scored the verifier against 57 live findings with
human labels, with three single runs of each prompt:

| | Previous verifier | Without the refutation step | With it |
|---|---|---|---|
| Real low findings kept (of 11) | 7 | 11, 11, 11 | 10, 11, 11 |
| Real medium or higher kept (of 11) | 8 | 10, 11, 11 | 9, 11, 10 |
| Wrong low findings off inline (of 6) | 4 | 1, 4, 2 | 3, 3, 4 |

Identical runs disagree on 10 of the 57 findings. A majority vote of three
runs scored the same as the middle single run, at three times the cost, so
the verifier runs once. Repeated runs of one model share its errors, so a
vote cannot remove a wrong verdict that every run reaches. On the real
findings, the verifier refutes fewer claims than the previous one did (0 to
3 per run, against 7). That matters because rechecks run on every line, and
a refuted recheck withdraws a finding. The two wrong low findings that every
run confirms depend on team conventions: a formatter hook, and the release
rules of v0 modules. Learned review lessons cover those better than a
second model can. The bar is 5 of 6, so keep `verify` off on live lines.

## Measuring reviews

Hand labels do not scale, and a replay of 57 findings cannot separate a
small change from noise. The eval package's `review-outcomes` command
measures every live review without labels. For each review comment on a
merged pull request, it checks whether the author changed the flagged lines
before the merge. The address rate is the share of comments the author
acted on. Other review tools use the same signal: the share of flagged
problems that the author resolves before merge.

A changed line does not prove the comment right, and an ignored comment can
be correct. Use the address rate to compare reviewer versions, verifier
settings and other reviewers on the same repositories and dates. Each row
also carries the PR and the comment's commit, so it can become a replay
case. Address-rate rows start to cover a reviewer version only after its
pull requests merge.
