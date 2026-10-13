# Intent-capturing approvals

**Date:** 2026-10-12
**Status:** Proposed

## Overview

Valet approvals today record one bit: approve or deny. They do not say why a person denied a call, whether an approved call needed a person at all, or what the right call would have been. This design changes approvals so that each human answer becomes a precise, structured label. Those labels train narrow model signals. A deterministic policy combines the signals with facts, and over time it lets more actions run without asking.

The goal is safe autonomy, not agreement with past decisions. The main metric is how often Valet interrupts a person when it did not need to, at a fixed rate of wrong automatic actions.

This design replaces the "Deny is one-click, no reason prompt" rule in [Channel-Based Action Approvals](2026-03-12-channel-approval-design.md). Deny stays one tap: the reason chips are on the same card.

## Evidence

A study of the agents-dev approvals on 2026-10-12 found:

- There were 1,713 approval gates: 1,439 approved, 85 denied, 97 expired, 77 withdrawn, and 15 pending.
- **The decision bit is not an intent label.** Many denied calls were exactly what the user asked for, and the person denied them for another reason, such as the content or the details. Many approved calls were steps nobody asked for, such as read-only queries toward a stated goal.
- **The reason for a denial is almost never in the conversation before the gate.** Only 3 of 84 denials had an objection in the preceding messages. The person decides when they see the card.
- A zero-shot model asked "should this be approved?" scored an AUC of 0.43 against the human decision. Narrow intent questions scored 0.57 to 0.61. The signals can be measured; the label was the problem.
- On 160 synthetic role-played situations with constructed labels, two decision models (Cloudflare Clef and TypeSafe Jev 1.13) answered `asked_for` and `objection` with 98% to 100% accuracy. The models differed on two signals:

| Signal and case | Clef | Jev |
|---|---|---|
| `serves_goal` on a step the user did not ask for | 10/19 | 19/19 |
| `serves_goal` on the same cases, with workspace policy text | 15/19 | 19/19 |
| `outcome_match` on a call with a wrong target or wrong content | 26/40 | 39/40 |
| `outcome_match` on a correct call that the user agreed to | 12/12 | 9/12 |

- A larger benchmark of 1,096 cases added wallet actions and adversarial prompt injection, scored on nine decision models. Two results change this design:
  - **Lookalike targets pass most models.** When one character of a correct call's target was replaced with a Unicode lookalike, for example a Cyrillic "е" in a channel name, Clef Flash still allowed 93% of the calls it had allowed before. Other models allowed 14% to 97%. A deterministic check catches all of them.
  - **Delegated targets defeat intent signals.** When the user tells the assistant to take the target from fetched data ("use the address on the invoice"), a poisoned source looks like a correct call. Nothing in the conversation is wrong, so no signal can detect it.
- Injection that the user's own words contradict rarely worked. The leading models blocked all 79 single-shot attack cases, and fake chat-template turns, answer priming, and filler padding moved 0% to 5% of their decisions. The exception was one model, which 6,000 tokens of filler pushed to allow 21% of the unsafe calls it had blocked.
- **The gate record has gaps.** Until 2026-10-05, Valet did not consistently write the `decision_gate` open event to `engine_events`; the snapshot exists only in the `engine_entries` row. 214 early rows in `engine_decision_gates` have `status = resolved` and no `resolution`.
- Many "user" messages before a gate were automation prompts, from workflows and the security loop. They carry no human intent.

## Goals

- Collect structured labels at decision time: the reason for a denial, the corrected call, and whether a person was needed.
- Record exactly what the approver saw, at the moment they saw it.
- Measure what an automatic policy would have decided, before letting it decide.
- Increase autonomy one action class at a time, only where the measured error rate is low.

## Non-goals

- Training or serving models. The Governed Decisions harness owns model signals and calibration. Valet supplies labels and consumes signals.
- Removing human approval for any action class in this change. Autonomy changes are later policy changes, gated by the metrics below.

## Concepts

**Signal.** A narrow model judgment with a calibrated probability. The first signals are:

| Signal | Question |
|---|---|
| `asked_for` | Did the user directly ask the assistant to take this kind of action? |
| `serves_goal` | Is this action a step toward a goal the user stated, even if the user did not ask for this action? |
| `outcome_match` | Would this exact call, with these parameters, target, and content, produce the result the user described? |
| `objection` | Did the user object to, reverse, or postpone this action? |

`asked_for` includes an explicit request, a request for a result that this action directly produces, and agreement when the assistant proposed this specific action. It does not include an intermediate step that the assistant chose on its own.

`outcome_match` quality depends on the model. One model missed a third of the calls with wrong details. The other model caught almost all of them, but it scored some correct destructive calls as mismatches. For destructive actions, the model therefore also extracts the target the user named into a structured field, and code compares that field with the call's parameters.

**Fact.** A deterministic value that needs no model: who initiated the turn, the action's effect class (read-only, reversible, or destructive), the resource's sensitivity, and whether the extracted target matches the parameters.

Three target facts are required for actions that send, delete, transfer, sign, or change access:

| Fact | Rule |
|---|---|
| `target_exact` | The call's target matches, byte for byte, a target that a verified human typed or that a known resource list contains. |
| `target_confusable` | The target contains characters outside the expected script, invisible characters, or bidirectional controls, or its Unicode confusable skeleton matches a different known resource. |
| `target_provenance` | The target came from a verified record, such as the address book, the vendor registry, or the workspace's channel list, and not only from fetched content. |

