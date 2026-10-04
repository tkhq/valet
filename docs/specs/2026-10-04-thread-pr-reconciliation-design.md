# Thread pull request reconciliation

Thread list GET requests read persisted pull request state. They do not resolve GitHub credentials or start provider requests.

`thread-pull-requests.ts` owns pull request recording, delegation associations, webhook updates, and fallback reconciliation. `thread-read-state.ts` owns read markers and activity queries.

The API starts a fallback sweep after background boot. Each minute, the sweep checks at most five stale organization and URL groups. An open pull request becomes stale after ten minutes without a check or webhook. This also supports organizations without webhook delivery. A busy sweep does not overlap itself. Shutdown stops its timer and waits for the active pass before closing the database.

Before provider work, each worker locks the organization row in a short database transaction. It rechecks freshness and updates `checked_at` on all open associations for that organization and URL. Concurrent workers therefore share one durable check window, including ancestor thread associations. The transaction ends before credential resolution or network work. The oldest groups run first. Missing credentials, provider failures, and malformed responses consume the check window to prevent immediate retries.

Credential resolution uses the association's organization and parsed repository. It does not use the person who happens to list a thread. Provider responses update only that organization's associations. Webhook updates use the verified delivery's organization. A webhook received during a provider request takes precedence over the older response.

Tool outcomes still record created pull requests on their originating thread and delegation ancestors. Terminal comments and reviews still record Valet's own writes for webhook suppression. GitHub Enterprise URL parsing keeps the existing configured host behavior.

The existing `checked_at` column stores the claim. No schema changes or new job framework are required. Each PR fetch has a 30-second timeout. The sweep provides bounded eventual repair, rather than an immediate refresh when a person opens a list.

## Validation

Targeted tests cover parallel claims, duplicate associations, bounded batches, malformed provider responses, organization isolation, and webhook precedence. Existing thread activity and workspace channel tests cover read state and delegation associations.
