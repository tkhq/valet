# Workflow structured output

Date: 2026-10-05
Status: implemented

## Contract

A `session` or `orchestrator` node with `outputSchema` sends that schema in its
initial prompt. The final response must contain JSON that matches the schema.
Nodes without `outputSchema` keep their existing prompt.

The engine parses the response and validates it without inventing missing values.
A failed submission fails its node, even if it contains schema-valid output.
A completed submission with invalid output gets one format-repair turn.
If repair fails validation, the node fails. The runtime never substitutes an
empty object or array to make this path succeed.

Repair prompts instruct the model to reuse prior successful tool results.
They prohibit repeating actions with side effects during format repair.
They also prohibit empty arrays or default values that hide failed inspection.
These instructions reduce model mistakes. They are not proof that inspection succeeded.

Checkpoint effects retain `repairAttempted` and `firstError` after repair.
The terminal checkpoint error records the latest failure. These fields describe
format repair only. They do not certify the completeness of an inventory.

## Workflow author guidance

A schema-valid empty array can mean either a valid empty inventory or an
unsupported model claim. Schema validation cannot distinguish these meanings.
The runtime accepts an empty array when the schema permits it.

If this distinction matters, require an explicit inspection status and evidence
in the output schema. Require the prompt to identify inspected sources and failures.
Branch failed or incomplete inspection to a failure or review step before consuming candidates.
Do not use `candidates: []` as the fallback for a failed inventory.
Use `minItems` only when an empty result is invalid for the actual task.

Changing the model or using an isolated session can reduce failures, but does
not establish that a schema-valid result is complete. No live workflow definition
is changed by this implementation.
