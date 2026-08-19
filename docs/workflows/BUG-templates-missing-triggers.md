# Bug: workflow templates ship without trigger configuration

## Symptom

Many workflow templates have a `trigger` node in their DAG but no actual trigger record bound to it (no cron schedule, no event subscription). They cannot fire on their own — they only run when manually invoked, which contradicts the template name and prompt.

## Concrete example

`wf_mszij35o3jv9bd` — "Nightly memory sweep"

- Has a `start` node of type `trigger` in the DAG.
- Has no cron trigger attached, so it does not run nightly despite the name.
- The orchestrator prompt begins "Run your nightly memory hygiene pass" — a user reasonably assumes it is scheduled.

## Suspected scope

This looks like a pattern across multiple templates. The `trigger` node in the DAG is a placeholder; the actual trigger record (cron expression, event keys, filters) is not created or linked when the template is instantiated into a workflow.

## Ask

1. **Immediate**: Attach a cron trigger to `wf_mszij35o3jv9bd` (nightly, timezone TBD with owner).
2. **Root cause**: Audit the template → workflow instantiation path. Where should trigger configuration come from? Candidates:
   - Template ships with a suggested trigger spec that the editor materializes on save.
   - Editor prompts the user to configure the trigger on first save.
   - Template metadata declares `defaultTrigger` and instantiation copies it.
3. **Fix**: Pick one path and make it consistent so a template named "Nightly …" is not silently un-scheduled.

## Follow-up

Root-cause investigation is in progress. This doc will be updated with findings and a proposed fix before the PR merges.
