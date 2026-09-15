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

## Rejections are visible on Slack

Slack acknowledges a button click with an empty body, so a refused click shows nothing by itself.
The Slack transport records the `response_url` of each parsed click, keyed by its trigger id.
When the host refuses a callback, the transport posts the reason to that URL as an ephemeral reply.
If the click carries no `response_url`, or the URL no longer accepts the post, the transport sends an ephemeral message to the channel and the clicker.
The transport posts only to a Slack host, so a payload that arrives without Slack's signature cannot aim the answer at another address.
A callback answered without text sends nothing, because the acknowledgement already stands.
Every failure to answer is logged and the callback continues, because the gate outcome is already decided.
