# valet Helm chart

Deploys the api (which also serves the built web app), an optional bundled
Postgres StatefulSet, the bundled observability stack, and the
namespace/RBAC the api needs to drive session sandboxes as `Sandbox`
custom resources.

## Install ordering (required)

This chart does **not** bundle the [agent-sandbox](https://agent-sandbox.sigs.k8s.io/)
CRDs or controller. Upstream publishes no Helm chart or repo to depend on.
Helm's `crds/` directory semantics (install once, never upgrade) also make
version-pinning it inside this chart impractical. Install it separately,
first:

```sh
# 1. Install the vendored, version-pinned agent-sandbox release manifest
#    (CRDs + controller Deployment + admission webhook).
make k8s-sandbox-install

# 2. Build the local images (valet-api:dev, valet-sandbox:dev).
make k8s-build

# 3. Install this chart.
helm upgrade --install valet deploy/chart/valet \
  --kube-context rancher-desktop \
  --namespace valet --create-namespace
```

If you skip step 1, the api's `Sandbox` create calls fail at
session-provision time, not at chart-install time. The RBAC is scoped for
the CRs, but the CRD itself will not exist, and Helm does not validate CRD
existence for API groups it does not own.

## What's in the chart

- **api Deployment**, Service, and Ingress (Traefik, TLS terminated at the
  ingress). `replicas` is pinned to 1 — the engine is a stateful
  in-process singleton, so do not scale it.
- **Bundled Postgres** (StatefulSet + Service + Secret). Gated on
  `postgres.bundled` (default `true`), and disabled automatically when
  `externalDatabase.url` is set.
- **Observability stack** (`observability.enabled`, default `true`): one
  `grafana/otel-lgtm` Deployment (OTel collector, Tempo, Loki, Mimir,
  Grafana), a ClusterIP Service for OTLP ingest, a NodePort Service for
  Grafana (30300), a PVC for telemetry storage, and the provisioned
  "Valet — Agent Observability" dashboard.
- **Sandbox namespace + RBAC**: a `Namespace`, a namespaced `Role`, and a
  `RoleBinding` to the api's `ServiceAccount`. The Role grants sandbox
  CRs, pods, pods/exec, and pods/log. It grants no cluster-scoped
  permissions and no PVC verbs — the agent-sandbox controller owns PVC
  lifecycle.
- **App Secret** with a `lookup`-based retain guard. `BETTER_AUTH_SECRET`
  and `VALET_ENCRYPTION_KEY` are generated once when values do not supply
  them, then reused on every later `helm upgrade`. Regenerating them would
  invalidate every session cookie and rotate the sandbox JWT signing
  master, because `VALET_SANDBOX_JWT_MASTER` falls back to
  `BETTER_AUTH_SECRET` when unset.
- **`helm test`**: a Pod hook that curls the api Service's `/api/health`.

## Notes

- **PVCs survive `helm uninstall`** by Kubernetes design — StatefulSet
  `volumeClaimTemplates` PVCs are not owned by the Helm release. For a
  true reset, delete them explicitly:
  ```sh
  kubectl --context rancher-desktop -n valet delete pvc -l app.kubernetes.io/instance=valet
  ```
- **A rotated key rolls the api pod.** The api reads its config and
  secrets through `envFrom`/`secretKeyRef`, and Kubernetes injects those
  once, at pod start. The api pod template therefore carries
  `checksum/secret` and `checksum/config` annotations, so `helm upgrade`
  replaces the pod when the material behind them changes. `checksum/secret`
  digests the supplied values — `api.secrets.*`, `externalDatabase.url`,
  and `postgres.*` — rather than the rendered Secret. The retained values
  are generated fresh on any render that cannot `lookup` them, so a digest
  over the rendered Secret would change when nothing changed. Secrets and
  ConfigMaps referenced through `api.extraEnvFrom` are outside the chart
  and outside both digests; rotate one of those with
  `kubectl rollout restart deployment/<release>-api`.
- No secrets are committed to `values.yaml` — only empty placeholders.
  Supply real values via `--set`, a gitignored local `values-local.yaml`,
  or `--set-file`. Or leave them blank to let the chart generate and
  retain `BETTER_AUTH_SECRET`, `VALET_ENCRYPTION_KEY`, and the bundled
  Postgres password.
