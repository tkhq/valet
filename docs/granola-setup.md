# Granola event setup

Use this guide to start a workflow when a note changes in Granola. Valet receives Granola webhooks, checks the signature, and turns each delivery into an event. A workflow trigger subscribes to the event.

## Supported events

Valet supports the three events that Granola documents at [docs.granola.ai/webhooks](https://docs.granola.ai/webhooks).

| Event key | Granola sends it when |
| --- | --- |
| `granola.note.generated` | The first AI summary of a note is generated. |
| `granola.note.edited` | The summary of a note is edited or regenerated. |
| `granola.note.access_granted` | A note is shared with the webhook owner, directly or through a folder. |

Valet does not handle other Granola events. If Granola sends one, Valet answers 200 and records an `unsupported_event` entry in the event drop log.

The event carries no note content. The trigger payload has these fields:

- `event_id`, `event_type`, `note_id`, and `occurred_at` from Granola.
- `data.changed_fields` for `granola.note.edited`. Granola currently always sends `["summary"]`.

To read the note, call the Granola API, or the Granola MCP tools if you connected them, with `note_id`.

You can filter a subscription on `note_id`.

## Requirements

- A Granola Business or Enterprise plan. Granola offers webhooks only on these plans.
- A Valet organization admin.
- A public HTTPS URL for the Valet API. Set `VALET_PUBLIC_URL`. Granola rejects private network addresses.

## Set up

1. Get your organization ID. Call `GET /api/me` and read `orgId`.
2. In Granola, open **Settings > Connectors > Webhooks** and select **Set up a webhook**. You can also use the Granola API (`POST /v1/webhook-endpoints`).
3. Choose the notes and the events to receive.
4. Enter this URL: `https://<your-valet-host>/plugins/granola/http/events/<orgId>`.
5. Create the webhook. Copy the signing secret. It starts with `whsec_`. Granola shows it once.
6. Save the secret in Valet as an organization credential. Run this command as an organization admin:

   ```bash
   curl -X PUT https://<your-valet-host>/api/credentials/granola-webhook \
     -H "x-api-key: $VALET_API_KEY" -H "Content-Type: application/json" \
     -d '{"scope":"org","type":"api_key","apiKey":"whsec_..."}'
   ```

7. Create a workflow trigger or an event subscription for one of the event keys above.
8. Keep the Granola confirmation dialog open from step 5. After you save the secret, send the test event from that dialog. Check that the event appears in the Valet event log.

Valet saves the secret only as a direct `api_key` at `org` scope, and the value must start with `whsec_`. Valet refuses a 1Password reference, a `bot_token`, or any other form with a 400 answer, because it must read the secret on every unsigned request.

## Warning: Granola cannot replay lost deliveries

Valet checks only that the saved value is a well-formed `whsec_` secret. It cannot tell whether the secret is the right one for your Granola webhook. If the saved secret is wrong, Valet answers 403 to every delivery. Granola treats a 403 as a permanent failure, does not retry it, and does not replay missed events later. Those events are lost.

The same loss happens when a second, unsupported Granola webhook sends to the same URL (see the next section).

A Granola webhook is live as soon as you create it. Granola has no later enable step, and it shows the signing secret only once. Copy the secret carefully before you close the dialog.

To avoid loss, check the secret before real notes reach the webhook. Granola documents the test event only in the confirmation dialog that appears when you create the webhook. The webhook is live while you use it.

1. Create the webhook for an unused folder, so that no real notes reach it during setup. Do not pause the endpoint for this. Granola does not replay deliveries that a paused endpoint misses, and the guide does not cover testing a paused endpoint.
2. Keep the confirmation dialog open. Copy the secret without extra spaces.
3. Save the secret in Valet.
4. In the same dialog, send the test event. Check that it appears in the Valet event log.
5. If the drop log shows `bad_signature`, the saved secret is wrong. If you can no longer copy the right secret, delete the webhook in Granola and create a new one for the unused folder. Save the new secret, then send the test event from the new dialog.
6. When the test event works, change the webhook in Granola to the folders that you need.

## Limitation: one webhook for each organization

Valet supports one Granola webhook endpoint and one signing secret for each organization. Granola allows more endpoints, such as separate personal, public, workspace, and folder endpoints. Each Granola endpoint has its own signing secret.

If you create a second Granola webhook that sends to the same Valet URL, only the webhook whose secret is saved in Valet works. Valet answers 403 `bad_signature` to the others and drops their events. Valet does not support more than one secret yet.

To cover several sets of notes, create one Granola webhook and choose its scope and folders in Granola. Use a scope that includes every note you need. Do not use the service name `granola` for this credential. That name is the personal Granola MCP connection.

## How Valet checks a delivery

Valet follows the Standard Webhooks scheme that Granola documents.

1. Valet reads the raw body and the `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers.
2. Valet computes HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`. The key is the base64-decoded secret without the `whsec_` prefix.
3. Valet compares the result with each `v1` signature in the header, in constant time.
4. Only after the signature passes, Valet rejects a timestamp more than 300 seconds from the server clock. Valet answers 503, so Granola retries with the timestamp of the new attempt. Valet does not ingest the stale delivery. A request with a wrong signature gets 403 whatever its timestamp.
5. Valet parses the JSON only after the signature passes. The `webhook-id` must equal `event_id`.

| Result | HTTP answer | Drop log reason |
| --- | --- | --- |
| Valid event | 200 | none |
| Signature missing or wrong, or saved secret not a `whsec_` value | 403 | `bad_signature` |
| Valid signature, but timestamp outside 300 seconds | 503 | `stale_delivery` |
| Signed, but not a JSON object or a field is missing | 200 | `malformed_callback` |
| Signed, but unsupported event type | 200 | `unsupported_event` |
| No saved secret, or a saved secret Valet cannot read | 503 | `secret_unavailable` (only for an existing organization) |

Granola retries on 408, 429, 5xx, and timeouts. The 503 answer makes Granola retry, so a delivery that arrives before you save the secret, or while the saved secret is unreadable, is delivered after you fix it. It treats other 4xx answers as permanent failures. Retries reuse `event_id`, which Valet uses as the dedupe key, so a retry never starts a second run. Granola disables an endpoint that fails for four days. Valet limits the body to 64 KiB.

## Troubleshooting

- **No events arrive.** Check that the URL contains your organization ID and that the secret is saved. Without a saved secret, Valet answers 503 and Granola retries.
- **`bad_signature` in the drop log.** The saved secret does not match the Granola webhook, or a second Granola webhook sends to this URL. Valet answers 403. Granola does not retry or replay 403 deliveries, so those events are lost. Save the right secret. If the secret is lost, create a new Granola webhook and save its secret. Delete extra Granola webhooks for this URL. Then send the test event from the confirmation dialog of the new webhook.
- **`secret_unavailable` in the drop log.** Valet has no readable secret. Save the secret with the command above. If you lost it, create a new Granola webhook and save its new secret.
- **`stale_delivery` in the drop log.** Granola sent a validly signed delivery with an old or future timestamp, and Valet asked Granola to retry. If this repeats, check the clock on the Valet server.
- **A subscription never fires.** Valet does not check that the secret exists when you create the subscription. Save the secret first.
