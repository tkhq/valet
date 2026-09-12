# Sandbox bake queue

Add a queue panel before the base image editor in Sandbox settings.

1. Expose builder queue snapshots and reorder waiting builds on Docker and Kubernetes.
   Preserve other organizations' slots. Reject stale orders and running builds.
2. Add organization-admin queue read and reorder routes. Return active builds,
   ordered waiting builds, sources waiting for an active base, and recent results.
   Reuse current process-local builder ownership; do not introduce a second queue.
3. Add a responsive panel with counts, elapsed time, source names, status, log details,
   recent outcomes, and accessible move up/down/build-next controls. Refresh every five seconds.
4. Test queue ordering, stale requests, organization isolation, UI states, and failures.
   Run focused tests and type checks. Review adversarially, fix findings, update the PR.

Wire contract in packages/api/src/wire/types.ts:

- BakeQueueItem = BakeSummary plus sourceName: string, sourceKind: SourceSummary['kind'], repoFullName: string | null, phase?: "finalizing".
- BakeQueueBlockedSource = sourceId: string, name: string, repoFullName: string | null, parentName: string.
- ListBakeQueueResponse = builderAvailable: boolean, reorderAvailable: boolean,
  running: BakeQueueItem[], queued: BakeQueueItem[], recent: BakeQueueItem[], blocked: BakeQueueBlockedSource[].
- GET /api/org/sources/queue returns ListBakeQueueResponse.
- PATCH /api/org/sources/queue body { bakeIds: string[] } sends the full visible organization's waiting order.
  Return { ok: true }; reject a stale or invalid order with 409 and corrective copy.
  Never reorder running work or reveal another organization's builds.

The queue is process-local because current builders already own process-local queues.
Existing restart behavior remains authoritative. No schema change is needed.
