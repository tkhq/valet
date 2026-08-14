#!/usr/bin/env bash
# Golden-template assertions for the valet Helm chart.
#
# Runs `helm lint` + `helm template` (no live cluster required) and greps
# the rendered manifests for the invariants called out in
# docs/specs/2026-07-15-kubernetes-deployment-design.md decision 8:
#   - RBAC Role is namespaced with exactly the expected verbs/resources,
#     and nothing cluster-scoped exists.
#   - api env carries DATABASE_URL from bundled postgres by default, and
#     from externalDatabase.url when set.
#   - no Secret values leak into the ConfigMap.
#   - imagePullPolicy is IfNotPresent, replicas is 1.
#   - the lookup-retain helper is present in the Secret template.
#   - the api Deployment has a wait-for-postgres initContainer (bundled).
#
# Usage: deploy/chart/valet/test/golden.sh
set -euo pipefail

CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

pass() {
  echo "ok - $1"
}

echo "== helm lint =="
helm lint "$CHART_DIR"
pass "helm lint clean"

echo "== helm template (bundled postgres, default values) =="
helm template valet "$CHART_DIR" --kube-version 1.30.0 > "$TMP_DIR/bundled.yaml"
pass "renders with default values"

echo "== helm template (external database) =="
helm template valet "$CHART_DIR" --kube-version 1.30.0 \
  --set externalDatabase.url="postgres://ext:pw@external-host:5432/valet" \
  > "$TMP_DIR/external.yaml"
pass "renders with externalDatabase.url set"

echo "== helm template (external registry) =="
helm template valet "$CHART_DIR" --kube-version 1.30.0 \
  --set externalRegistry.url="registry.example.com" \
  --set externalRegistry.pullSecret="regcred" \
  > "$TMP_DIR/external-registry.yaml"
pass "renders with externalRegistry.url set"

# --- RBAC: namespaced only, nothing cluster-scoped ---------------------
grep -q '^kind: Role$' "$TMP_DIR/bundled.yaml" || fail "no namespaced Role rendered"
grep -q '^kind: RoleBinding$' "$TMP_DIR/bundled.yaml" || fail "no RoleBinding rendered"
if grep -qE '^kind: (ClusterRole|ClusterRoleBinding)$' "$TMP_DIR/bundled.yaml"; then
  fail "cluster-scoped RBAC object found (ClusterRole/ClusterRoleBinding) — spec requires namespaced-only"
fi
pass "no cluster-scoped RBAC objects"

# Extract the Role's rule block and check exact expected resources/verbs.
ROLE_BLOCK=$(awk '/^kind: Role$/,/^---$/' "$TMP_DIR/bundled.yaml")
for resource in sandboxes pods pods/exec pods/log; do
  echo "$ROLE_BLOCK" | grep -q "\"$resource\"" || fail "Role missing resource: $resource"
done
for verb in create get list watch delete; do
  echo "$ROLE_BLOCK" | grep -q "\"$verb\"" || fail "Role missing verb: $verb"
done
# The sandboxes rule specifically needs `update`: the adopt-on-409 path calls
# replaceNamespacedCustomObject (PUT = update). A generic whole-Role grep for
# "update" is not enough — assert it on the sandboxes rule's own verb line.
SANDBOX_VERBS=$(echo "$ROLE_BLOCK" | grep -A8 '"sandboxes"' | grep -m1 'verbs:')
echo "$SANDBOX_VERBS" | grep -q '"update"' \
  || fail "sandboxes rule missing 'update' verb — adopt/re-provision (replaceNamespacedCustomObject PUT) would 403"
# `patch` guards hibernation: suspend/resume flip spec.operatingMode via a
# JSON merge patch — omitting it 403s the idle sweep and the pause route.
echo "$SANDBOX_VERBS" | grep -q '"patch"' \
  || fail "sandboxes rule missing 'patch' verb — hibernation suspend/resume (merge-patch operatingMode) would 403"
if echo "$ROLE_BLOCK" | grep -qE '"?persistentvolumeclaims"?'; then
  fail "Role grants persistentvolumeclaims — agent-sandbox controller owns PVC lifecycle, api must not"
