# Local Kubernetes reference environment (Rancher Desktop)

This is the runbook for running Valet v2 on Kubernetes locally. The full
design is in `docs/specs/2026-07-15-kubernetes-deployment-design.md`.

**Context safety (binding):** the developer machine's default kubectl
context may point at a PRODUCTION cluster. On this machine it does (a GKE
prod cluster, verified). Every command below, and every `make k8s-*`
target, pins `--context rancher-desktop` (`--kube-context rancher-desktop`
for helm). Never run a bare `kubectl` or `helm` command against this repo's
k8s workflow. Use the `make` targets, or add the context flag yourself.

## Prerequisites

- Rancher Desktop with Kubernetes enabled, in **moby (dockerd) mode**, not
  containerd mode. This repo builds its k8s images with plain
  `docker build`, which needs the docker socket that moby mode provides.
  Moby mode also keeps `sandbox-docker` and `make test-pg` working
  unmodified (decision 2 in the design spec). Confirm the context with
  `kubectl config get-contexts rancher-desktop`.
- `helm` v3+, `kubectl`, Docker CLI.
- `ANTHROPIC_API_KEY` in your shell environment or repo-root `.env`. Never
  commit it.

## One-time: install agent-sandbox

Valet's k8s sandbox provider drives session lifecycle through the
[agent-sandbox](https://agent-sandbox.sigs.k8s.io/) `Sandbox` CRD. No
published Helm chart exists for it. We vendor the release manifest and
apply it directly:

```sh
make k8s-sandbox-install
```

The target is idempotent — a re-run is a server-side-apply no-op. See
`deploy/agent-sandbox/README.md` for what it installs.

## Build the images

```sh
make k8s-build
```

This builds `valet-api:dev` (api plus the bundled `packages/web` static
build) and `valet-sandbox:dev` (the session sandbox image) with plain
`docker build`. Rancher Desktop's moby mode backs k3s with cri-dockerd, so
k3s pods see these images immediately. No registry, no `docker push`, no
`imagePullPolicy` surprises — the chart pins concrete tags with
`IfNotPresent`.

The first build is slow (~15-20 min, mostly `pnpm install` and the
monorepo build). Later builds reuse Docker's layer cache and are faster.

If you switched Rancher Desktop to containerd mode, `make k8s-build`
prints the `nerdctl --namespace k8s.io build` equivalent. That path is a
documented variant only, not the default.

## Deploy

```sh
make k8s-up
```

This installs agent-sandbox (idempotent, see above), then runs
`helm upgrade --install` with `--kube-context rancher-desktop` into the
`valet` namespace. Override the namespace with `K8S_NAMESPACE=`.

Secrets:

- `ANTHROPIC_API_KEY` is read from your environment or `.env` and passed
  via `--set`. It is never written to disk or committed.
- `BETTER_AUTH_SECRET`, `VALET_ENCRYPTION_KEY`, and the bundled Postgres
  password are chart-generated on first install and retained after that
  (see `deploy/chart/valet/README.md`). You do not need to supply them.
  Because they survive `helm upgrade`, a redeploy does not invalidate
  sessions, cookies, or the sandbox JWT master.
- To rotate a key, change it and run `make k8s-up` again. Kubernetes
  injects env vars at pod start only, so a new Secret value does not reach
  a running pod. The api pod template carries `checksum/secret` and
  `checksum/config` annotations for this reason: a changed key or config
  value rolls the api Deployment.
- `api.extraEnvFrom` points at Secrets and ConfigMaps that this chart does
  not render, and the checksums do not cover them. If you rotate one of
  those, restart the api yourself:
  ```sh
  kubectl --context rancher-desktop -n valet rollout restart deployment/valet-api
  ```

The api Deployment has an initContainer that blocks on the bundled
Postgres StatefulSet's readiness, because the api runs migrations at boot.
`helm upgrade --install --wait` therefore returns only once the api pod is
`Running` and `Ready`.

## Pre-deploy DDL — sandbox-reconcile schema restructure

Run this DDL ONCE against the live database before you roll the api to the
sandbox-reconcile release. Fresh installs skip it — the boot migration creates
these tables. It matters only for a live cluster that predates the restructure,
where the old `prebuild_configs`/`prebuilds` tables must give way to
`image_sources`/`bakes`. Apply it with `psql "$DATABASE_URL" -f -`, or paste it
into a `psql` session, while the old api is still running; then roll the api.

```sql
DROP TABLE IF EXISTS "prebuilds";
DROP TABLE IF EXISTS "prebuild_configs";

CREATE TABLE "image_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL CHECK (kind IN ('external','base','repo')),
	"parent_id" text REFERENCES image_sources(id),
	"name" text NOT NULL,
	"external_ref" text,
	"pull_secret_name" text,
	"setup_commands" jsonb,
	"repo_host" text,
	"repo_full_name" text,
	"clone_url" text,
	"schedule" text NOT NULL DEFAULT 'nightly' CHECK (schedule IN ('nightly','off')),
	"enabled" boolean NOT NULL DEFAULT TRUE,
	"last_bound_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
CREATE UNIQUE INDEX "image_sources_org_repo" ON "image_sources" ("org_id","repo_host","repo_full_name") WHERE kind = 'repo';
CREATE UNIQUE INDEX "image_sources_org_base" ON "image_sources" ("org_id") WHERE kind = 'base';

CREATE TABLE "bakes" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL REFERENCES image_sources(id) ON DELETE CASCADE,
	"identity_hash" text NOT NULL,
	"commit_sha" text,
	"image_ref" text NOT NULL,
	"status" text NOT NULL CHECK (status IN ('queued','building','pushed','failed')),
	"builder_backend" text,
	"recipe" jsonb,
	"error" text,
	"log_tail" text,
	"started_at" bigint,
	"finished_at" bigint,
	"created_at" bigint NOT NULL
);
CREATE INDEX "bakes_source_status_created" ON "bakes" ("source_id","status","created_at");
```

## Pre-deploy DDL — cost attribution

Run this DDL ONCE against the live database before you roll the api to the
cost-attribution release. Fresh installs skip it — the boot migration creates
the view and the index. It matters only for a live cluster whose migration
tracker already recorded `0000_app.sql` and `0000_engine.sql`, because an
in-place edit to a recorded pre-1.0 migration never re-applies. Apply it with
`psql "$DATABASE_URL" -f -` while the old api is still running; then roll the
api. `CONCURRENTLY` keeps the index build off the write path. The view body
below is a copy of the one in `packages/api/migrations/pg/0000_app.sql`. If you
edit the view, edit both.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "engine_entries_usage_window"
	ON "engine_entries" ("created_at") WHERE "usage" IS NOT NULL;

CREATE OR REPLACE VIEW "cost_entries" AS
SELECT
	e."id"                                                     AS "entry_id",
	e."session_id"                                             AS "session_id",
	e."created_at"                                             AS "created_at",
	e."model"                                                  AS "model",
	COALESCE(s."org_id", d."org_id")                           AS "org_id",
	CASE
		WHEN s."id" IS NOT NULL THEN s."user_id"
		WHEN r."owner_type" = 'user' THEN NULLIF(r."owner_id", '')
	END                                                        AS "user_id",
	COALESCE(s."owner_type", r."owner_type")                   AS "owner_type",
	NULLIF(COALESCE(s."owner_id", r."owner_id"), '')           AS "owner_id",
	r."workflow_id"                                            AS "workflow_id",
	r."id"                                                     AS "workflow_run_id",
	COALESCE((e."usage"::jsonb->>'input')::bigint, 0)          AS "input_tokens",
	COALESCE((e."usage"::jsonb->>'output')::bigint, 0)         AS "output_tokens",
	COALESCE((e."usage"::jsonb->>'cacheRead')::bigint, 0)      AS "cache_read_tokens",
	COALESCE((e."usage"::jsonb->>'cacheWrite')::bigint, 0)     AS "cache_write_tokens",
	COALESCE((e."usage"::jsonb->>'total')::bigint, 0)          AS "total_tokens",
	(e."cost"::jsonb->>'total')::float8                        AS "cost_total",
	((e."cost"::jsonb->>'total') IS NOT NULL)                  AS "priced"
FROM "engine_entries" e
LEFT JOIN "agent_sessions" s
	ON s."id" = e."session_id"
LEFT JOIN "workflow_runs" r
	ON e."session_id" LIKE 'wf:%'
	AND r."id" = split_part(e."session_id", ':', 2)
LEFT JOIN "workflow_definitions" d
	ON d."id" = r."workflow_id"
WHERE e."usage" IS NOT NULL
	AND COALESCE(s."org_id", d."org_id") IS NOT NULL;
```

## Reach the api

Port-forward is the simplest option, and the one CI and scripted
verification should use:

```sh
kubectl --context rancher-desktop -n valet port-forward svc/valet-api 8080:80
curl -s http://localhost:8080/api/health
```

Or use the ingress at `https://valet.localdev`. Traefik terminates TLS
there with a self-signed cert. `BETTER_AUTH_URL` must stay `https://`
because better-auth marks session cookies `Secure`, so plain-http login
silently fails. To use the ingress:

1. Add `127.0.0.1 valet.localdev` to `/etc/hosts`. Alternatively, switch
   `ingress.host` in values to a `*.sslip.io` name, which resolves without
   a hosts-file edit. Traefik routes by `Host` header either way.
2. Open `https://valet.localdev` and accept the self-signed certificate
   warning once per browser profile.

Real auth is on in the cluster — there is no dev bypass. The first sign-up
becomes the org admin.

## Observability (Grafana + OpenTelemetry)

The chart bundles a local observability stack by default
(`observability.enabled`). One `grafana/otel-lgtm` container runs the OTel
collector, Tempo, Loki, Mimir, and Grafana. The api exports engine traces
and metrics to it over OTLP: agent turns with token usage and USD cost,
per-round LLM generations, submission settlements (including settle-patch
capture records), engine errors, and sandbox lifecycle transitions. See
`packages/api/src/observability/otel.ts` and
`docs/specs/2026-07-28-observability-otel-design.md`.

Grafana is a NodePort, so the local cluster needs no port-forward:

```sh
open http://localhost:30300        # anonymous admin, no login
```

Open Dashboards → **Valet — Agent Observability** (provisioned from
`deploy/chart/valet/dashboards/valet.json`). It shows turns, spend,
tokens, settlement outcomes, queue wait, tool/sandbox/store/HTTP
latencies, and a table of recent `submission.run` traces. For raw traces,
open Explore → Tempo and query `{name="submission.run"}` after you run a
session. To verify from the shell:

```sh
curl -s "http://localhost:30300/api/datasources/proxy/uid/tempo/api/search?tags=service.name%3Dvalet-api"
```

Disable the stack with `--set observability.enabled=false`, or export to
an external collector via `observability.otlpEndpoint`. The api is
env-gated on `OTEL_EXPORTER_OTLP_ENDPOINT` — when the variable is unset,
no SDK starts at all.

## Tail logs

```sh
make k8s-logs
```

## Tear down

```sh
make k8s-down
```

This runs `helm uninstall` on the release. **PVCs survive by Kubernetes
design** — StatefulSet `volumeClaimTemplates` PVCs are not owned by the
Helm release. Any `Sandbox` CR from an in-flight session also survives.
The provider's `release()` path intentionally leaves CRs adopted, not
deleted, across ordinary re-provisioning. Only session deletion truly
terminates one. For a full reset:

```sh
kubectl --context rancher-desktop -n valet delete pvc -l app.kubernetes.io/instance=valet
kubectl --context rancher-desktop delete ns valet --ignore-not-found
kubectl --context rancher-desktop -n valet-sandboxes delete sandboxes --all --ignore-not-found
kubectl --context rancher-desktop delete ns valet-sandboxes --ignore-not-found
```

`make k8s-sandbox-uninstall` removes the agent-sandbox controller itself.
That is not part of an ordinary reset — the controller is shared
infrastructure that other experiments on the cluster may depend on.

## Cache management

Two environment variables control how much local disk the prebuild system uses.

**`VALET_PREBUILD_BUILD_CACHE_GB`** (default `10`)

This is the moby build-cache budget in GiB. The api prunes the build cache to this ceiling after each docker bake and after `make k8s-build*`. Pruning keeps Rancher Desktop from accumulating unbounded BuildKit cache between bakes.

**`VALET_PREBUILD_CACHE_BUDGET_GB`** (default `20`)

This is the global baked-image size ceiling in GiB. When total bake size exceeds this ceiling, the api runs two passes. The per-source retention pass keeps the 2 newest pushed bakes per source. The global size ceiling pass protects only the newest pushed bake per source plus any bake a live session is using — under disk pressure it can trim a source to its single newest bake.

Registry GC runs nightly as a k8s CronJob. It calls the registry with `--delete-untagged` and reclaims blobs for bakes that the api has already evicted.

**Dev-only note (Rancher Desktop):** k3s may evict the local `valet-api:dev` image under DiskPressure. A bounded build cache prevents pressure from accumulating. If the image is evicted anyway, run `make k8s-build-fast` and then roll the api deployment to restore it.

## Troubleshooting

- **api pod stuck in `Init:0/1`**: the `wait-for-postgres` initContainer
  is blocking. Check the postgres StatefulSet pod's status with
  `kubectl --context rancher-desktop -n valet get pods`. If the postgres
  pod is crash-looping, read its logs with `kubectl ... logs <postgres-pod>`.
- **`403` on Sandbox CR creation**: the RBAC Role (`rbac.yaml`) is missing
  a verb. Cross-check it against `packages/sandbox-kubernetes`'s actual
  API calls.
- **Session survives `kubectl delete pod` but the workspace looks empty**:
  the CR must NOT have been destroyed (only `release()`d). Confirm that
  `kubectl --context rancher-desktop -n valet-sandboxes get sandboxes`
  still shows the CR. If the CR is gone, the attachment layer took the
  terminal `destroy()` path instead of `release()`. That is a real
  regression, not expected behavior.
