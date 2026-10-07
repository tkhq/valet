# Native Google Slides editing

The Google Workspace plugin includes a `google-slides` skill and five actions: get presentation summary, get page, get thumbnail, create presentation, and batch update. These actions use the existing `google_workspace` credential and Drive OAuth scope. They do not use the browser sandbox or a tunnel.

Summary reads omit slide text. Agents read individual pages for edits, then verify the affected pages. Batch updates accept at most 100 Google Slides Request objects and require a revision ID from a recent read. Google rejects a stale revision instead of overwriting concurrent changes. Write actions retain normal approval enforcement; batch updates have high risk because they can delete content.

The shared label guard classifies all five actions and extracts presentation IDs. API configuration errors explain how to enable `slides.googleapis.com`; permission errors identify the connected-account access check. Interrupted writes are not retried automatically because the server may already have applied them. No database migration or OAuth scope expansion is required.

Validation uses mocked Google HTTP responses for authentication, summary reads, atomic revision-bound edits, failures, and guard classification. Live Google editing requires an enabled Slides API and an authorized test presentation.

Reference: https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/batchUpdate