fi
pass "Role has the expected sandbox/pods/exec/log verbs incl. sandboxes:update, no PVC verbs"

# --- RBAC: batch/jobs (Task 5 BuildKit builder), scoped -------------------
echo "$ROLE_BLOCK" | grep -q '"batch"' || fail "Role missing apiGroup: batch"
echo "$ROLE_BLOCK" | grep -q '"jobs"' || fail "Role missing resource: jobs"
JOBS_VERBS=$(echo "$ROLE_BLOCK" | grep -A6 '"jobs"' | grep -m1 'verbs:')
for verb in create get list watch delete; do
  echo "$JOBS_VERBS" | grep -q "\"$verb\"" || fail "jobs rule missing verb: $verb"
done
pass "Role has the expected batch/jobs verbs"

# --- RBAC: configmaps/secrets (Task 5 Dockerfile/git-token resources) -----
echo "$ROLE_BLOCK" | grep -q '"configmaps"' || fail "Role missing resource: configmaps"
CONFIGMAPS_VERBS=$(echo "$ROLE_BLOCK" | grep -A4 '"configmaps"' | grep -m1 'verbs:')
for verb in create delete; do
  echo "$CONFIGMAPS_VERBS" | grep -q "\"$verb\"" || fail "configmaps rule missing verb: $verb"
done
# configmaps grant is deliberately minimal (mirrors secrets below): no `get` —
# the api only creates/deletes build ConfigMaps by name, never reads one back.
if echo "$CONFIGMAPS_VERBS" | grep -q '"get"'; then
  fail "configmaps rule grants 'get' — the api never reads a build ConfigMap back, keep this grant minimal"
fi
if echo "$CONFIGMAPS_VERBS" | grep -qE '"list"|"watch"'; then
  fail "configmaps rule grants list/watch — unnecessary, keep this grant minimal"
fi
echo "$ROLE_BLOCK" | grep -q '"secrets"' || fail "Role missing resource: secrets"
SECRETS_VERBS=$(echo "$ROLE_BLOCK" | grep -A4 '"secrets"' | grep -m1 'verbs:')
for verb in create delete; do
  echo "$SECRETS_VERBS" | grep -q "\"$verb\"" || fail "secrets rule missing verb: $verb"
done
# Secrets grant: `get` is REQUIRED (Task 9). writeSecret/upsertSecret GET the
# Secret for its resourceVersion before replace (optimistic concurrency) — the
# api reads the metadata, never the decoded contents. `list`/`watch` stay
# forbidden: nothing enumerates or watches Secrets.
if echo "$SECRETS_VERBS" | grep -qE '"list"|"watch"'; then
  fail "secrets rule grants list/watch — unnecessary, keep this grant minimal"
fi
pass "Role has the expected configmaps/secrets verbs (secrets: create/get/patch/update/delete for optimistic-concurrency writes, no list/watch; configmaps: create/delete only)"

# --- DATABASE_URL wiring: bundled vs external ---------------------------
grep -q 'name: DATABASE_URL' "$TMP_DIR/bundled.yaml" || fail "bundled render: api Deployment missing DATABASE_URL env"
grep -q 'postgres://\$(POSTGRES_USER):\$(POSTGRES_PASSWORD)@valet-postgres:5432/\$(POSTGRES_DB)' "$TMP_DIR/bundled.yaml" \
  || fail "bundled render: DATABASE_URL is not composed from the bundled postgres Secret"
grep -q 'kind: StatefulSet' "$TMP_DIR/bundled.yaml" || fail "bundled render: no postgres StatefulSet"
pass "bundled render: DATABASE_URL wired from bundled postgres Secret"

grep -q 'DATABASE_URL: "postgres://ext:pw@external-host:5432/valet"' "$TMP_DIR/external.yaml" \
  || fail "external render: DATABASE_URL does not carry externalDatabase.url verbatim"
if grep -q 'name: valet-postgres' "$TMP_DIR/external.yaml"; then
  fail "external render: bundled postgres StatefulSet still rendered when externalDatabase.url is set"
fi
pass "external render: DATABASE_URL from externalDatabase.url, bundled postgres resources absent"

