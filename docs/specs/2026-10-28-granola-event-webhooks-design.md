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
- **Secret storage.** The org credential `granola-webhook` (`api_key`, encrypted) holds the signing secret. The generic `PUT /api/credentials/granola-webhook` route saves it. The service name differs from `granola`, the personal MCP token, so owner escalation never reads the secret as an MCP token. The host resolver in `http-installations.ts` decrypts it. The resolver now receives the encryption key.
- **Verification.** Signature first, over the raw bytes, constant-time. Then the 300 second timestamp window. Then JSON, `event_type`, `event_id === webhook-id`, `note_id`, and `occurred_at`. Nothing from the body is read or logged before the signature passes.
- **Responses.** Bad signature gives 403. A signed event Valet cannot use gives 200 plus a drop-log row, so Granola does not retry or disable the endpoint.
- **Dedupe.** `dedupeKey` is the `webhook-id`. The ingest unique key makes a retry a no-op.

## Out of scope

- A web UI for the secret. The admin saves it through the credentials API.
- Arm-time readiness checks like Linear's. A subscription made before the secret exists stays idle until the secret is saved.
- Fetching note content. The event is a pointer. Workflows read the note with the Granola API or MCP tools.
- More than one signing secret for an organization.
