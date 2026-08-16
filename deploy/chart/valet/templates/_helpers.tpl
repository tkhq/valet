{{/*
Chart name, used as a prefix for resource names.
*/}}
{{- define "valet.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "valet.fullname" -}}
{{- .Release.Name -}}
{{- end -}}

{{- define "valet.labels" -}}
app.kubernetes.io/name: {{ include "valet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "valet.selectorLabels" -}}
app.kubernetes.io/name: {{ include "valet.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Retain-guard secret-value lookup.

Regenerating secrets (BETTER_AUTH_SECRET, VALET_ENCRYPTION_KEY, the bundled
Postgres password) on every `helm upgrade` would invalidate every session
cookie and rotate the sandbox JWT signing master (VALET_SANDBOX_JWT_MASTER
falls back to BETTER_AUTH_SECRET) — so a value that isn't explicitly
supplied via values must be generated ONCE and then reused across upgrades.

`lookup` returns {} (not nil) on `helm template`/`helm lint`/`--dry-run`
(no live API access), so this degrades to "always generate" outside a real
cluster, which is what golden-template tests exercise.

Usage:
  {{ include "valet.retainedSecretValue" (dict "root" $ "namespace" "ns" "name" "secret-name" "key" "the-key" "length" 32) }}
*/}}
{{- define "valet.retainedSecretValue" -}}
{{- $existing := lookup "v1" "Secret" .namespace .name -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- index $existing.data .key | b64dec -}}
{{- else -}}
{{- randAlphaNum (.length | default 32) -}}
{{- end -}}
{{- end -}}

{{/*
Digest of the Secret material the api container reads, for its pod-template
`checksum/secret` annotation.

Env vars from `envFrom`/`secretKeyRef` are injected once, at pod start. An
upgrade that only changes a Secret leaves the pod template byte-identical, so
Kubernetes keeps the running pod and the OLD value stays live while
`helm upgrade --wait` reports success. This digest puts the material into the
pod template, which makes the upgrade roll the Deployment.

It covers everything an operator can supply:
  - api.secrets.*        — the app Secret's supplied keys
  - externalDatabase.url — DATABASE_URL in the app Secret
  - postgres.*           — the bundled Postgres credentials the api composes
                           DATABASE_URL from

It deliberately does NOT hash the rendered Secret, which is the usual Helm
idiom. `valet.retainedSecretValue` returns a fresh `randAlphaNum` string
whenever `lookup` reads nothing back — on `helm install`, and on every
`helm template`/`--dry-run`. A digest over the rendered Secret therefore
differs between two renders of identical input, and the first upgrade after
an install would restart the api pod for no reason. A retained value never
changes on its own, so leaving it out costs no rollout that is needed.

`toYaml` sorts map keys, so equal input always gives an equal digest. A new
key under `api.secrets` is covered without an edit here.
*/}}
{{- define "valet.apiSecretChecksum" -}}
{{- $material := dict
      "apiSecrets" .Values.api.secrets
      "externalDatabaseUrl" .Values.externalDatabase.url
      "postgres" (dict
        "user" .Values.postgres.user
        "database" .Values.postgres.database
        "password" .Values.postgres.password)
-}}
{{- toYaml $material | sha256sum -}}
{{- end -}}