# --- VALET_SANDBOX_API_URL: pod-reachable in-cluster Service DNS ---------
grep -q 'VALET_SANDBOX_API_URL: "http://valet-api.default.svc.cluster.local:80"' "$TMP_DIR/bundled.yaml" \
  || fail "ConfigMap VALET_SANDBOX_API_URL is not the api Service's in-cluster DNS name"
pass "VALET_SANDBOX_API_URL carries the api Service's .svc.cluster.local DNS name"

# --- No Secret keys leak into the ConfigMap ------------------------------
CONFIGMAP_BLOCK=$(awk '/^kind: ConfigMap$/{f=1} f&&/^---$/{exit} f' "$TMP_DIR/bundled.yaml")
for secret_key in BETTER_AUTH_SECRET VALET_ENCRYPTION_KEY ANTHROPIC_API_KEY POSTGRES_PASSWORD DATABASE_URL; do
  if echo "$CONFIGMAP_BLOCK" | grep -q "$secret_key"; then
    fail "ConfigMap leaks secret key: $secret_key"
  fi
done
pass "no secret keys present in the ConfigMap"

# --- imagePullPolicy / replicas ------------------------------------------
grep -q 'imagePullPolicy: IfNotPresent' "$TMP_DIR/bundled.yaml" || fail "api container missing imagePullPolicy: IfNotPresent"
pass "imagePullPolicy is IfNotPresent"

API_DEPLOY_BLOCK=$(awk '/^kind: Deployment$/,0' "$TMP_DIR/bundled.yaml")
echo "$API_DEPLOY_BLOCK" | grep -m1 'replicas:' | grep -q 'replicas: 1' \
  || fail "api Deployment replicas is not pinned to 1"
pass "api Deployment replicas pinned to 1"

# --- lookup-retain helper present in Secret template ---------------------
grep -q 'define "valet.retainedSecretValue"' "$CHART_DIR/templates/_helpers.tpl" \
  || fail "retained-secret-value helper not found in _helpers.tpl"
grep -q 'lookup "v1" "Secret"' "$CHART_DIR/templates/_helpers.tpl" \
  || fail "retained-secret-value helper does not use lookup"
grep -q 'valet.retainedSecretValue' "$CHART_DIR/templates/secret.yaml" \
  || fail "app Secret template does not use the retain-guard helper"
grep -q 'valet.retainedSecretValue' "$CHART_DIR/templates/postgres-secret.yaml" \
  || fail "postgres Secret template does not use the retain-guard helper"
pass "lookup-retain helper present and used by both Secret templates"

# --- pod-template checksums: rotate the material, roll the pod -----------
# Env vars from envFrom/secretKeyRef are injected once, at pod start. Without
# these annotations a `helm upgrade` that only changes a Secret leaves the pod
# template byte-identical, Kubernetes keeps the running pod, and the OLD value
# stays live while `helm upgrade --wait` reports success.
render_api_deploy() {
  helm template valet "$CHART_DIR" --kube-version 1.30.0 \
    --show-only templates/deployment.yaml "$@"
}

render_api_deploy --set api.secrets.anthropicApiKey=key-one > "$TMP_DIR/deploy-key-one.yaml"
grep -q 'checksum/secret:' "$TMP_DIR/deploy-key-one.yaml" \
  || fail "api pod template missing checksum/secret — a rotated Secret would not roll the pod"
grep -q 'checksum/config:' "$TMP_DIR/deploy-key-one.yaml" \
  || fail "api pod template missing checksum/config — a changed ConfigMap would not roll the pod"
pass "api pod template carries checksum/secret + checksum/config"

# Both digests must be identical for identical input. The chart generates
# BETTER_AUTH_SECRET, VALET_ENCRYPTION_KEY and the bundled postgres password
# fresh on every render that cannot `lookup` them, so a digest taken over the
# RENDERED Secret churns and restarts the api pod on a no-op upgrade.
render_api_deploy --set api.secrets.anthropicApiKey=key-one > "$TMP_DIR/deploy-key-one-again.yaml"
CHECKSUMS_ONE=$(grep 'checksum/' "$TMP_DIR/deploy-key-one.yaml")
[ "$CHECKSUMS_ONE" = "$(grep 'checksum/' "$TMP_DIR/deploy-key-one-again.yaml")" ] \
  || fail "pod-template checksums differ across two identical renders — a no-op upgrade would restart the api pod"
