# Granola event webhooks

**Status: implemented 2026-10-28.** Base: `dev-v2`.

## Problem

Workflows can trigger on GitHub, Slack, and Linear events but not on Granola. Granola documents note webhooks ([docs.granola.ai/webhooks](https://docs.granola.ai/webhooks)). This change adds them as an event source on the generic event rail.

## Provider facts (from the Granola docs)

- Events: `note.generated`, `note.edited`, `note.access_granted`.
- Payload: `event_id`, `event_type`, `note_id`, `occurred_at`. `note.edited` adds `data.changed_fields`. The payload has no organization or workspace ID.
- Signature: Standard Webhooks. Headers `webhook-id` (equals `event_id`), `webhook-timestamp` (Unix seconds of the attempt), `webhook-signature` (`v1,<base64>`, space-separated list). HMAC-SHA256 over `{id}.{timestamp}.{raw body}`, keyed with the base64-decoded secret after `whsec_`.
- Retries reuse `event_id`. 2xx is delivered. 408, 429, 5xx retry. Other 4xx and 3xx fail permanently.

## Design

`packages/plugin-granola` is a trigger-only plugin: one `TriggerDef` (`granola.note`) with three catalog keys (`granola.note.generated`, `granola.note.edited`, `granola.note.access_granted`) and one signed route, `POST /plugins/granola/http/events/:orgId`. It declares no MCP action, so it cannot collide with a config-declared `granola` MCP server.

- **Tenant lookup.** The payload names no tenant, so the URL carries the organization ID. The ID only selects a candidate secret. The signature is the authentication, as with Linear's workspace ID.
- **Secret storage.** The org credential `granola-webhook` (`api_key`, encrypted) holds the signing secret. The generic `PUT /api/credentials/granola-webhook` route saves it. The service name differs from `granola`, the personal MCP token, so owner escalation never reads the secret as an MCP token. The save route accepts only a direct `whsec_` `api_key` at org scope and returns 400 for a 1Password reference, `bot_token`, or other form. The host resolver in `http-installations.ts` decrypts the key and receives the encryption key for that. A 1Password reference would need a live resolver call for every unsigned request, so it is out of scope.
- **Verification.** Signature first, over the raw bytes, constant-time, whatever the timestamp. Then the 300 second timestamp window. Then JSON, `event_type`, `event_id === webhook-id`, `note_id`, and `occurred_at`. Nothing from the body is read or logged before the signature passes.
- **Missing or unreadable secret.** The resolver throws `HttpInstallationUnavailable`. The route answers 503 and writes a `secret_unavailable` drop-log row for an existing organization only. Granola retries 5xx for four days, so events survive until an admin saves the secret. The test event that Granola can send at creation arrives before the secret is saved, so a silent 200 would hide the setup fault.
- **Stale timestamps.** Decided 2026-10-28: a delivery with a valid signature and a timestamp outside the window gets 503 and a `stale_delivery` drop-log row. Granola retries 5xx with a fresh attempt timestamp and the same `event_id`. The trigger sets `TriggerRejection.retry` only after the signature verified, and the route honors it only for a non-`bad_signature` rejection, so an unauthenticated request never gets 503 for staleness. The Granola route calls one inspection with one clock reading for both the outcome and the rejection. Two reads could disagree at the window edge and acknowledge a delivery that Granola would never resend. Linear's stale handling is unchanged (200).
- **Responses.** Bad signature gives 403. A signed event Valet cannot use for another reason (unsupported type, malformed body) gives 200 plus a drop-log row, so Granola does not retry or disable the endpoint.
- **Dedupe.** `dedupeKey` is the `webhook-id`. The ingest unique key makes a retry a no-op.

## Known limit: wrong secret

The save route checks the `whsec_` format only. It cannot check the secret against Granola. A wrong secret gives 403 on every delivery, and Granola fails those permanently and does not replay them. Valet keeps 403 for an invalid signature. The trade-off: 403 stops retries of unauthenticated traffic, but it permanently loses deliveries when a real endpoint is configured with the wrong secret. Granola enables a webhook when it creates it, so the setup guide tells admins to keep real notes out until a test event verifies the secret, and to create a new webhook if the secret is lost.

## Out of scope

- A web UI for the secret. The admin saves it through the credentials API.
- Arm-time readiness checks like Linear's. A subscription made before the secret exists stays idle until the secret is saved.
- Fetching note content. The event is a pointer. Workflows read the note with the Granola API or MCP tools.
- More than one signing secret for an organization. Decided 2026-10-28: one endpoint and one secret for each organization. A second Granola endpoint that uses the same URL fails with `bad_signature`.
