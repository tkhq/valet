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
- **Sandbox namespace + RBAC**: an optional `Namespace`, a namespaced
  `Role`, and a `RoleBinding` to the api's `ServiceAccount`. The Role
  grants only the operations that the api calls. These include Sandbox CR
  lifecycle, pod read/delete and exec, pod log reads, PVC growth, build Jobs,
  build ConfigMaps, and credential Secrets. It grants no cluster-scoped
  permissions. The agent-sandbox controller owns pod and PVC creation.
- **App Secret** with a `lookup`-based retain guard. `BETTER_AUTH_SECRET`
  and `VALET_ENCRYPTION_KEY` are generated once when values do not supply
  them, then reused on every later `helm upgrade`. Regenerating them would
  invalidate every session cookie and rotate the sandbox JWT signing
  master, because `VALET_SANDBOX_JWT_MASTER` falls back to
  `BETTER_AUTH_SECRET` when unset.
- **`helm test`**: a Pod hook that curls the api Service's `/api/health`.

## Resource ownership

The default `sandbox.createNamespace: true` keeps local install behavior.
The chart creates `sandbox.namespace` before it creates namespaced resources.
The Namespace has `helm.sh/resource-policy: keep`. Helm does not delete it
when an upgrade omits it or an operator uninstalls the release.

Set `sandbox.createNamespace: false` when the platform owns the Namespace.
The platform must create the Namespace before helm-controller installs the
chart. Helm omits only the Namespace manifest in this mode.

### Move an existing Namespace to the platform

Do not set `sandbox.createNamespace=false` before this procedure. The old
release manifest must contain the keep annotation before Helm omits the
Namespace.

1. Set the release variables.

   ```sh
   release=valet
   release_namespace=valet
   sandbox_namespace=valet-sandboxes
   chart_ref=oci://ghcr.io/tkhq/charts/valet
   chart_version=0.10.12
   ```

2. Add the keep annotation to the live Namespace.

   ```sh
   kubectl annotate namespace "$sandbox_namespace" \
     helm.sh/resource-policy=keep --overwrite
   ```

3. Verify the live annotation.

   ```sh
   test "$(kubectl get namespace "$sandbox_namespace" \
     -o jsonpath='{.metadata.annotations.helm\.sh/resource-policy}')" = keep
   ```

4. Upgrade once while Helm still renders the Namespace.

   ```sh
   helm upgrade "$release" "$chart_ref" \
     --version "$chart_version" \
     --namespace "$release_namespace" \
     --reuse-values \
     --set sandbox.createNamespace=true
   ```

5. Verify that Helm stored the annotated Namespace manifest.

   ```sh
   helm get manifest "$release" --namespace "$release_namespace" |
     kubectl create --dry-run=client -f - -o json |
     jq -e --arg namespace "$sandbox_namespace" '
       (.items // [.])[] |
       select(.apiVersion == "v1" and .kind == "Namespace") |
       select(.metadata.name == $namespace) |
       .metadata.annotations["helm.sh/resource-policy"] == "keep"
     '
   ```

6. Apply the platform change that adopts the live Namespace.

7. Verify that the platform owns the Namespace before the next Helm upgrade.

8. Set `sandbox.createNamespace=false` in the Helm values.

Helm owns the api resources, sandbox Role, and sandbox RoleBinding. The Role
uses only namespaced permissions. The client-node exec client opens an HTTP
GET WebSocket upgrade on `pods/exec`. The Role grants `get` for that
subresource. It does not grant the SPDY `create` path.

A restricted Helm reconciler does not need Namespace access or RBAC
`escalate` and `bind`. Kubernetes requires the reconciler to hold each
permission that it writes into a Role. The Sandbox CR verbs are the
exceptional grant because the built-in namespaced `admin` role does not
include that custom API group. Grant those exact verbs to the reconciler
before installation. Do not grant `escalate` or `bind`.