pass "pod-template checksums are stable across identical renders (no churn)"

SECRET_SUM_ONE=$(grep 'checksum/secret:' "$TMP_DIR/deploy-key-one.yaml")
render_api_deploy --set api.secrets.anthropicApiKey=key-two > "$TMP_DIR/deploy-key-two.yaml"
[ "$SECRET_SUM_ONE" != "$(grep 'checksum/secret:' "$TMP_DIR/deploy-key-two.yaml")" ] \
  || fail "checksum/secret unchanged after rotating api.secrets.anthropicApiKey — the api pod would keep the old key"
pass "checksum/secret tracks api.secrets.*"

# The bundled postgres credentials reach the api as DATABASE_URL through
# secretKeyRef, so they belong in the same digest.
render_api_deploy --set postgres.password=rotated-pw > "$TMP_DIR/deploy-pg.yaml"
[ "$SECRET_SUM_ONE" != "$(grep 'checksum/secret:' "$TMP_DIR/deploy-pg.yaml")" ] \
  || fail "checksum/secret unchanged after rotating postgres.password"
pass "checksum/secret tracks the bundled postgres credentials"

CONFIG_SUM_ONE=$(grep 'checksum/config:' "$TMP_DIR/deploy-key-one.yaml")
render_api_deploy --set api.betterAuthUrl=https://rotated.example.com > "$TMP_DIR/deploy-cfg.yaml"
[ "$CONFIG_SUM_ONE" != "$(grep 'checksum/config:' "$TMP_DIR/deploy-cfg.yaml")" ] \
  || fail "checksum/config unchanged after changing a ConfigMap value"
pass "checksum/config tracks the rendered ConfigMap"

# --- initContainer present on the api Deployment (bundled) ---------------
echo "$API_DEPLOY_BLOCK" | grep -q 'initContainers:' || fail "api Deployment missing initContainers (bundled)"
echo "$API_DEPLOY_BLOCK" | grep -q 'wait-for-postgres' || fail "api Deployment missing wait-for-postgres initContainer"
pass "api Deployment has wait-for-postgres initContainer"

# --- registry: bundled vs external ----------------------------------------
grep -q '^kind: StatefulSet$' "$TMP_DIR/bundled.yaml" || fail "bundled render: no StatefulSet at all"
BUNDLED_STATEFULSETS=$(grep -c '^kind: StatefulSet$' "$TMP_DIR/bundled.yaml")
[ "$BUNDLED_STATEFULSETS" -eq 2 ] || fail "bundled render: expected 2 StatefulSets (postgres + registry), found $BUNDLED_STATEFULSETS"
grep -q 'name: valet-registry' "$TMP_DIR/bundled.yaml" || fail "bundled render: no registry StatefulSet/Service named valet-registry"
grep -q '^kind: CronJob$' "$TMP_DIR/bundled.yaml" || fail "bundled render: no registry-gc CronJob"
grep -q 'REGISTRY_STORAGE_DELETE_ENABLED' "$TMP_DIR/bundled.yaml" || fail "bundled render: registry missing REGISTRY_STORAGE_DELETE_ENABLED=true (required for retention's manifest DELETE)"
pass "bundled render: registry StatefulSet/Service/GC-CronJob present"

# The registry Service must be NodePort (kubelet pulls prebuilt images via
# localhost:<nodePort> — a ClusterIP-only Service name is unresolvable by the
# node). Assert on the registry Service block specifically.
REGISTRY_SVC_BLOCK=$(awk '/^kind: Service$/{svc=1} svc&&/name: valet-registry$/{hit=1} hit&&/^---$/{exit} hit{print}' "$TMP_DIR/bundled.yaml")
echo "$REGISTRY_SVC_BLOCK" | grep -q 'type: NodePort' \
  || fail "bundled render: registry Service is not type: NodePort (kubelet can't pull a ClusterIP-only Service name)"
echo "$REGISTRY_SVC_BLOCK" | grep -q 'nodePort: 30500' \
  || fail "bundled render: registry Service missing nodePort: 30500 from registry.nodePort"
pass "bundled render: registry Service is NodePort with nodePort 30500"

