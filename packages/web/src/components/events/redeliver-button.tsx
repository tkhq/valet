import { useState } from "react";
import { RotateCcw } from "lucide-react";
import type { EventDeliveryWire } from "@valet/api/wire";
import { Button, ConfirmDialog } from "~/components/primitives";
import { useEventSubscriptions, useRedeliverEvent } from "~/api/events";
import { errorText } from "~/lib/error-text";
import {
  redeliverConfirmDescription,
  redeliverResultText,
  scheduledRetryCount,
  subscriptionsMatchingKey,
} from "./delivery-copy";

/**
 * Sends one event through the subscriptions that match it now.
 *
 * Redelivery can start real agent runs, so it confirms first and the confirm
 * step names the size of what it starts. The server writes NEW delivery rows
 * rather than reviving old ones — it has to, because the workflow dispatcher
 * derives a run id from the delivery id and skips a run that already exists.
 */
export function RedeliverButton({
  eventId,
  eventKey,
  deliveries,
}: {
  eventId: string;
  eventKey: string;
  deliveries: EventDeliveryWire[];
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const subscriptionsQ = useEventSubscriptions();
  const redeliver = useRedeliverEvent(eventId);

  const matchCount = subscriptionsMatchingKey(subscriptionsQ.data?.subscriptions ?? [], eventKey).length;
  const scheduled = scheduledRetryCount(deliveries);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        Redeliver
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Redeliver this event?"
        description={redeliverConfirmDescription(matchCount, scheduled)}
        confirmLabel="Redeliver"
        pendingLabel="Redelivering…"
        pending={redeliver.isPending}
        error={redeliver.error ? errorText(redeliver.error) : undefined}
        onConfirm={() =>
          redeliver.mutate(undefined, {
            onSuccess: (res) => {
              setResult(redeliverResultText(res.created));
              setOpen(false);
            },
          })
        }
      />

      {result != null && (
        <p role="status" className="mt-2 text-xs text-muted">
          {result}
        </p>
      )}
    </>
  );
}
