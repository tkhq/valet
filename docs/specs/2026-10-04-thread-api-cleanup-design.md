# Thread API cleanup

Thread-addressed routes and session-addressed routes call the same operations directly.
The API does not construct a second HTTP request or run authentication twice.
Each operation receives its session and optional thread address explicitly.
Both address families retain session ownership, private-thread visibility, and approval authority checks.
A thread URL cannot resolve or withdraw another thread's decision.
Workflow runtime threads permit metadata and decision operations only.

The web client uses thread URLs for explicit thread history, prompts, edits, channel activity, abort, and resume.
Session-wide lists, default-thread submissions, execution controls, and aggregate decisions retain session addresses.
The engine and query cache still use session IDs internally.
REST remains authoritative for persisted history.

## Compatibility retirement

Installed CLI versions can still require the two orchestrator POST aliases.
These aliases share the workspace runtime handler. Remove them after the supported CLI floor uses workspace runtime URLs.
Session conversation aliases remain until external clients migrate to thread URLs.

Stored assistant target conversions remain available during upgrades from older binaries.
They must not become unconditional data deletion or bypass runtime permission checks.
A recorded conversion boundary can replace repeat scans only after deployments prohibit old writers.
Runtime status reconciliation remains an invariant check, separate from obsolete JSON conversion.

## Validation

Exercise both address families against persisted history.
Verify thread-local gate resolution and withdrawal, private threads, team API keys, workflow decisions, and malformed addresses.
Run client URL tests, API integration tests, typecheck, and the repository end-to-end scorecard.

Thread search rejects NUL characters before querying Postgres. The response asks the caller to remove the character.