`api.instanceConfig` is chart content. When it is set, Helm owns the instance
ConfigMap and its checksum rolls the api Deployment. Use `api.extraEnvFrom`
for ConfigMaps and Secrets that the platform owns. An ExternalSecret can own a
target Secret that this list references. The chart does not render or copy
those external values. Their updates do not change a pod-template checksum,
so restart the api Deployment after an external value changes.

### Return Namespace ownership to Helm

Do not delete or recreate the Namespace. Stop platform reconciliation for the
Namespace before this procedure.

1. Set the release variables from the migration procedure.

2. Remove or disable the platform resource that owns the Namespace.

3. Add the Helm ownership metadata to the live Namespace.

   ```sh
   kubectl label namespace "$sandbox_namespace" \
     app.kubernetes.io/managed-by=Helm --overwrite
   kubectl annotate namespace "$sandbox_namespace" \
     meta.helm.sh/release-name="$release" \
     meta.helm.sh/release-namespace="$release_namespace" \
     helm.sh/resource-policy=keep \
     --overwrite
   ```

4. Verify the Helm ownership metadata.

   ```sh
   test "$(kubectl get namespace "$sandbox_namespace" \
     -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')" = Helm
   test "$(kubectl get namespace "$sandbox_namespace" \
     -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}')" = "$release"
   test "$(kubectl get namespace "$sandbox_namespace" \
     -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-namespace}')" = "$release_namespace"
   test "$(kubectl get namespace "$sandbox_namespace" \
     -o jsonpath='{.metadata.annotations.helm\.sh/resource-policy}')" = keep
   ```

5. Upgrade with Namespace creation enabled.

   ```sh
   helm upgrade "$release" "$chart_ref" \
     --version "$chart_version" \
     --namespace "$release_namespace" \
     --reuse-values \
     --set sandbox.createNamespace=true
   ```

If a Helm rollback restores a revision that renders the Namespace, complete
steps 1 through 4 first. Then run this command with the target revision:

```sh
helm rollback "$release" <revision> --namespace "$release_namespace"
```

## Registry filesystem health

The bundled registry includes a read-only Python probe. Each `GET /health` request reads the registry volume with `statvfs`.
The separate ClusterIP service exposes port 5001 inside the cluster. The registry's NodePort only exposes port 5000.
The chart sets `VALET_REGISTRY_HEALTH_URL` for the API automatically.
Filesystem health does not control pod readiness. A probe read failure does not remove the registry's serving endpoints.

The response contains integer byte counts: `capacityBytes`, `availableBytes`, and `usedBytes`.
Available bytes exclude filesystem blocks reserved for root. Used bytes measure allocated filesystem blocks, including data outside registry manifests.
The probe does not scan repositories or report logical image sizes. If the filesystem read fails, it returns HTTP 503 without capacity data.

`registry.minFreeGb` defaults to 5. `registry.minFreePercent` defaults to 10.
The absolute reserve must be zero or greater. The percentage reserve must be above 0 and below 100.
For small registry volumes, lower `registry.minFreeGb` to leave usable build capacity. The percentage reserve remains active when the absolute reserve is zero.
The API blocks new bakes below the greater reserve. These values apply to bundled and external probes.
The reserve does not allocate space for concurrent uploads. Operators must size it for concurrent builds and other registry writers.
Manifest deletion does not release disk blocks until registry garbage collection runs.

For an external registry, set `externalRegistry.healthUrl` to an API-reachable endpoint with the same JSON contract.
An empty URL reports unknown physical capacity. An unavailable configured endpoint blocks new bakes.
Set `registry.health.image.repository` and `registry.health.image.tag` to override the bundled Python image.

Run the chart checks with `bash deploy/chart/valet/test/golden.sh`.
Run the HTTP probe tests with `python3 deploy/chart/valet/test/registry_health_test.py`.
The probe tests require permission to bind an ephemeral localhost port.

