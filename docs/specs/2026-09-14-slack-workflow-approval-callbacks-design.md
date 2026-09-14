# Slack workflow approval callbacks

Workflow session decision gates use the workflow run owner for callback authorization.
Personal owners and current team members can resolve their gates. Org-owned gates require an org admin.
The host restores an authorized workflow session through its workflow session builder.
If restoration fails, the callback receives an actionable error and the gate stays pending.

Callbacks validate actions against the persisted pending gate.
The host serializes callbacks by the server-recorded prompt mapping and resolved gate id.
It never trusts a gate id from the callback payload for lookup or serialization.
This also covers transports whose callbacks carry only the message reference.

Malformed, stale, cross-org, and unauthorized callbacks receive the same expired response.
This prevents a callback from probing whether a gate or workflow session exists.
Drop logs retain the internal failure category for diagnosis: malformed, missing, deleted, or cross-org workflow sessions.

These callbacks resolve engine decision gates inside workflow sessions.
Authored workflow approval nodes continue to use workflow approval signals and the workflow run page.
