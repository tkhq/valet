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