## Pre-existing GitHub App (env fallback)

By default, an org admin creates the deployment's GitHub App in the web UI
(Organization → GitHub, the manifest flow). That flow always creates a NEW
App. To use an App that already exists, set the `GITHUB_APP_*` env
fallback instead:

```sh
helm upgrade --install valet deploy/chart/valet \
  --set api.githubApp.appId="123456" \
  --set api.githubApp.slug="my-valet-app" \
  --set api.githubApp.clientId="Iv1.abc123" \
  --set api.secrets.githubAppClientSecret="..." \
  --set api.secrets.githubAppWebhookSecret="..." \
  --set-file api.secrets.githubAppPrivateKey=my-valet-app.private-key.pem
```

- `githubAppPrivateKey` accepts the PEM raw or base64-encoded. Use
  `--set-file` for the raw PEM, or base64-encode it for delivery through a
  secrets manager (one line, no newline escaping).
- Set all values, or none. The api fails loudly on a partial set and names
  the missing variables.
- `githubAppWebhookSecret` is optional. Leave it blank for an App without
  a webhook.
- Nothing is written to the database — the env is the config. To rotate a
  value, change it and roll the api pod. An App created later through the
  manifest flow shadows the fallback for that org.
- Point the App's webhook URL at `{public URL}/webhooks/github-app` and
  its callback URL at `{public URL}/api/me/github/callback`. If the
  private key is lost, generate a new one from the App's GitHub settings
  page — keys are download-once.
- For External Secrets Operator (or similar), leave these values blank and
  deliver the same `GITHUB_APP_*` env vars through `api.extraEnvFrom`.

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

## Sessions and profiles

Every Valet session runs under one of two profiles:

- **`headless`** (default) — agent-only sandbox. Starts on a lean `node:22-bookworm-slim` base augmented with git, ripgrep, gh, curl, and openssh-client. Used for all AI-agent sessions and repo-bound workspaces.
- **`full`** (opt-in) — interactive developer sandbox. FROMs the CI-published `ghcr.io/tkhq/valet-sandbox` image, which ships the compiled `@valet/sandbox-gateway` bundle, ttyd, and code-server in addition to all headless tooling. Required for browser-tab Terminal and VS Code sessions.

### Auto-seeded base sources

On first boot (and idempotently on subsequent boots), Valet seeds two `image_sources` rows per org:

| kind | name | profile | FROM |
|---|---|---|---|
| `external` | `stock-full` | — | `VALET_FULL_BASE_IMAGE` (default `ghcr.io/tkhq/valet-sandbox:latest`) |
| `base` | `default-full` | `full` | parent = `stock-full` external row |

There is ONE image lineage: every sandbox and every repo bake chains on the full base. The `profile` session flag only decides whether the interactive services (gateway, ttyd, code-server) start. Re-seed follows `VALET_FULL_BASE_IMAGE` pin changes, and a legacy `default-headless` base row from older deploys is disabled automatically.

### Customising base images

To pin a specific CI-published image for reproducible deploys:

```yaml
sandbox:
  fullBaseImage: ghcr.io/tkhq/valet-sandbox:sha-abc1234
```

To layer additional tooling onto the auto-seeded base (e.g. python3), patch the `default-full` base's `setupCommands` in place — do **not** POST a new `kind='base'` row with the same profile, as the unique index on `(org_id, profile) WHERE kind='base'` would 409:

```sh
# 1. Find the auto-seeded base's id
GET /api/org/sources
# → look for the row with name="default-full" and profile="full"

# 2. Set your setup commands (supply the full desired list — this replaces, not appends)
PATCH /api/org/sources/<full-base-id>
{
  "setupCommands": ["apt-get update && apt-get install -y python3"]
}
```

To re-parent a repo source at a different base, use:

```sh
PATCH /api/org/sources/<repo-source-id>
{ "parentId": "<base-id>" }
```
