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
8. In Granola, send a test event. Check that the event appears in the Valet event log.

Each Valet organization uses one signing secret. Create one Granola webhook for the organization. Do not use the service name `granola` for this credential. That name is the personal Granola MCP connection.

## How Valet checks a delivery

Valet follows the Standard Webhooks scheme that Granola documents.

1. Valet reads the raw body and the `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers.
2. Valet computes HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`. The key is the base64-decoded secret without the `whsec_` prefix.
3. Valet compares the result with each `v1` signature in the header, in constant time.
4. Valet rejects a timestamp more than 300 seconds from the server clock.
5. Valet parses the JSON only after the signature passes. The `webhook-id` must equal `event_id`.

| Result | HTTP answer | Drop log reason |
| --- | --- | --- |
| Valid event | 200 | none |
| Signature missing or wrong, or saved secret not a `whsec_` value | 403 | `bad_signature` |
| Signed, but timestamp outside 300 seconds | 200 | `stale_delivery` |
| Signed, but not a JSON object or a field is missing | 200 | `malformed_callback` |
| Signed, but unsupported event type | 200 | `unsupported_event` |
| Unknown organization or no saved secret | 200 | none |

Granola retries on 408, 429, 5xx, and timeouts. It treats other 4xx answers as permanent failures. Retries reuse `event_id`, which Valet uses as the dedupe key, so a retry never starts a second run. Granola disables an endpoint that fails for four days. Valet limits the body to 64 KiB.

## Troubleshooting

- **No events arrive.** Check that the URL contains your organization ID and that the secret is saved. Valet records nothing when no secret is saved.
- **`bad_signature` in the drop log.** Save the signing secret again. If you have several Granola webhooks that send to this URL, delete the extra ones.
- **`stale_delivery` in the drop log.** Check the clock on the Valet server.
- **A subscription never fires.** Valet does not check that the secret exists when you create the subscription. Save the secret first.
