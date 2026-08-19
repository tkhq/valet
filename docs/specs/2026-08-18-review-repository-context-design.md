# Pull-request review: repository context — design

Date: 2026-08-18
Status: implemented
Scope: `packages/plugin-github` (the `github.pull-request-review` template, `github.read_repo_file`)

## Why

The review template reviews a diff and nothing else, and it says so in every
review it posts: *it does not open an unchanged file, so it cannot judge a
caller it never saw.* That sentence is the honest form of a real ceiling, and
the ceiling is where most missed findings live.

A worked example, from a review this template posted on a two-file frontend
change. It found the change's most serious bug — a `ResizeObserver` attached
to a fixed-size scroll viewport, which therefore never fires. It missed a
timing bug whose other half is a `requestIdleCallback` timeout in a
neighbouring component; a scroll-position regression that only shows up once
you know how the message list merges history from two sources; and every
convention the repository writes down, because the file it writes them down
in was not in the diff. Each of those needed one unchanged file. It also
reported one finding that was wrong — a missing cleanup that the diff adds
four lines below the line it anchored to — which is the same ceiling seen
from the other side: a reviewer that cannot look around a hunk cannot check
itself either.

What a human reviewer knows about a diff is mostly not in the diff.

## What changes

Two nodes between the diff and the review, and a byte budget on the action
they call.

### Choose, then fetch, then review

```
inspect → within_diff_cap → triage → read_context → review → …
```

`triage` is an `llm` node that reads the changed files and names up to six
repository paths worth opening. `read_context` is a `foreach` that reads each
one through `github.read_repo_file`. `review` gets both, and its prompt says
which is which.

The split exists because a dag/v1 `llm` node cannot call a tool — `LlmNode`
has no tool field (`workflow/src/dag/nodes.ts`). The reviewing model cannot
go and get a file mid-thought, so something has to get it first. Deciding and
fetching are therefore separate nodes, not a preference.

`triage` runs on a cheaper model than `review`. Selection is the shallow half
of the work: read the import lines, name the paths. Reviewing is the
expensive half, and running it twice over the same diff would roughly double
the run's dominant cost for a step that produces no findings. The trade is
real and it sits in one constant — a file `triage` fails to name is a file
the review cannot see, so a miss here caps the review's ceiling rather than
lowering its floor.

### The budget is one diff budget

`MAX_CONTEXT_FILES * CONTEXT_FILE_BYTES` is exactly `PATCH_BYTES`: six files
at 20,000 bytes against a 120,000-byte diff. Reading the repository at most
**doubles** a run's input, which preserves the property the whole template is
written for — a person can read the ceiling off the definition before they
install it, without running one.

The per-file cap is what makes that a ceiling instead of an estimate.
`github.read_repo_file` gains an optional `maxBytes`, because without it one
generated file — a lockfile, a bundle, a fixture — spends the whole budget
and the other five reads have nothing left to say. It truncates the bytes
before decoding, not the decoded string: the budget is written in bytes, and
one multi-byte character is up to four of them, so a "20,000-byte" read of a
file with CJK text would otherwise return well over 20,000. The result
carries `truncated` on every read, so a caller reads coverage off the result
instead of measuring a length itself.

### Reading the same repository the diff came from

`read_context` reads at `nodes.inspect.result.head.sha` — the commit the diff
was read at, and the commit `post_review` pins its comments to. A review that
quotes the diff of one commit against the repository as of another reviews a
state that never existed, and the branch tip moves on a busy pull request
while the run is still going.

### A guessed path is safe to make

`onItemError: "skip"`. Deriving a path from an import line is a guess, and
`triage` is told to make the guess rather than hold it back: a wrong one
answers 404, is recorded as one skipped item, and costs the run one read. The
same policy covers a pull request from a fork, whose head commit may not
resolve in the base repository at all — every item skips and the run reviews
the diff alone, which is what it did before this stage existed.

### The coverage block stops understating

The block that said the review never opens an unchanged file now says how
many it opened, of how many it asked for, and how many its file cap dropped.
Both new numbers come from the foreach aggregate, which the runtime measures.
The model chooses *which* files to ask for; how many came back is counted,
not claimed — the same rule that kept a model-written file list out of this
block when it was first written.

## What stays a documented limit

- **A file nobody asked for is still a file nobody read.** Six is not the
  repository. The template's card says so, and the coverage block prints the
  numbers rather than implying completeness.
- **Two model calls can now fail a run where one could.** `triage` has no
  `onError: "continue"`, and that is deliberate: `ForeachNode` has no error
  policy of its own and `policy.onUnresolvedPath: "fail"` fails a node whose
  paths do not resolve, so continuing past a failed selection reaches the
  same failed run one node later, reporting a template path instead of the
  model call that actually broke.
- **Fork pull requests may get no context at all.** Degrades to the previous
  behaviour, silently to the author and visibly in the coverage block.
- **This does not make the reviewer an agent.** It cannot follow a second
  hop: a file named by a file it fetched is not fetched. A `session` node
  over a clone would lift that, and cannot be pointed at a repository today
  (`SessionNode` is start-mode only).

## Testing

`packages/plugin-github/src/templates.test.ts` gains a `repository context`
block pinning the parts a later edit can break quietly: the budget product,
the selection cap enforced in `outputSchema` rather than in prose, the head
SHA agreeing with the one the review is posted against, `onItemError`, the
model split, the reviewer being told not to anchor a finding into a fetched
file, and the absence of any edge that routes a review around the stage.

`packages/plugin-github/src/actions/actions.test.ts` covers `maxBytes`: no
budget reads the whole file, a budget cuts and reports it, the cut is
byte-accurate against multi-byte input, and a file exactly at the budget is
not reported as truncated.

The existing suites carry the rest without changes to them:
`template-tool-contracts.test.ts` picks up `read_context_file` and checks its
params against the action's own schema and the fields the template reads
back, and `template-definitions.test.ts` already refuses a `foreach` whose
cap drops rows without saying so — which is why the coverage block reports
`truncatedCount`.