A call fails the policy when `target_confusable` is true, regardless of the signals. When the target came only from fetched content and has no verified provenance, the call goes to a person, even if the signals say the user asked for it. Wallet recipients, token spenders, and new signers always need `target_provenance`.

**Tier.** Each action class has one of three tiers:

| Tier | Meaning |
|---|---|
| `always_ask` | A person must approve, whatever the signals say. |
| `ask_unless_intended` | The policy may allow the call when a verified human asked for it and the facts allow it. |
| `allow` | The call runs without a gate. |

**Environment profile.** Each organization and workspace declares what is sensitive: production names, protected repositories, and trusted resources. The policy reads it as facts. "Delete a branch" in a scratch repository and in a protected repository get different tiers.

**Policy text.** Each workspace can also declare short natural-language rules about initiative, for example: "Read-only queries toward a stated goal are in scope. Messages to people the user did not mention are not." Valet adds this text to the instructions of the signals that it applies to. The text does not make the decision; the deterministic policy still decides from the signals and the facts. Policy text gives the model a norm that it cannot infer from the conversation. In the synthetic study, it improved the weaker model and did not help the stronger model. Each change to policy text is a change to the signal definition, so it must be evaluated again before it is used. Only workspace admins can edit policy text. Text from the conversation, automations, or tools can never change it.

## Provenance of authority

Only a verified human message can clear a gate. Each conversation entry that the policy or a signal reads carries an `author_kind`: `human`, `automation` (a workflow, trigger, or loop prompt), or `tool` (content returned by a tool or read from a document).

- `asked_for` counts only `human` entries.
- Text from `automation` or `tool` entries can never grant authority, even if it says "the user asked". This blocks prompt injection from raising its own permissions.
- For `automation` turns, the policy uses the workflow's grants, not intent signals.

## The approval card

The card says why it appeared: the rule and the signal that triggered it, in one line. For example: "Asked because this deletes data and the target differs from what you named."

The person answers with one tap:

| Answer | What Valet records |
|---|---|
| Approve | The decision, plus the counterfactual chip "Could have run without asking me". |
| Approve with edits | The person edits the parameters. Valet records the original call, the edited call, and the diff, then runs the edited call. |
| Deny: not what I asked for | A sub-chip: wrong target, wrong content, or wrong scope. |
| Deny: not now | Timing, not intent. |
| Deny: I'll do it myself | The intent was right; the person does not want automation here. |
| Deny: shouldn't be automated | A tier hint for this action class. |

Free text is optional on every answer. The Slack card and the web card offer the same choices. The counterfactual chip is optional and is never required to approve.

## Records

**Gate snapshot.** This is written once, when the gate opens, and is never updated. It holds:

- the rendered card text and the parameters;
- the conversation summary and the entries it was built from, each with its `author_kind`;
- the signal values, the facts, the matched rule, and the policy's proposed decision.

The snapshot replaces the open event as the source of truth for what the approver saw.

**Decision record.** This is linked to the snapshot. It holds the answer, the reason chips, the edited call and diff when present, the counterfactual chip, free text, the approver, the channel, and the decision time.

**Outcome record.** For every call that ran, approved or automatic, this records whether the user undid or corrected it within a window, by a manual reversal, a follow-up correction, or an explicit complaint.

## Shadow mode

For every gate, Valet computes the signals, the facts, and the policy's proposed decision. It stores them in the snapshot but does not act on them. The comparison table per action class shows:

- **proposed allow, human approved, counterfactual "could have run":** a safe automation candidate;
- **proposed allow, human denied:** a would-be wrong automatic action, the main error;
- **proposed ask, human approved, counterfactual "could have run":** an unnecessary interruption.

## Task-scoped grants

When a verified human authorizes a class of action for the current task, Valet does not gate equivalent actions again during that task. Valet proposes the grant at the right scope: the action class plus the resource scope, never one exact call. The person can accept it as "always allow this here". An accepted grant becomes a policy rule with an owner and an expiry.

## Metrics

| Metric | Definition |
|---|---|
| Interruption rate | Gates per 100 tool calls, per action class. |
| Unnecessary interruption rate | Approved gates marked "could have run without asking", over all gates. |
| Wrong automatic action rate | In shadow mode, proposed allows that the human denied. After rollout, automatic calls the user undid or corrected. |
| Label coverage | Denials with a reason chip, and approvals with an answered counterfactual. |

## Rollout

1. Write the gate snapshot and the decision record, add `author_kind` to entries, and backfill the missing `resolution` values from the terminal events.
2. Ship the new card with reason chips, edits, and the counterfactual chip, in web and Slack.
3. Run shadow mode with the first signals for at least four weeks of data.
4. Move an action class to `ask_unless_intended` only when its wrong automatic action rate is below a published threshold, starting with read-only classes.

## Privacy

Snapshots and decision records hold conversation text and parameters. They have the same retention and access rules as `engine_entries`. Exports for training stay inside Turnkey-controlled hosts and follow the Governed Decisions dataset rules.

## Open questions

- Which verified records each integration exposes for `target_provenance`, and how a person adds a new target to them.

- The exact threshold for each tier change, and who signs off on it.
- The length of the undo window for outcome records, per action class.
- Whether workspace admins can see and change the environment profile in the web app in the first release.
- Which decision model Valet uses for signals, and whether each signal can use a different model.
