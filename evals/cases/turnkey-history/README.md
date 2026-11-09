# Turnkey history suite

Merged tkhq/mono and tkhq/gitops pull requests where a human reviewer found a real defect or risk, proposed a fix, and the author changed the code. Each case runs the PR review reviewer at the commit the human reviewed, against its merge-base, and scores the review against the human findings with `review_match`.

There is one case per reviewed commit: 17 cases from 14 PRs, with 20 golden comments.

## What the case files hold

- The remote, the base and head commits, the PR number and title.
- Golden comments that paraphrase the human threads, with a Martian category and a severity.
- `fix`: the fix the reviewer proposed or the change that merged. `review_match` does not score it yet. It is there for a fix-match scorer.
- Header comments link the review threads and the fix compare view.

The files hold no code and no PR descriptions. `private: true` makes the runner check read access to the remote first. Without access, the case SKIPs. `number` makes the runner read the description from GitHub with `gh` at run time.

## Run

```bash
VALET_LLM_GATEWAY_URL=https://valet.dev.agents.turnkey.engineering \
VALET_API_KEY_FILE=~/.valet/post-deploy.key \
pnpm --silent --filter @valet/eval start --cases evals/cases/turnkey-history \
  --model anthropic/claude-sonnet-5-5 --concurrency 4
```

- The first run clones tkhq/mono and tkhq/gitops as blobless bare repos into `VALET_EVAL_REPO_CACHE`.
- The reviewer's `bash` runs on the local machine. Run the suite only where Turnkey code may be read.
- Three diffs are longer than the reviewer's 150,000-character diff budget and are cut: tk-mono-8064 (both commits) and tk-mono-8199 and tk-mono-8561.

## Reading the score

Use recall. Precision is not meaningful here: the golden comments list only the selected human findings, so a real finding that no human raised counts as unmatched.

## Baseline

Shipped configuration (dev-v2, `anthropic/claude-sonnet-5-5`, one pass, no verifier, no repo instructions or team memory), recorded on 2026-11-09. See `BASELINE.md`.

How cases were chosen:

- Human threads from the last ~1,000 merged PRs per repo, ranked by defect terms and by threads the code later changed under.
- Threads that relay a bot's output and style-only threads are excluded.
- A thread whose file did not change before merge is excluded.
