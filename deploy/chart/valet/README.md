# valet Helm chart

Deploys the api (which also serves the built web app), an optional bundled
Postgres StatefulSet, and the namespace/RBAC the api needs to drive session
sandboxes as `Sandbox` custom resources.

## Install ordering (required)

This chart does **not** bundle the [agent-sandbox](https://agent-sandbox.sigs.k8s.io/)
CRDs or controller — there is no published Helm chart/repo for it upstream
to depend on, and Helm's `crds/` directory semantics (install-once, never
upgraded) make version-pinning it inside this chart impractical. Install it
separately, first:

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

If step 1 is skipped, the api's `Sandbox` custom resource creates (RBAC is
scoped for them, but the CRD itself won't exist) fail at session-provision
time — not at chart-install time, since Helm doesn't validate CRD existence
for API groups it doesn't own.

## What's in the chart

- **api Deployment** (`replicas: 1` — the engine is a stateful in-process
  singleton, do not scale it), Service, Ingress (Traefik, TLS terminated at
  the ingress).
- **Bundled Postgres** (StatefulSet + Service + Secret), gated on
  `postgres.bundled` (default `true`) and disabled automatically when
  `externalDatabase.url` is set.
- **Sandbox namespace + RBAC**: a `Namespace`, a namespaced `Role` (sandbox
  CRs + pods + pods/exec + pods/log — no cluster-scoped permissions, no PVC
  verbs; the agent-sandbox controller owns PVC lifecycle), and a
  `RoleBinding` to the api's `ServiceAccount`.
- **App Secret** with a `lookup`-based retain guard: `BETTER_AUTH_SECRET`
  and `VALET_ENCRYPTION_KEY` are generated once (if not supplied via
  values) and then reused on every subsequent `helm upgrade` — regenerating
  them would invalidate every session cookie and rotate the sandbox JWT
  signing master, since `VALET_SANDBOX_JWT_MASTER` falls back to
  `BETTER_AUTH_SECRET` when unset.
- **`helm test`**: a Pod hook that curls the api Service's `/api/health`.

## Notes

- **PVCs survive `helm uninstall`** by Kubernetes design (StatefulSet
  `volumeClaimTemplates` PVCs are not owned by the Helm release). For a true
  reset, delete them explicitly:
  ```sh
  kubectl -n valet delete pvc -l app.kubernetes.io/instance=valet
  ```
- No secrets are committed to `values.yaml` — only empty placeholders.
  Supply real values via `--set` / a local `values-local.yaml` (gitignored)
  / `--set-file`, or leave them blank to let the chart generate-and-retain
  `BETTER_AUTH_SECRET` / `VALET_ENCRYPTION_KEY` / the bundled Postgres
  password.