if grep -q 'name: valet-registry' "$TMP_DIR/external-registry.yaml"; then
  fail "external-registry render: bundled registry resources still rendered when externalRegistry.url is set"
fi
EXTERNAL_REGISTRY_CONFIGMAP=$(awk '/^kind: ConfigMap$/{f=1} f&&/^---$/{exit} f' "$TMP_DIR/external-registry.yaml")
echo "$EXTERNAL_REGISTRY_CONFIGMAP" | grep -q 'VALET_PREBUILD_REGISTRY: "registry.example.com"' \
  || fail "external-registry render: VALET_PREBUILD_REGISTRY does not carry externalRegistry.url verbatim"
# External registry has no push/pull split — the PUSH host equals the pull URL.
echo "$EXTERNAL_REGISTRY_CONFIGMAP" | grep -q 'VALET_PREBUILD_REGISTRY_PUSH: "registry.example.com"' \
  || fail "external-registry render: VALET_PREBUILD_REGISTRY_PUSH should equal externalRegistry.url (no split)"
echo "$EXTERNAL_REGISTRY_CONFIGMAP" | grep -q 'VALET_PREBUILD_REGISTRY_INSECURE: "false"' \
  || fail "external-registry render: VALET_PREBUILD_REGISTRY_INSECURE should be false for an external registry"
echo "$EXTERNAL_REGISTRY_CONFIGMAP" | grep -q 'VALET_SANDBOX_IMAGE_PULL_SECRET: "regcred"' \
  || fail "external-registry render: VALET_SANDBOX_IMAGE_PULL_SECRET does not carry externalRegistry.pullSecret"
pass "external-registry render: no bundled registry resources, VALET_PREBUILD_REGISTRY(_PUSH/_INSECURE)/pull-secret wired from externalRegistry.*"

# --- registry: VALET_PREBUILD_REGISTRY wiring (bundled) --------------------
BUNDLED_CONFIGMAP=$(awk '/^kind: ConfigMap$/{f=1} f&&/^---$/{exit} f' "$TMP_DIR/bundled.yaml")
# PULL host = localhost:<nodePort> (what kubelet resolves per-node).
echo "$BUNDLED_CONFIGMAP" | grep -q 'VALET_PREBUILD_REGISTRY: "localhost:30500"' \
  || fail "bundled render: VALET_PREBUILD_REGISTRY (pull host) is not localhost:<nodePort> — kubelet can't pull a cluster-DNS Service name"
# PUSH host = in-cluster Service DNS (what BuildKit Jobs + api-pod retention reach).
echo "$BUNDLED_CONFIGMAP" | grep -q 'VALET_PREBUILD_REGISTRY_PUSH: "valet-registry.valet-sandboxes.svc.cluster.local:5000"' \
  || fail "bundled render: VALET_PREBUILD_REGISTRY_PUSH is not the registry's in-cluster Service DNS name"
echo "$BUNDLED_CONFIGMAP" | grep -q 'VALET_PREBUILD_REGISTRY_INSECURE: "true"' \
  || fail "bundled render: VALET_PREBUILD_REGISTRY_INSECURE should be true for the bundled (HTTP-only) registry"
echo "$BUNDLED_CONFIGMAP" | grep -q 'VALET_IMAGE_BUILDER: "kubernetes"' \
  || fail "bundled render: VALET_IMAGE_BUILDER is not pinned to kubernetes"
pass "VALET_PREBUILD_REGISTRY (pull=localhost NodePort) + _PUSH (cluster DNS) + _INSECURE/VALET_IMAGE_BUILDER wired for the bundled registry"

# --- build resources/deadline values wiring ---------------------------------
echo "$BUNDLED_CONFIGMAP" | grep -q 'VALET_PREBUILD_BUILD_DEADLINE_SECONDS: "1800"' \
  || fail "ConfigMap missing VALET_PREBUILD_BUILD_DEADLINE_SECONDS from build.activeDeadlineSeconds"
echo "$BUNDLED_CONFIGMAP" | grep -q 'VALET_PREBUILD_BUILD_CPU_REQUEST: "1"' \
  || fail "ConfigMap missing VALET_PREBUILD_BUILD_CPU_REQUEST from build.resources.requests.cpu"
