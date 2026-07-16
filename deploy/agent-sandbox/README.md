# agent-sandbox (vendored)

Valet's `packages/sandbox-kubernetes` provider drives session lifecycle through
the [kubernetes-sigs/agent-sandbox](https://agent-sandbox.sigs.k8s.io/)
`Sandbox` CRD (API group `agents.x-k8s.io`, we pin `v1beta1`).

There is **no published Helm chart or repo** for this project — upstream ships
a single raw `manifest.yaml` release asset containing the CRD(s), the
controller `Deployment`, RBAC, and an admission webhook `Service` (with a
controller-managed cert `Secret`, no cert-manager dependency). Because Helm's
`crds/` directory has install-once-never-upgrade semantics, pinning this in
Helm values doesn't work — instead we vendor the manifest verbatim per
version under `deploy/agent-sandbox/{VERSION}/` and `kubectl apply` it
directly.

## Layout

```
deploy/agent-sandbox/
  v0.5.1/
    manifest.yaml     # vendored verbatim from the GitHub release asset
    SHA256SUMS         # sha256 of manifest.yaml, for provenance verification
  README.md            # this file
```

## Current pinned version: v0.5.1

Full provenance (URL, tag, date, hash) and the version-bump procedure live
in [`v0.5.1/README.md`](v0.5.1/README.md) alongside the vendored manifest
itself.

### What's in `manifest.yaml`

- `Namespace agent-sandbox-system`
- `ServiceAccount`/`ClusterRole`/`ClusterRoleBinding`/`Role`/`RoleBinding` for the controller
- `Deployment agent-sandbox-controller` (image `registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.1`), exposing metrics (8080), healthz (8081), and webhook (9443) ports
- `Service agent-sandbox-controller` (metrics) and `Service agent-sandbox-webhook-service` (webhook, port 443 -> 9443)
- `CustomResourceDefinition sandboxes.agents.x-k8s.io` with two served versions, `v1beta1` and `v1alpha1` (storage version is `v1beta1`); the CRD's conversion `strategy: Webhook` points at `agent-sandbox-webhook-service`
- The controller's `Role` grants it `secrets` create/get/patch/update scoped to the `agent-sandbox-webhook-certs` secret name — the controller generates and rotates its own webhook TLS cert on boot. No cert-manager or other external dependency is required.

### `extensions.yaml` was NOT vendored

The same release also publishes `extensions.yaml`, which adds three more
CRDs — `SandboxClaim`, `SandboxTemplate`, `SandboxWarmPool` — for warm-pool
and templated-claim workflows. The Valet provider only drives the base
`Sandbox` CRD today; `SandboxTemplate`/`SandboxClaim`/`SandboxWarmPool` and
hibernation/resume are recorded as fast-follows in the design spec (decision
5, "Deferred / explicitly out of scope for Phase 1"), so `extensions.yaml`
is not needed and was deliberately left out of the vendored tree. Revisit
this decision if/when the provider adopts warm pools.

## Update procedure (version bump)

See [`v0.5.1/README.md`](v0.5.1/README.md)'s "Update procedure" section —
kept next to the manifest it describes so it travels with the version it's
written against.

## Cluster context safety

**Every command below pins `--context rancher-desktop` explicitly.** The
developer machine's default kubectl context may point at a production
cluster (verified: it does, a GKE prod cluster) — never rely on ambient
`current-context` for anything that touches this manifest.

```bash
make k8s-sandbox-install     # kubectl --context rancher-desktop apply -f deploy/agent-sandbox/v0.5.1/manifest.yaml, waits for controller + webhook Ready
make k8s-sandbox-uninstall   # kubectl --context rancher-desktop delete -f deploy/agent-sandbox/v0.5.1/manifest.yaml --ignore-not-found
```

Both targets fail fast with a clear error if the `rancher-desktop` kubectl
context isn't configured.

## Smoke test observations (2026-07-15/16, Rancher Desktop k3s v1.32.4+k3s1)

Ran `make k8s-sandbox-install` against the live Rancher Desktop cluster
(`--context rancher-desktop` throughout; ambient current-context was left
untouched — it is a production GKE cluster on this machine), then applied a
minimal smoke `Sandbox` CR in a throwaway `agent-sandbox-smoke` namespace:

```yaml
apiVersion: agents.x-k8s.io/v1beta1
kind: Sandbox
metadata:
  name: smoke-sandbox
  namespace: agent-sandbox-smoke
spec:
  podTemplate:
    spec:
      containers:
      - name: main
        image: busybox:stable
        command: ["sleep", "3600"]
```

Findings, recorded for Task 2's provider/status-mapping code:

- **Namespace created by the manifest:** `agent-sandbox-system`. The
  controller `Deployment/agent-sandbox-controller` and both `Service`s
  (`agent-sandbox-controller` for metrics, `agent-sandbox-webhook-service`
  for the admission/conversion webhook) live there. There is a single
  controller pod/container serving metrics (8080), healthz (8081), and the
  webhook (9443) — no separate webhook Deployment, so "controller Ready" and
  "webhook Ready" are effectively one readiness signal. The install target
  waits on `rollout status` + `wait --for=condition=Available` for the
  Deployment, then polls the webhook `Service`'s `Endpoints` for a non-empty
  address (confirms the pod is actually serving on 9443, not just
  `Running`). On an idle cluster this all completed in well under 15s.
- **`kubectl --context rancher-desktop get sandboxes -A`** returned
  `No resources found` cleanly right after install — confirms the CRD is
  registered and the conversion webhook is reachable (a broken webhook makes
  `list` error instead of returning empty).
- **Applying the smoke `Sandbox`** succeeded immediately (webhook admitted
  it, defaulted `spec.operatingMode: Running` and `spec.shutdownPolicy:
  Retain`).
- **Pod-name annotation: observed, on the `Sandbox` object, not the pod.**
  The `Sandbox`'s own `metadata.annotations` gained
  `agents.x-k8s.io/pod-name: smoke-sandbox` once the controller reconciled
  it. The backing `Pod` itself carries no agent-sandbox annotations — its
  identity is established purely through **exact name match** (pod name ==
  Sandbox name, no suffix/hash) plus an `ownerReferences` entry (`kind:
  Sandbox`, `controller: true`, matching `uid`). Task 2's status-mapping
  code can rely on `pod name == Sandbox name` directly, or read the
  `agents.x-k8s.io/pod-name` annotation off the `Sandbox` object for an
  explicit indirection.
- **Status conditions shape:** standard Kubernetes conditions array
  (`type`, `status`, `reason`, `message`, `lastTransitionTime`,
  `observedGeneration`). Observed exactly one condition,
  `type: Ready`, `status: "True"`, `reason: DependenciesReady`,
  `message: "Pod is Ready"`. No other condition types appeared in this
  minimal case (no volumes, no service). `status` also carries
  `nodeName`, `podIPs` (list), and `selector` (a label selector string,
  `agents.x-k8s.io/sandbox-name-hash=<hash>` — this is the label the
  controller puts on the pod, distinct from name-based identity above);
  `service`/`serviceFQDN` fields exist in the schema but were empty/absent
  since the smoke spec didn't request a `Service`.
  `kubectl get sandboxes` additionalPrinterColumns surface `READY` and
  `REASON` directly from that condition (`smoke-sandbox   True
  DependenciesReady`).
  - CLI evidence:
    ```
    NAME            READY   REASON              AGE
    smoke-sandbox   True    DependenciesReady   12s
    ```
- Pod reached `Running` within ~10s of the `Sandbox` object appearing
  (`busybox:stable` pull was fast on this cluster).
- **Cleanup:** deleted the smoke `Sandbox` object and the throwaway
  namespace together (`kubectl delete -f`); the owned `Pod` was
  cascade-deleted via the owner reference. `kubectl --context
  rancher-desktop get ns` afterward shows no leftover `agent-sandbox-smoke`
  namespace — only the pre-existing namespaces plus `agent-sandbox-system`
  (the controller install, left in place as intended).
- **Idempotency:** running `make k8s-sandbox-install` a second time against
  an already-installed cluster produced `unchanged` for every object
  (`kubectl apply` server-side diff is a no-op) and the wait/webhook-poll
  steps passed immediately since the Deployment was already `Available`.
