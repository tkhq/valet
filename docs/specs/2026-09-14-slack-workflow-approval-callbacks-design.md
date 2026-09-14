# Slack workflow approval callbacks

Workflow session decision gates use the workflow run owner for callback authorization.
Personal owners and current team members can resolve their gates. Org-owned gates require an org admin.
The host restores an authorized workflow session through its workflow session builder.
If restoration fails, the callback receives an actionable error and the gate stays pending.

Callbacks validate actions against the persisted pending gate.
The host serializes callbacks by the mapped gate id, including prompts sent to different recipients.
This also covers transports whose callbacks carry only the message reference.

These callbacks resolve engine decision gates inside workflow sessions.
Authored workflow approval nodes continue to use workflow approval signals and the workflow run page.
