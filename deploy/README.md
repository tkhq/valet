# Local Kubernetes reference environment (Rancher Desktop)

This is the top-level entry point for running Valet v2 on Kubernetes
locally. See `docs/specs/2026-07-15-kubernetes-deployment-design.md` for the
full design; this doc is the practical runbook.

**Context safety (binding):** the developer machine's default kubectl
context may point at a PRODUCTION cluster (verified on this machine — it's a
GKE prod cluster). Every command below, and every `make k8s-*` target, pins
`--context rancher-desktop` (or `--kube-context rancher-desktop` for helm)
explicitly. Never run a bare `kubectl`/`helm` command against this repo's
k8s workflow — always go through the `make` targets, or add the context
flag yourself.

## Prerequisites

- Rancher Desktop with Kubernetes enabled, **moby (dockerd) mode** — not
  containerd mode (decision 2 in the design spec: this repo's k8s images are
  built with plain `docker build`, which requires the docker socket that
  moby mode provides; it also keeps `sandbox-docker`/`make test-pg` working
  unmodified). Confirm with `kubectl config get-contexts rancher-desktop`.
- `helm` v3+, `kubectl`, Docker CLI.
- `ANTHROPIC_API_KEY` in your shell environment or repo-root `.env` (never
  committed).

## One-time: install agent-sandbox

Valet's k8s sandbox provider drives session lifecycle through the
[agent-sandbox](https://agent-sandbox.sigs.k8s.io/) `Sandbox` CRD. There's
no published Helm chart for it, so we vendor the release manifest and apply
it directly, idempotently:

```sh
make k8s-sandbox-install
```

Safe to re-run any time (server-side apply diff is a no-op if already
installed). See `deploy/agent-sandbox/README.md` for what it installs.

## Build the images

```sh
make k8s-build
```

Builds `valet-api:dev` (api + bundled `packages/web` static build) and
`valet-sandbox:dev` (the session sandbox image) with plain `docker build`.
Because Rancher Desktop's moby mode backs k3s with cri-dockerd, these
images are immediately visible to k3s pods — no registry, no `docker push`,
no `imagePullPolicy` surprises (the chart pins concrete tags with
`IfNotPresent`). This step is slow the first time (~15-20 min, mostly
`pnpm install` + monorepo build); subsequent builds are faster via Docker's
layer cache.

If you've switched Rancher Desktop to containerd mode instead, `make
k8s-build` prints the `nerdctl --namespace k8s.io build` equivalent — not
the default, documented as a variant only.

## Deploy

```sh
make k8s-up
```

This installs agent-sandbox (idempotent, see above) and then runs `helm
upgrade --install` with `--kube-context rancher-desktop`, into the `valet`
namespace (override with `K8S_NAMESPACE=`). `ANTHROPIC_API_KEY` is read from
your environment or `.env` and passed via `--set` — it is never written to
disk or committed. `BETTER_AUTH_SECRET`, `VALET_ENCRYPTION_KEY`, and the
bundled Postgres password are chart-generated-and-retained on first install
(see `deploy/chart/valet/README.md`) — you don't need to supply them, and
they survive subsequent `helm upgrade` runs so sessions/cookies/the sandbox
JWT master don't get invalidated on redeploy.

The api Deployment has an initContainer that blocks on the bundled Postgres
StatefulSet's readiness before the api boots (it runs migrations at boot),
so `helm upgrade --install --wait` only returns once the api pod is
actually `Running`+`Ready`.

## Reach the api

Two options; port-forward is simplest and what CI/scripted verification
should use:

```sh
kubectl --context rancher-desktop -n valet port-forward svc/valet-api 8080:80
curl -s http://localhost:8080/api/health
```

Or use the ingress at `https://valet.localdev` (Traefik, TLS terminated
there with a self-signed cert — `BETTER_AUTH_URL` is `https://` because
better-auth marks session cookies `Secure`, so plain-http login silently
fails):

- Add `127.0.0.1 valet.localdev` to `/etc/hosts` (or switch
  `ingress.host` in values to a `*.sslip.io` name, which resolves without a
  hosts-file edit — Traefik still routes by `Host` header either way).
- Open `https://valet.localdev` and accept the self-signed certificate
  warning once per browser profile.

First sign-up becomes the org admin (real auth is on in the cluster — no
dev bypass).

## Observability (Grafana + OpenTelemetry)

The chart bundles a local observability stack by default
(`observability.enabled`, `grafana/otel-lgtm`: OTel collector + Tempo +
Loki + Mimir + Grafana in one container, ephemeral storage). The api
exports engine traces to it over OTLP — agent turns with token usage and
USD cost, submission settlements (including settle-patch capture records),
engine errors, and sandbox lifecycle transitions. See
`packages/api/src/observability/otel.ts` and
`docs/specs/2026-07-28-observability-otel-design.md`.

Grafana is a NodePort — no port-forward needed on the local cluster:

```sh
open http://localhost:30300        # anonymous admin, no login
```

Explore → Tempo → search for span name `agent.turn` (service `valet-api`)
after running a session. To verify from the shell:

```sh
curl -s "http://localhost:30300/api/datasources/proxy/uid/tempo/api/search?tags=service.name%3Dvalet-api"
```

Disable with `--set observability.enabled=false`, or export to an external
collector via `observability.otlpEndpoint` (the api is env-gated on
`OTEL_EXPORTER_OTLP_ENDPOINT` — unset means no SDK is started at all).

## Tail logs

```sh
make k8s-logs
```

## Tear down

```sh
make k8s-down
```

`helm uninstall`s the release. **PVCs survive by Kubernetes design**
(StatefulSet `volumeClaimTemplates` PVCs aren't owned by the Helm release) —
so does any `Sandbox` CR left standing from an in-flight session (the
provider's `release()` no-op path intentionally leaves CRs adopted, not
deleted, across ordinary re-provisioning; only session deletion truly
terminates one). For a full reset:

```sh
kubectl --context rancher-desktop -n valet delete pvc -l app.kubernetes.io/instance=valet
kubectl --context rancher-desktop delete ns valet --ignore-not-found
kubectl --context rancher-desktop -n valet-sandboxes delete sandboxes --all --ignore-not-found
kubectl --context rancher-desktop delete ns valet-sandboxes --ignore-not-found
```

`make k8s-sandbox-uninstall` removes the agent-sandbox controller itself —
not part of an ordinary reset, since it's shared infrastructure other
experiments on the cluster may also depend on.

## Troubleshooting

- **api pod stuck in `Init:0/1`**: the `wait-for-postgres` initContainer is
  blocking — check `kubectl --context rancher-desktop -n valet get pods` for
  the postgres StatefulSet pod's status; `kubectl ... logs
  <postgres-pod>` if it's crash-looping.
- **`403` on Sandbox CR creation**: the RBAC Role (`rbac.yaml`) is missing a
  verb — cross-check against `packages/sandbox-kubernetes`'s actual API
  calls.
- **Session survives `kubectl delete pod` but the workspace looks empty**:
  the CR must NOT have been destroyed (only `release()`d) — check
  `kubectl --context rancher-desktop -n valet-sandboxes get sandboxes` still
  shows the CR; if it's gone, the attachment layer took the terminal
  `destroy()` path instead of `release()` and that's a real regression, not
  expected behavior.