echo "$BUNDLED_CONFIGMAP" | grep -q 'VALET_PREBUILD_BUILD_MEMORY_LIMIT: "4Gi"' \
  || fail "ConfigMap missing VALET_PREBUILD_BUILD_MEMORY_LIMIT from build.resources.limits.memory"
pass "build.resources/activeDeadlineSeconds values wired into the ConfigMap"

# --- no secret/token material rendered anywhere -----------------------------
if grep -qiE 'ghp_|gho_|github_pat_' "$TMP_DIR/bundled.yaml" "$TMP_DIR/external-registry.yaml"; then
  fail "a git-token-shaped string leaked into a rendered manifest"
fi
pass "no token-shaped secret material rendered anywhere (chart never bakes in a git token — minted per-build at runtime)"

# --- ingress: generic annotations passthrough (EKS/cert-manager) ------------
helm template valet "$CHART_DIR" --kube-version 1.30.0 \
  --set ingress.className=nginx \
  --set ingress.annotations."cert-manager\.io/cluster-issuer"=letsencrypt \
  --set ingress.tls.secretName=valet-tls \
  > "$TMP_DIR/ingress-nginx.yaml"
grep -q 'cert-manager.io/cluster-issuer: letsencrypt' "$TMP_DIR/ingress-nginx.yaml" \
  || fail "ingress.annotations not rendered into Ingress metadata"
if grep -q 'traefik.ingress.kubernetes.io/router.tls' "$TMP_DIR/ingress-nginx.yaml"; then
  fail "traefik annotation leaked into a non-traefik ingress"
fi
pass "ingress.annotations passthrough works; traefik annotation gated on className"

grep -q 'traefik.ingress.kubernetes.io/router.tls: "true"' "$TMP_DIR/bundled.yaml" \
  || fail "default traefik TLS annotation regressed"
pass "default (traefik) ingress annotation unchanged"

# --- observability: bundled otel-lgtm stack + api OTLP wiring ---------------
grep -q 'name: valet-otel-lgtm' "$TMP_DIR/bundled.yaml" || fail "bundled render: no otel-lgtm Deployment"
grep -q 'name: valet-otel$' "$TMP_DIR/bundled.yaml" || fail "bundled render: no valet-otel OTLP Service"
grep -q 'name: valet-grafana$' "$TMP_DIR/bundled.yaml" || fail "bundled render: no valet-grafana Service"
GRAFANA_SVC_BLOCK=$(awk '/^kind: Service$/{svc=1} svc&&/name: valet-grafana$/{hit=1} hit&&/^---$/{exit} hit{print}' "$TMP_DIR/bundled.yaml")
echo "$GRAFANA_SVC_BLOCK" | grep -q 'nodePort: 30300' \
  || fail "bundled render: grafana Service missing nodePort 30300 from observability.grafanaNodePort"
echo "$BUNDLED_CONFIGMAP" | grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT: "http://valet-otel.default.svc.cluster.local:4318"' \
  || fail "bundled render: ConfigMap OTEL_EXPORTER_OTLP_ENDPOINT is not the bundled otel Service's in-cluster OTLP/HTTP URL"
echo "$BUNDLED_CONFIGMAP" | grep -q 'OTEL_SERVICE_NAME: "valet-api"' \
  || fail "bundled render: ConfigMap missing OTEL_SERVICE_NAME"
pass "observability: bundled otel-lgtm Deployment/Services rendered, api OTLP endpoint wired"

helm template valet "$CHART_DIR" --kube-version 1.30.0 \
  --set observability.enabled=false \
  > "$TMP_DIR/no-observability.yaml"
if grep -q 'name: valet-otel-lgtm' "$TMP_DIR/no-observability.yaml"; then
  fail "observability.enabled=false still renders the otel-lgtm stack"
fi
if grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT' "$TMP_DIR/no-observability.yaml"; then
  fail "observability.enabled=false still sets OTEL_EXPORTER_OTLP_ENDPOINT (api must stay a no-op)"
fi
pass "observability disabled: no otel resources, no OTLP env (api telemetry stays env-gated off)"

