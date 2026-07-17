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

# --- DATABASE_URL wiring: bundled vs external ---------------------------
grep -q 'name: DATABASE_URL' "$TMP_DIR/bundled.yaml" || fail "bundled render: api Deployment missing DATABASE_URL env"
grep -q 'postgres://\$(POSTGRES_USER):\$(POSTGRES_PASSWORD)@valet-postgres:5432/\$(POSTGRES_DB)' "$TMP_DIR/bundled.yaml" \
  || fail "bundled render: DATABASE_URL is not composed from the bundled postgres Secret"
grep -q 'kind: StatefulSet' "$TMP_DIR/bundled.yaml" || fail "bundled render: no postgres StatefulSet"
pass "bundled render: DATABASE_URL wired from bundled postgres Secret"

grep -q 'DATABASE_URL: "postgres://ext:pw@external-host:5432/valet"' "$TMP_DIR/external.yaml" \
  || fail "external render: DATABASE_URL does not carry externalDatabase.url verbatim"
if grep -q 'kind: StatefulSet' "$TMP_DIR/external.yaml"; then
  fail "external render: bundled postgres StatefulSet still rendered when externalDatabase.url is set"
fi
pass "external render: DATABASE_URL from externalDatabase.url, bundled postgres resources absent"

# --- VALET_SANDBOX_API_URL: pod-reachable in-cluster Service DNS ---------
grep -q 'VALET_SANDBOX_API_URL: "http://valet-api.default.svc.cluster.local:80"' "$TMP_DIR/bundled.yaml" \
  || fail "ConfigMap VALET_SANDBOX_API_URL is not the api Service's in-cluster DNS name"
pass "VALET_SANDBOX_API_URL carries the api Service's .svc.cluster.local DNS name"

# --- No Secret keys leak into the ConfigMap ------------------------------
CONFIGMAP_BLOCK=$(awk '/^kind: ConfigMap$/,/^---$/' "$TMP_DIR/bundled.yaml")
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

# --- initContainer present on the api Deployment (bundled) ---------------
echo "$API_DEPLOY_BLOCK" | grep -q 'initContainers:' || fail "api Deployment missing initContainers (bundled)"
echo "$API_DEPLOY_BLOCK" | grep -q 'wait-for-postgres' || fail "api Deployment missing wait-for-postgres initContainer"
pass "api Deployment has wait-for-postgres initContainer"

echo
echo "All golden assertions passed."
