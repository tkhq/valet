# Prebuild observability

**Date:** 2026-09-11
**Status:** Implemented
**Scope:** Metrics, traces, logs, dashboard panels, and alerts for the current image source and bake pipeline.

## Signal model

The API emits OpenTelemetry metrics through the existing OTLP exporter. All metric labels have bounded value sets. Repository names, source IDs, build IDs, commits, image references, and image digests are not metric labels.

The API stores those details in the existing bake history. It also writes JSON lifecycle logs and a `prebuild.bake` trace. The bake row ID is the stable `buildId` and `bakeId` correlation value on logs and traces.

| Metric | Type | Labels |
| --- | --- | --- |
| `valet.prebuild.requests` | counter | `source_kind`, `profile`, `provider`, `outcome`, `trigger` |
| `valet.prebuild.builds` | counter | `source_kind`, `profile`, `provider`, `outcome` |
| `valet.prebuild.queue.depth` | gauge | `source_kind`, `profile`, `provider` |
| `valet.prebuild.queue.oldest_age` | gauge, seconds | `source_kind`, `profile`, `provider` |
| `valet.prebuild.builds.active` | gauge | `source_kind`, `profile`, `provider` |
| `valet.prebuild.bakes.latest` | gauge | `source_kind`, `profile`, `provider`, `status` |
| `valet.prebuild.queue_wait` | histogram, milliseconds | `source_kind`, `profile`, `provider` |
| `valet.prebuild.build.duration` | histogram, milliseconds | `source_kind`, `profile`, `provider` |
| `valet.prebuild.image.size` | histogram, bytes | `source_kind`, `profile`, `provider` |
| `valet.prebuild.cache.decisions` | counter | `source_kind`, `profile`, `provider`, `decision` |
| `valet.prebuild.capacity_blocked` | counter | `source_kind`, `profile`, `provider` |
| `valet.prebuild.registry.operations` | counter | `operation`, `outcome` |
| `valet.prebuild.registry.duration` | histogram, milliseconds | `operation`, `outcome` |
| `valet.prebuild.registry.bytes` | counter | `operation` |
| `valet.prebuild.registry.reconciliations` | counter | `outcome` |
| `valet.prebuild.cleanup` | counter | `provider`, `outcome` |

`source_kind` is `base`, `repo`, `external`, or `other`. `profile` is `full`, `headless`, `shared`, or `other`. Repository bakes use `shared` because both session profiles use one image lineage. `provider` is `docker`, `kubernetes`, `none`, or `other`. The metric funnel maps all unknown values to `other`.

Cache decisions distinguish hits, misses, changed commits, changed recipes, changed parents, coalesced requests, and expired sources. A queue wait above one second increments the available capacity-blocking signal. Bake history remains the queryable record for current and past status, image size, error, and log tail.

## Operator path

Open the bundled Grafana dashboard and use the **Sandbox image builds** row. The row shows queue depth, age, active work, throughput, latency, cache decisions, registry outcomes, latest bake state, and image size.

Select a trace ID in the recent image bakes table to inspect the `prebuild.bake` trace. Search API logs for the trace `buildId` to find the repository, commit, image reference, identity hash, queue wait, duration, size, and error. Use `GET /api/org/sources/:id/bakes` for the retained database history.

Grafana provisions alerts for these conditions:

- queued work with no build start for 15 minutes
- a failure ratio above 20 percent for 15 minutes
- an oldest queued age above 15 minutes
- a database bake that is missing from the registry

## Retention

The metrics and traces use the configured OpenTelemetry backend retention. Valet does not apply a second retention policy. The bundled stack has a 2 GiB persistent volume by default and makes no time-based retention guarantee. Operators must configure their remote backend for the required retention period.

Bake rows use the existing source history policy. Image cleanup keeps the newest images and images used by live sessions. The metrics do not change that policy.

## Available provider data

Docker and Kubernetes expose queue state, concurrency blocking, lifecycle status, duration, errors, and image size. Kubernetes also exposes BuildKit Job deadline failures through the terminal bake error and log tail.

The current builder port does not expose CPU time, memory peaks, network bytes, peak scratch use, OOM kills, evictions, or BuildKit cache bytes. The registry API calls expose lookup, manifest size, delete latency, outcomes, and observed bytes. The current registry does not expose total storage, growth, availability probes, garbage collection bytes, or pull throughput to the API.

Session provisioning already has separate sandbox duration and failure signals. The current session path does not persist a direct session-to-bake wait interval. This change does not infer unavailable provider data or redesign the builder, scheduler, registry, or session flow.