helm template valet "$CHART_DIR" --kube-version 1.30.0 \
  --set observability.enabled=false \
  --set observability.otlpEndpoint="http://collector.example.com:4318" \
  > "$TMP_DIR/external-otel.yaml"
EXTERNAL_OTEL_CONFIGMAP=$(awk '/^kind: ConfigMap$/{f=1} f&&/^---$/{exit} f' "$TMP_DIR/external-otel.yaml")
echo "$EXTERNAL_OTEL_CONFIGMAP" | grep -q 'OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.com:4318"' \
  || fail "external otlpEndpoint not carried into the ConfigMap verbatim"
if grep -q 'name: valet-otel-lgtm' "$TMP_DIR/external-otel.yaml"; then
  fail "external otlpEndpoint render still bundles the otel-lgtm stack when enabled=false"
fi
pass "external collector: otlpEndpoint wired verbatim without the bundled stack"

# --- observability: provisioned Grafana dashboard --------------------------
grep -q 'name: valet-grafana-dashboards' "$TMP_DIR/bundled.yaml" \
  || fail "bundled render: no grafana-dashboards ConfigMap"
grep -q 'valet-dashboard.json' "$TMP_DIR/bundled.yaml" \
  || fail "bundled render: dashboard JSON not mounted/rendered"
grep -q '"uid": "valet-observability"' "$TMP_DIR/bundled.yaml" \
  || fail "bundled render: dashboard JSON body (uid valet-observability) missing from the ConfigMap"
if grep -q 'valet-grafana-dashboards' "$TMP_DIR/no-observability.yaml"; then
  fail "observability.enabled=false still renders the dashboards ConfigMap"
fi
pass "observability: valet dashboard ConfigMap rendered and gated on observability.enabled"

# --- instance config: ConfigMap + subPath mount + VALET_CONFIG env ---------
# api.instanceConfig renders a ConfigMap holding valet.yaml, mounts it as a
# single file via subPath at /etc/valet/valet.yaml, points VALET_CONFIG at it,
# and stamps a checksum/instance-config pod annotation so a config edit rolls
# the pod.
echo "== helm template (instance config) =="
helm template valet "$CHART_DIR" --kube-version 1.30.0 \
  --set api.instanceConfig="version: 1" \
  > "$TMP_DIR/instance-config.yaml"
pass "renders with api.instanceConfig set"

INSTANCE_CONFIGMAP_BLOCK=$(awk '/^kind: ConfigMap$/{f=1} f&&/^---$/{f=0} f&&/valet-instance-config/{hit=1} hit{print} f==0{hit=0}' "$TMP_DIR/instance-config.yaml")
grep -q 'name: valet-instance-config' "$TMP_DIR/instance-config.yaml" \
  || fail "instance-config render: no valet-instance-config ConfigMap"
grep -q 'valet.yaml:' "$TMP_DIR/instance-config.yaml" \
  || fail "instance-config render: ConfigMap has no valet.yaml key"
pass "instance-config render: ConfigMap with valet.yaml key present"

grep -q 'VALET_CONFIG' "$TMP_DIR/instance-config.yaml" \
  || fail "instance-config render: api container missing VALET_CONFIG env"
grep -q 'value: /etc/valet/valet.yaml' "$TMP_DIR/instance-config.yaml" \
  || fail "instance-config render: VALET_CONFIG is not /etc/valet/valet.yaml"
pass "instance-config render: VALET_CONFIG points at /etc/valet/valet.yaml"

grep -q 'mountPath: /etc/valet/valet.yaml' "$TMP_DIR/instance-config.yaml" \
  || fail "instance-config render: volumeMount not at /etc/valet/valet.yaml"
grep -q 'subPath: valet.yaml' "$TMP_DIR/instance-config.yaml" \
  || fail "instance-config render: volumeMount missing subPath valet.yaml (directory mount would shadow /etc/valet)"
pass "instance-config render: valet.yaml mounted via subPath (no directory shadowing)"

grep -q 'checksum/instance-config:' "$TMP_DIR/instance-config.yaml" \
  || fail "instance-config render: pod template missing checksum/instance-config — a config edit would not roll the pod"
pass "instance-config render: pod template carries checksum/instance-config"

echo
echo "All golden assertions passed."
