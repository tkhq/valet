# Dependency review

The dependency review checks the packages a pull request adds or upgrades. It
is the `review-dependencies` handler of the `pr-review` plugin, next to
`review-pull-request`. It is not a stage of the general review: an org turns
it on with its own subscription line, and it keeps its own state, summary
review and findings.

## Turn it on

Create a line with target `{ kind: "plugin", plugin: "pr-review", handler:
"review-dependencies" }`, the push events and a `repo` filter:

```json
{
  "name": "Dependency review: acme/site",
  "eventKeys": [
    "github.pull_request.opened",
    "github.pull_request.synchronize",
    "github.pull_request.reopened",
    "github.pull_request.ready_for_review"
  ],
  "filters": [{ "op": "eq", "field": "repo", "value": "acme/site" }],
  "target": { "kind": "plugin", "plugin": "pr-review", "handler": "review-dependencies", "config": {} }
}
```

Send it as `POST /api/event-subscriptions`. It does not collide with the
repository's code review line: two plugin lines aimed at different handlers
are fan-out, as two lines aimed at different workflows are
(`packages/api/src/events/collisions.ts`). The Code review page lists only
`review-pull-request` lines. A dependency line does not show there.

Settings (`target.config`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `minSeverity` | `low` | Post only findings at this severity or above. |
| `reachability` | `true` | Ask a child whether the code reaches each new advisory. |
| `model` | `anthropic/claude-sonnet-5-5` | provider/model for the reachability child. |
| `newPackageDays` | `30` | Flag an added package first published fewer days ago. 0 turns it off. |
| `ignore` | `[]` | Package names or advisory ids (GHSA-, CVE-, GO-) to skip. |
| `excludePaths` | `[]` | Globs of dependency files not to check. |
| `reviewDrafts` | `false` | Check draft pull requests on every push too. |

## Files it reads

| Ecosystem (OSV name) | Manifests | Lockfiles |
| --- | --- | --- |
| npm | `package.json` | `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` (v5 to v9), `yarn.lock` (classic and Berry) |
| Go | | `go.mod`, `go.sum` |
| crates.io | `Cargo.toml` | `Cargo.lock` |
| PyPI | `pyproject.toml`, `requirements*.txt` | `uv.lock`, `poetry.lock` |

The parsers read text only. They never run a package manager, so a pull
request cannot run code through them.

## Steps on each push

1. Read the pull request and its file list. If no dependency file changed,
   and no earlier finding is open, stop. This costs two GitHub reads and
   posts nothing.
2. Read each changed dependency file at the merge base and at the head. Group
   the files by directory and ecosystem. In each group, the lockfile gives the
   versions. `go.mod` beats `go.sum`. A manifest changed without its lockfile
   gives the lower bound of each range, and the finding says so. A changed
   manifest, or the unchanged manifest next to a changed `yarn.lock`,
   `Cargo.lock`, `uv.lock` or `poetry.lock`, marks direct dependencies. npm
   and pnpm lockfiles and `go.mod` mark them on their own.
3. List each package as added, upgraded, downgraded or removed. A package
   with a new version in a lockfile, but not in a manifest, is transitive. If
   no package changed (a script edit), stop and post nothing.
4. Look up every new version in OSV in one batch query
   (`api.osv.dev/v1/querybatch`), then read each advisory record. Aliases (a
   GHSA and a GO- id for one flaw) count once. If OSV fails, the delivery
   fails and the host retries it. Advisories are the main check, so a review
   must not post as if it checked nothing.
5. Read registry facts for at most 60 package versions, direct dependencies
   first. A failed read gives no facts for that package.
6. Make findings (below), each with a stable key
   `<ecosystem>:<name>@<version>:<kind>[:<advisory id>]`.
7. Ask one reachability child about each new advisory, and about the open
   ones when the push changed code (below).
8. Post or edit the summary, and post new inline comments.

## Findings

| Kind | When | Severity |
| --- | --- | --- |
| `advisory` | OSV lists an advisory for the new version. | GitHub's label (`MODERATE` is medium), else the CVSS score, else medium. One level lower when the code does not reach it. |
| `typosquat` | An added name is one edit (insert, delete, change or swap) from a popular package, or differs only in separators or case. Names shorter than 5 letters are not compared by edits. PyPI names are compared after PEP 503 normalization. | high for separators, medium for an edit |
| `new-package` | An added package was first published fewer than `newPackageDays` days ago. | medium |
| `install-script` | An added npm package runs `preinstall`, `install` or `postinstall`, or an upgrade adds one. | medium direct, low transitive |
| `maintainer` | An npm upgrade adds a maintainer, or a new account publishes the version (npm, crates.io). | medium for a new maintainer, low for a new publisher |
| `license` | An upgrade changes the license, or an added direct dependency has a strong copyleft license (AGPL, GPL, SSPL, BUSL). An SPDX `OR` counts its most permissive choice. | high to strong copyleft, else medium |

A removed package gets no finding. One package in two directories gives one
finding with both locations.

Registry facts by ecosystem:

- npm: the version document (license, install scripts, maintainers,
  publisher). For an added package, the package document too (creation date).
  A package document larger than 4 MB is not read: that package is not new.
- crates.io: the crate document (creation date, each version's license and publisher).
- PyPI: the version document (license, upload date). For an added package,
  the project document (first upload).
- Go: the module proxy, for an added module only (version date, first version).

## Reachability

The only model step. One child per push, role `pr-dependency-reachability`,
judges at most 15 new advisories. It runs in a sandbox checkout at the head
with read-only git access. Its prompt lists each advisory with a ref (`a1`),
the package, the version, the affected functions when OSV lists them (Go
advisories do), and the advisory text inside `<advisory-text>`. It answers
`yes`, `no` or `unknown` per ref, with path:line evidence.

- `yes`: the finding keeps its severity and shows the evidence.
- `no`: the finding drops one severity level and says why.
- `unknown`, or no answer: the finding keeps its severity.

No child starts when `reachability` is off, when no advisory is new, or when
the pull request comes from a fork whose author has no write access. The
summary says why reachability was not checked. A child that fails or cannot
start loses the reachability note only, never the advisories. The pointer
keeps the verdict. A later push that changes code outside the dependency
files (or a force-push) judges the open advisories again in the same child: a
new call can reach an advisory, and a removed call can stop reaching it. When
a verdict changes, the handler rewrites the finding's comment and severity. A
push that changes only dependency files judges only the new advisories.

## What it posts

One summary review per pull request, edited in place. It starts with
`<!-- valet-dependency-review:summary <head> -->` and has:

- the counts of added, upgraded, downgraded and removed packages, and how many are transitive;
- open findings by severity, and findings resolved on later pushes;
- the text of findings with no inline comment ("outside the diff");
- why reachability was not checked, when it was not;
- a table of the first 100 changed packages.

It has no merge confidence. That score belongs to the general review.

Each new finding gets an inline comment on the line that adds the package:
the manifest line first, else the lockfile line. GitHub only takes comments
on lines in the diff. A finding with no such line is listed in the summary
with its text. GitHub does not render a patch for a large lockfile, so its
findings often go to the summary. A 422 from GitHub moves all inline
findings of that push to the summary. Each block has the marker
`<!-- valet-dependency-review:finding d<n> <severity> <kind> -->`.

The markers differ from the general review's (`valet-pr-review:`), so neither
handler reads the other's comments. Finding ids are `d<n>`, not `f<n>`.

## State and later pushes

The store collection is `dependency-pulls`, keyed `owner/repo#number`. It
holds the summary review id, the last checked head, the next id and one
pointer per finding: id, key, kind, severity, title, anchor, comment id,
status and the reachability verdict. The general review's `pulls`
collection, records and learning pass do not see it.

On a later push the handler works out all findings again and compares keys:

- An open key that is still present stays open. Nothing is posted again.
- An open key that is gone is resolved: its comment becomes "Resolved in
  `<sha>`", and its thread is resolved.
- A new key, or one resolved earlier that comes back, is posted.
- A finding whose comment a person deleted, or whose thread a person
  resolved, is dismissed and never posted again.

New findings are saved before old comments are edited, so a retry after a
failed edit does not post them twice. The last checked head is saved last.

## Limits

- 3000 package changes per pull request, 60 advisory record reads, 60
  registry reads and 15 reachability verdicts per push. The summary says when
  a limit cut the check.
- A yarn or Cargo workspace member's own manifest does not mark direct
  dependencies of a root lockfile.
- The API server needs outbound HTTPS to `api.osv.dev`, `registry.npmjs.org`,
  `crates.io`, `pypi.org` and `proxy.golang.org`.

## Out of scope

- A watcher for new advisories against code already on the default branch.
  The GitHub event catalog has no Dependabot or advisory events, so it needs
  a schedule. It is a follow-up.
- Requests by mention (`@<app> review`) and the closed-pull-request learning pass.
