import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type OwnerFilter } from "~/api/client";
import { Button, ConfirmDialog } from "~/components/primitives";
import { errorText } from "~/lib/error-text";

/**
 * A workspace whose assistant had an integration allow-list before a
 * workspace had one assistant keeps that limit until an admin clears it.
 * Nothing shows when there is no limit.
 */
export function IntegrationLimitNotice({ owner, canClear }: { owner: OwnerFilter; canClear: boolean }) {
  const queryKey = ["integration-limit", owner.ownerType, owner.ownerId];
  const queryClient = useQueryClient();
  const limit = useQuery({ queryKey, queryFn: () => api.getIntegrationLimit(owner) });
  const clear = useMutation({
    mutationFn: () => api.clearIntegrationLimit(owner),
    onSuccess: () => { setConfirming(false); void queryClient.invalidateQueries({ queryKey }); },
  });
  const [confirming, setConfirming] = useState(false);
  const services = limit.data?.services;
  if (!services) return null;
  return (
    <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-warning-wash px-3 py-2 text-sm text-ink">
      <p className="min-w-0 flex-1">
        Valet in this workspace can use only {services.length > 0 ? services.join(", ") : "no integrations"}. The limit came from its earlier assistant settings.
      </p>
      {canClear && <Button size="sm" variant="secondary" onClick={() => { clear.reset(); setConfirming(true); }}>Clear limit</Button>}
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Clear the integration limit?"
        description="Valet in this workspace can then use every integration it is entitled to. Action policies and approvals still apply."
        confirmLabel="Clear limit" pendingLabel="Clearing…" pending={clear.isPending}
        error={clear.error ? errorText(clear.error) : undefined}
        onConfirm={() => clear.mutate()} />
    </div>
  );
}
