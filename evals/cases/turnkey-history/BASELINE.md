# Turnkey history baseline

Configuration: dev-v2 015cc2a34 reviewer, `anthropic/claude-sonnet-5-5`, one pass, no verifier, no repo instructions, no team memory. The judge is the `review_match` default (`anthropic/claude-sonnet-4-5`, core profile). All calls went through the Turnkey Valet gateway. Recorded 2026-11-09.

## Score

| run | golden found (of 20) | recall | review cost | tokens |
|---|---|---|---|---|
| 1 | 9 | 45% | $2.83 | 5.7M |
| 2 | 11 | 55% | $2.62 | 4.4M |

Compare a change against the range 9 to 11, not one number. One run varies by about two golden findings. Run each configuration at least twice.

The review cost is $0.15 to $0.17 per case on average. Judge calls are extra.

## Per case

`found` is golden findings matched in run 1 / run 2.

| case | golden | found |
|---|---|---|
| tk-gitops-4798-b8eb36d | 1 | 1 / 1 |
| tk-gitops-4978-33eb18e | 1 | 1 / 1 |
| tk-gitops-4978-7a0767f | 1 | 1 / 1 |
| tk-gitops-5043-e90b6a3 | 1 | 0 / 0 |
| tk-gitops-5257-79b234a | 1 | 1 / 1 |
| tk-gitops-5406-036812b | 1 | 0 / 0 |
| tk-gitops-5406-941a53b | 2 | 1 / 1 |
| tk-mono-7774-f24338f | 1 | 0 / 1 |
| tk-mono-8057-9c1d19a | 1 | 0 / 0 |
| tk-mono-8062-4069787 | 2 | 0 / 0 |
| tk-mono-8064-15afd50 | 1 | 1 / 1 |
| tk-mono-8064-3d07b69 | 1 | 1 / 1 |
| tk-mono-8199-6176ef0 | 1 | 1 / 1 |
| tk-mono-8561-00eadfc | 1 | 0 / 0 |
| tk-mono-8662-eabc9c3 | 1 | 0 / 0 |
| tk-mono-8869-6c9afd4 | 2 | 1 / 2 |
| tk-mono-8954-27143c2 | 1 | 0 / 0 |

Missed in both runs (9): the CNPG backup path (5043), the pod-wide IAM role (5406-036812b), manual IRSA injection (5406-941a53b), the `--no-rollback` scope (8057), the zeroizing copy and the enclave debug assert (8062), the legacy-limit order (8561), the fail-open deferred close (8662), and the leaked-key policy abuse (8954).

## Relation to the hand-labeled replay

A hand-labeled replay of the same commits found 6 matches, 2 partial matches and 12 misses. The two counts differ for two reasons:

- The judge counts a finding that names the same cause as a match. The hand labels called some of those partial.
- Each run samples a new review. For example, the replay review of gitops-4798 had no findings, but both suite runs found its golden.

In the replay, Valet's suggested fix matched the human fix in 4 of the 6 full matches. No scorer reads `fix` yet.
