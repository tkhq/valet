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

On first boot (and idempotently on subsequent boots), Valet seeds three `image_sources` rows per org:

| kind | name | profile | FROM |
|---|---|---|---|
| `external` | `stock-full` | — | `VALET_FULL_BASE_IMAGE` (default `ghcr.io/tkhq/valet-sandbox:latest`) |
| `base` | `default-headless` | `headless` | `VALET_HEADLESS_BASE_IMAGE` (default `node:22-bookworm-slim`) |
| `base` | `default-full` | `full` | parent = `stock-full` external row |

The headless base's setup commands install the agent tooling layer. The full base has empty setup commands — the full image ships everything.

### Customising base images

To pin a specific CI-published full image for reproducible deploys:

```yaml
sandbox:
  fullBaseImage: ghcr.io/tkhq/valet-sandbox:sha-abc1234
  headlessBaseImage: node:22-bookworm-slim  # or your own image
```

To layer additional tooling onto the auto-seeded headless base (e.g. python3), patch its `setupCommands` in place — do **not** POST a new `kind='base'` row with the same profile, as the unique index on `(org_id, profile) WHERE kind='base'` would 409:

```sh
# 1. Find the auto-seeded headless base's id
GET /api/org/sources
# → look for the row with name="default-headless" and profile="headless"

# 2. Append your setup commands (supply the full desired list — this replaces, not appends)
PATCH /api/org/sources/<headless-base-id>
{
  "setupCommands": [
    "apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates coreutils curl procps bash openssh-client && rm -rf /var/lib/apt/lists/*",
    "apt-get install -y python3"
  ]
}
```

To re-parent a repo source at a different base, use:

```sh
PATCH /api/org/sources/<repo-source-id>
{ "parentId": "<base-id>" }
```
