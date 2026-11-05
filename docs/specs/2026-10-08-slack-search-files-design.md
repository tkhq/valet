# Slack channel search and file access

## Channel lookup

`slack.search_channels` accepts the user's channel name or keyword in `query`.
It removes a leading `#` and matches names without case sensitivity.
Exact matches rank first. Substring matches follow.
`slack.list_channels` also accepts `query`. Its legacy `prefix` keeps starts-with semantics.
The caller cannot combine `query` and `prefix`.

Search follows Slack cursors before returning `search_complete`.
Results state the scope, match status, and whether multiple candidates exist.
An empty match does not establish a permissions failure.
The agent must resolve ambiguous candidates before posting.
Existing private-channel membership checks remain in force.

## File access

Message attachment metadata includes the Slack file ID.
`slack.fetch_file` accepts `file_id` or a legacy private file URL.
It resolves metadata through `files.info` with the run's connected credential.
It verifies at least one channel share through the existing channel access guard.
Missing share metadata fails closed. Public URL flags do not bypass this check.
Slack can omit older shares; a missing authorized share can prevent access.
Membership errors retain their corrective actions. Another authorized share can still permit access.

Team and organization runs can read files shared into authorized channels.
They cannot read DM-only attachments. Personal runs need linked membership for private channels and DMs.
The download uses only the canonical HTTPS `files.slack.com` URL returned by Slack.
Redirects are rejected. Tokens never appear in tool results.
The Slack connection needs `files:read`.

Without `output_path`, existing image, text, PDF, and DOCX readers process the content.
With `output_path`, the tool saves original bytes in the current sandbox for editing.
Downloads are limited to 25 MB; inline image reads are limited to 10 MB.
The operation does not modify the original Slack file.
Externally hosted files require their provider's tools.

## Validation

Plugin tests cover keyword ranking, pagination, empty results, shared access, DM restrictions, and unlinked personal owners.
They also cover missing shares, untrusted URLs, byte limits, and original-file saves.
Mock-profile agent evaluations exercise channel lookup, empty-result interpretation, and file reading with the real action schemas.
These evaluations require a configured model provider. Canned Slack responses do not verify a live installation.
