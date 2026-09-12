import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpToLine, Boxes, CheckCircle2, Clock3, Layers3 } from "lucide-react";
import { ApiError } from "~/api/client";
import { useBakeQueue, useReorderBakeQueue, type BakeQueueItem } from "~/api/sources";
import { Badge, Button, Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";

function bakeName(bake: BakeQueueItem) {
  return bake.repoFullName ?? bake.sourceName;
}

function reorderError(error: Error) {
  if (error instanceof ApiError && typeof error.payload === "object" && error.payload !== null && "error" in error.payload && typeof error.payload.error === "string") {
    return error.payload.error;
  }
  return "Queue order was not saved. Refresh the queue and try again.";
}

export function BakeQueuePanel() {
  const queue = useBakeQueue();
  const reorder = useReorderBakeQueue();
  const [saveError, setSaveError] = useState<string | null>(null);
  const data = queue.data;
  // Successful refreshes update relative times even when queue contents stay unchanged.
  const now = queue.dataUpdatedAt || Date.now();

  function move(index: number, destination: number) {
    if (!data || reorder.isPending || queue.error || !data.reorderAvailable) return;
    const ids = data.queued.map((bake) => bake.id);
    const [id] = ids.splice(index, 1);
    if (!id || destination < 0 || destination > ids.length) return;
    ids.splice(destination, 0, id);
    setSaveError(null);
    reorder.mutate(ids, { onError: (error) => setSaveError(reorderError(error)) });
  }

  const busy = Boolean(data && (data.running.length || data.queued.length || data.blocked.length));

  return (
    <section aria-labelledby="bake-queue-title" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="bake-queue-title" className="flex items-center gap-2 font-display text-xl text-ink">
            <Layers3 className="h-5 w-5 text-moss" aria-hidden /> Bake queue
          </h2>
          <p className="text-sm text-muted">Follow base image builds and repository rebuilds. Choose what builds next.</p>
        </div>
        {data && data.builderAvailable && (
          <span className="flex items-center gap-1.5 text-xs text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-moss" aria-hidden /> Refreshes every 5s
          </span>
        )}
      </div>

      {queue.isLoading && <p className="flex items-center gap-2 text-sm text-muted"><Spinner size={14} />Loading bake queue…</p>}
      {queue.error && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-line p-3 text-sm text-danger-500">
          Queue could not load. Retry to see the latest builds.
          <Button variant="secondary" size="sm" onClick={() => void queue.refetch()}>Retry queue</Button>
        </div>
      )}
      {saveError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger-500">
          {saveError}
          <Button variant="secondary" size="sm" onClick={() => void queue.refetch()}>Refresh queue</Button>
        </div>
      )}
      {data && !data.builderAvailable && (
        <p className="rounded-lg border border-line bg-ink-wash p-4 text-sm text-muted">
          Image builds are unavailable. Contact your administrator to configure an image builder.
        </p>
      )}
      {data && data.builderAvailable && (
        <div className="overflow-hidden rounded-xl border border-line">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-ink-wash px-4 py-3 text-xs">
            <span className="flex items-center gap-2 text-ink"><span className="font-mono text-lg font-semibold">{data.running.length}</span> in progress</span>
            <span className="flex items-center gap-2 text-ink"><span className="font-mono text-lg font-semibold">{data.queued.length}</span> queued</span>
            <span className="flex items-center gap-2 text-muted"><span className="font-mono text-lg font-semibold">{data.blocked.length}</span> waiting for base</span>
          </div>

          {!busy ? (
            <div className="flex items-center gap-3 px-4 py-5">
              <CheckCircle2 className="h-6 w-6 shrink-0 text-success-600 dark:text-success-500" aria-hidden />
              <div>
                <p className="text-sm font-medium text-ink">No builds in progress</p>
                <p className="mt-0.5 text-xs text-muted">New builds appear here when they enter the queue.</p>
              </div>
            </div>
          ) : (
            <div className="grid lg:grid-cols-2">
              <div className="space-y-3 border-b border-line p-4 lg:border-b-0 lg:border-r">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted">In progress</h3>
                {data.running.length === 0 ? (
                  <p className="py-3 text-sm text-muted">Waiting for the next build to start.</p>
                ) : (
                  <div className="max-h-72 space-y-3 overflow-y-auto">
                    {data.running.map((bake) => (
                      <div key={bake.id} className="space-y-3 rounded-lg border border-line bg-moss-wash p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs text-muted">{bake.sourceKind === "base" ? "Base image" : "Repository image"}</span>
                          <Badge variant="accent" className="gap-1.5 rounded-full"><Spinner size={10} />{bake.phase === "finalizing" ? "Finalizing" : bake.status === "queued" ? "Starting" : "Building"}</Badge>
                        </div>
                        <p className="break-words text-sm font-semibold text-ink">{bakeName(bake)}</p>
                        <BuildMeta bake={bake} now={now} />
                        {bake.logTail ? (
                          <details className="text-xs">
                            <summary className="cursor-pointer text-muted focus-visible:outline-moss">Build output</summary>
                            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-paper p-2 font-mono text-muted">{bake.logTail}</pre>
                          </details>
                        ) : <p className="text-xs text-muted">Waiting for build output…</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="min-w-0 p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Up next</h3>
                  {reorder.isPending && <span role="status" className="text-xs text-muted">Updating order…</span>}
                </div>
                {data.queued.length === 0 ? (
                  <p className="py-3 text-sm text-muted">No builds queued.</p>
                ) : (
                  <ol aria-label="Waiting build order" className="max-h-72 divide-y divide-line overflow-y-auto">
                    {data.queued.map((bake, index) => (
                      <li key={bake.id} className="flex flex-wrap items-center gap-2 py-3 first:pt-0">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-ink-wash font-mono text-xs text-muted">{index + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium text-ink">{bakeName(bake)}</p>
                          <p className="mt-0.5 text-xs text-muted">{bake.sourceKind === "base" ? "Base image" : "Repository"} · queued {relativeTime(bake.createdAt, now)}</p>
                        </div>
                        {data.reorderAvailable && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button variant="ghost" size="sm" aria-label={`Build ${bakeName(bake)} next`} title="Build next" disabled={index === 0 || reorder.isPending || Boolean(queue.error)} onClick={() => move(index, 0)}><ArrowUpToLine className="h-3.5 w-3.5" aria-hidden /></Button>
                            <Button variant="ghost" size="sm" aria-label={`Move ${bakeName(bake)} up`} title="Move up" disabled={index === 0 || reorder.isPending || Boolean(queue.error)} onClick={() => move(index, index - 1)}><ArrowUp className="h-3.5 w-3.5" aria-hidden /></Button>
                            <Button variant="ghost" size="sm" aria-label={`Move ${bakeName(bake)} down`} title="Move down" disabled={index === data.queued.length - 1 || reorder.isPending || Boolean(queue.error)} onClick={() => move(index, index + 1)}><ArrowDown className="h-3.5 w-3.5" aria-hidden /></Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <p className="mt-3 text-xs text-muted">{data.reorderAvailable ? "Order applies within your organization. Builds already started stay in place." : "This builder does not support queue reordering."}</p>
              </div>
            </div>
          )}

          {data.blocked.length > 0 && (
            <details className="border-t border-line px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-muted focus-visible:outline-moss">{data.blocked.length} repositories waiting for a base image</summary>
              <ul className="mt-3 max-h-40 space-y-2 overflow-auto">
                {data.blocked.map((source) => (
                  <li key={source.sourceId} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2 text-ink"><Clock3 className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />{source.repoFullName ?? source.name}</span>
                    <span className="text-muted">Waiting for {source.parentName}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">These repositories can rebuild after their base image builds successfully.</p>
            </details>
          )}

          {data.recent.length > 0 && (
            <details className="border-t border-line px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-muted focus-visible:outline-moss">
                Recent builds · {data.recent.filter((bake) => bake.status === "pushed").length} built · {data.recent.filter((bake) => bake.status === "failed").length} failed
              </summary>
              <ul className="mt-3 max-h-52 space-y-3 overflow-auto">
                {data.recent.map((bake) => (
                  <li key={bake.id} className="space-y-1 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="break-words font-medium text-ink">{bakeName(bake)}</span>
                      <span className="flex items-center gap-2"><span className="text-muted">{relativeTime(bake.finishedAt ?? bake.createdAt, now)}</span><Badge className="rounded-full" variant={bake.status === "failed" ? "danger" : "success"}>{bake.status === "failed" ? "Build failed" : "Built"}</Badge></span>
                    </div>
                    {bake.error && <p className="whitespace-pre-wrap break-words text-danger-500">{bake.error}</p>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function BuildMeta({ bake, now }: { bake: BakeQueueItem; now: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <Boxes className="h-3.5 w-3.5" aria-hidden />
      <span>Submitted {relativeTime(bake.createdAt, now)}</span>
      {bake.commitSha && <code className="rounded bg-paper px-1.5 py-0.5">{bake.commitSha.slice(0, 7)}</code>}
    </div>
  );
}
