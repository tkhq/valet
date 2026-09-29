import { useState } from "react";
import type { ModelRegistryStatusResponse } from "@valet/api/wire";
import { Button, Spinner } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useModelDiscoveries, useReviewModelDiscovery } from "~/api/settings";
import { apiErrorMessage } from "~/api/policies";

const REGISTRY_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

type RegistryHealth = "current" | "stale" | "failed" | "offline";

export function registryHealth(status: ModelRegistryStatusResponse, now: number = Date.now()): RegistryHealth {
  if (!status.remoteEnabled) return "offline";
  if (status.providers.some((provider) => provider.lastError !== null)) return "failed";
  if (status.providers.some((provider) => provider.checkedAt === null || now - provider.checkedAt > REGISTRY_STALE_AFTER_MS)) {
    return "stale";
  }
  return "current";
}

export function ModelDiscoveriesSection() {
  const discoveries = useModelDiscoveries();
  const review = useReviewModelDiscovery();
  const [error, setError] = useState<string | null>(null);

  function decide(providerId: string, modelId: string, state: "approved" | "rejected") {
    setError(null);
    review.mutate(
      { providerId, modelId, state },
      { onError: (err) => setError(apiErrorMessage(err)) },
    );
  }

  const health = discoveries.data ? registryHealth(discoveries.data.registry) : null;
  return (
    <Section
      title="New model discoveries"
      description="Review upstream-only models before they become available for model settings."
    >
      {discoveries.isLoading && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted"><Spinner size={14} /> Loading…</div>
      )}
      {discoveries.error && <p className="py-4 text-sm text-danger-500">Failed to load model discoveries.</p>}
      {discoveries.data && (
        <div className="space-y-4 py-4">
          <p className="text-sm text-muted">
            Registry: <span className="font-medium text-ink">{health}</span>
            {health === "offline" && " (using the bundled catalog)"}
            {health === "failed" && " (approved models remain available)"}
          </p>
          {error && <p className="text-xs text-danger-500">{error}</p>}
          {discoveries.data.discoveries.length === 0 ? (
            <p className="text-sm text-muted">No upstream-only models found.</p>
          ) : (
            <div className="space-y-3">
              {discoveries.data.discoveries.map((model) => (
                <div key={`${model.providerId}/${model.modelId}`} className="rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-ink">{model.name}</div>
                      <div className="text-xs text-muted">{model.providerId} · {model.modelId}</div>
                      <div className="text-xs text-muted">
                        {model.api} · {model.contextWindow.toLocaleString()} context · discovered {new Date(model.discoveredAt).toLocaleString()}
                      </div>
                    </div>
                    <span className="rounded-full bg-surface-2 px-2 py-1 text-xs font-medium text-ink">{model.state}</span>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <Button
                      size="sm"
                      disabled={review.isPending || model.state === "approved"}
                      onClick={() => decide(model.providerId, model.modelId, "approved")}
                    >Approve</Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={review.isPending || model.state === "rejected"}
                      onClick={() => decide(model.providerId, model.modelId, "rejected")}
                    >Reject</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
