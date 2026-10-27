# Image Pipeline Health, PR 4 (test-agents-infra alerts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An unusable bound image source or a stalled bake scheduler pages Slack within minutes; fallbacks and startup failures are visible as warnings; the runbook says what to do for each reason; the Grafana overview shows the Images row.

**Architecture:** A `PrometheusRule` loaded from a YAML file (the pattern `storage-alerts.tf` already uses with `yamldecode(file(...))`), four rules per spec 10, unit-tested with `promtool test rules` through a validation script modeled on `tests/validate-storage.sh`, wired into CI as a new job. The runbook gains an "Image pipeline alerts" section with the reason-to-action table. The vendored `dashboards/valet.json` is refreshed from the valet chart (PR 3) and the overview dashboard's Application section gains the Images panels.

**Tech Stack:** OpenTofu/Terraform (`kubectl_manifest`), Prometheus rule YAML, `promtool`, GitHub Actions, Markdown, Grafana JSON.

**Spec:** `docs/plans/2026-10-26-image-pipeline-health-design.md` (in tkhq/valet), section 14 item 4, drawing on sections 9, 10, 11.2. Repo: `/Users/conner/tkhq/code/test-agents-infra` (default branch `main`).

## Global Constraints

- Branch `conner/image-pipeline-alerts` off `origin/main` in test-agents-infra; signed commits; follow that repo's commit style (`git log` shows plain imperative subjects, no conventional-commit prefix required).
- Alerts and expressions exactly (spec 10, with PR 3 refinement 5 for the `kind` label): `ValetImageSourceUnusable` `sum(valet_prebuild_sources_bound_unhealthy) > 0` for 30m critical; `ValetBakeSchedulerStalled` `valet_prebuild_scheduler_last_pass_age_seconds > 1800` for 10m critical; `ValetSandboxStartupFailures` `sum(increase(valet_sandbox_startup_failed_total{kind!="capacity"}[15m])) > 3` for 5m warning; `ValetImageFallbacks` `sum(increase(valet_sandbox_image_fallback_total[1h])) > 0` for 0m warning.
- `severity=critical` routes to `slack-critical` via the existing route in `monitoring.tf`; warnings stay on the `null` receiver. No Alertmanager config change.
- Rule group name `valet-image-pipeline`; `PrometheusRule` name `valet-image-pipeline`, namespace `monitoring`, discovered without extra labels (`ruleSelectorNilUsesHelmValues=false`).
- Each alert's `description` names the page to open (`/settings/organization/sandbox-images`) and the runbook section.
- `make validate-alerts` runs offline (no cluster, no remote state), like `tests/validate-storage.sh`.
- Prometheus metric names are the OTLP mapping of the OTel names: `valet_prebuild_sources`, `valet_prebuild_sources_bound_unhealthy`, `valet_prebuild_scheduler_last_pass_age_seconds`, `valet_sandbox_image_fallback_total`, `valet_sandbox_startup_failed_total`.

## Deliberate refinements of the spec

1. **Spec 10 "the infra repo has no promtool today".** It does: `tests/validate-storage.sh` already runs `promtool check rules` and `promtool test rules` for the storage rules, but nothing runs it in CI. The new script follows that pattern and a new CI job installs `promtool` and runs both scripts.
2. **Spec 10 `ValetSandboxStartupFailures`.** Excludes `kind="capacity"` (an org at its sandbox ceiling is not an infrastructure failure; PR 2 added that kind for exactly this reason).
3. **Spec 9 "dashboard gets an Images row".** The app-owned row ships in PR 3's `valet.json`; this PR re-vendors that file and copies the row into `valet-overview.json`'s Application section by hand (there is no builder script in the repo despite the comment in `tempo.tf`; the plan records the copy as a Python snippet so the next refresh is mechanical).

## Review Focus

1. `valet_prebuild_sources_bound_unhealthy` absent (API down or metric not yet exported): `ValetImageSourceUnusable` must not fire on absence (`sum()` of no series is empty, not 0), and must not page because the API is down (ValetApiDown covers that). Owner: Task 1 test "absent series does not fire".
2. Scheduler age exactly at the boundary and a restart: a 1800 s age that lasts under 10 m (API restart resets the in-process timestamp) must not page. Owner: Task 1 test "restart within the hold does not fire".
3. Three startup failures in 15 m is quiet; four is a warning; four `capacity` failures are quiet. Owner: Task 1.
4. `promtool` missing on a developer machine: the script fails with a clear message naming the install, not a cryptic `command not found` mid-run. Owner: Task 2.
5. The copied overview panels keep unique panel ids and the Application section's y-offsets stay monotonic. Owner: Task 4 test.

---

### Task 1: Rule file and PrometheusRule

**Files:**
- Create: `modules/platform/files/image-pipeline/rules.yaml`, `modules/platform/image-pipeline-alerts.tf`, `tests/image-pipeline-rules.test.yaml`

- [ ] **Step 1: Write the failing promtool tests**

`tests/image-pipeline-rules.test.yaml`:

```yaml
rule_files:
- ../modules/platform/files/image-pipeline/rules.yaml
evaluation_interval: 1m
tests:
- name: bound unhealthy source pages after 30m
  interval: 1m
  input_series:
  - series: valet_prebuild_sources_bound_unhealthy{source_kind="repo"}
    values: 1x40
  alert_rule_test:
  - alertname: ValetImageSourceUnusable
    eval_time: 29m
    exp_alerts: []
  - alertname: ValetImageSourceUnusable
    eval_time: 31m
    exp_alerts:
    - exp_labels: { severity: critical }
      exp_annotations:
        summary: An image source a recent session depends on is unusable
        description: "1 bound image source(s) are failing, incompatible, or unbaked for 30m+. Open /settings/organization/sandbox-images (sort by status) and follow the reason's guidance; see docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
- name: absent series does not fire
  interval: 1m
  input_series: []
  alert_rule_test:
  - alertname: ValetImageSourceUnusable
    eval_time: 40m
    exp_alerts: []
- name: scheduler stalled pages after 10m over 30m age
  interval: 1m
  input_series:
  - series: valet_prebuild_scheduler_last_pass_age_seconds
    values: 1801x15
  alert_rule_test:
  - alertname: ValetBakeSchedulerStalled
    eval_time: 9m
    exp_alerts: []
  - alertname: ValetBakeSchedulerStalled
    eval_time: 11m
    exp_alerts:
    - exp_labels: { severity: critical }
      exp_annotations:
        summary: The bake scheduler has not completed a pass in over 30 minutes
        description: "valet-api's image scheduler last finished a pass {{ $value | humanizeDuration }} ago. Check the valet-api pod logs for 'prebuild scheduler'; a stuck pass keeps every repository image from rebuilding. See docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
- name: restart within the hold does not fire
  interval: 1m
  input_series:
  - series: valet_prebuild_scheduler_last_pass_age_seconds
    values: 1801x5 30x10
  alert_rule_test:
  - alertname: ValetBakeSchedulerStalled
    eval_time: 14m
    exp_alerts: []
- name: four startup failures in 15m warn, three do not, capacity does not count
  interval: 1m
  input_series:
  - series: valet_sandbox_startup_failed_total{kind="crash_loop"}
    values: 0 0 1 1 2 2 3 3 3 3 3 3 3 3 3 3 3 3 3 3 3
  - series: valet_sandbox_startup_failed_total{kind="capacity"}
    values: 0+1x20
  alert_rule_test:
  - alertname: ValetSandboxStartupFailures
    eval_time: 20m
    exp_alerts: []
- name: four startup failures in 15m warn
  interval: 1m
  input_series:
  - series: valet_sandbox_startup_failed_total{kind="crash_loop"}
    values: 0 1 2 3 4 4 4 4 4 4 4 4 4 4 4 4 4 4 4 4 4
  alert_rule_test:
  - alertname: ValetSandboxStartupFailures
    eval_time: 10m
    exp_alerts:
    - exp_labels: { severity: warning }
      exp_annotations:
        summary: Sandboxes are failing to start
        description: "More than 3 terminal sandbox startup failures in 15m (crash loops, image pulls, pod failures, ownership waits). Check recent sessions' startup errors and the valet-api logs. See docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
- name: a fallback warns at once
  interval: 1m
  input_series:
  - series: valet_sandbox_image_fallback_total{reason="contract"}
    values: 0 0 1 1 1
  alert_rule_test:
  - alertname: ValetImageFallbacks
    eval_time: 3m
    exp_alerts:
    - exp_labels: { severity: warning }
      exp_annotations:
        summary: Sessions are starting on a fallback image
        description: "At least one session in the last hour started on the stock image because its repository image failed the runtime contract check. The rebake is automatic; if this persists past an hour, open /settings/organization/sandbox-images. See docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
```

(`increase()` on a counter whose growth is 4 within a 15 m window evaluates above 3; if promtool's extrapolation makes the three-failure case cross 3, lower the three-failure series to 0,0,1,1,2,2,2,2... (two increments) and keep the title; the behavior pinned is "below the threshold stays quiet".)

- [ ] **Step 2: Run to verify it fails**

Run: `promtool test rules tests/image-pipeline-rules.test.yaml` from the repo root.
Expected: FAIL, rule file not found.

- [ ] **Step 3: Write the rules and the resource**

`modules/platform/files/image-pipeline/rules.yaml`:

```yaml
groups:
  - name: valet-image-pipeline
    rules:
      # Bound-scoped on purpose: dormant test repos with broken bakes must
      # not page. The gauge counts only sources a session used in 7 days (or
      # a base with such a repo beneath it). Absent series → no fire; the API
      # being down is ValetApiDown's job.
      - alert: ValetImageSourceUnusable
        expr: sum(valet_prebuild_sources_bound_unhealthy) > 0
        for: 30m
        labels:
          severity: critical
        annotations:
          summary: An image source a recent session depends on is unusable
          description: "{{ $value }} bound image source(s) are failing, incompatible, or unbaked for 30m+. Open /settings/organization/sandbox-images (sort by status) and follow the reason's guidance; see docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
      # The 2026-09-29 → 2026-10-26 gap: no scheduler pass for weeks and
      # nothing noticed. The age is an in-process gauge; an API restart
      # resets it, which the 10m hold rides out.
      - alert: ValetBakeSchedulerStalled
        expr: valet_prebuild_scheduler_last_pass_age_seconds > 1800
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: The bake scheduler has not completed a pass in over 30 minutes
          description: "valet-api's image scheduler last finished a pass {{ $value | humanizeDuration }} ago. Check the valet-api pod logs for 'prebuild scheduler'; a stuck pass keeps every repository image from rebuilding. See docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
      # capacity = org sandbox ceiling; a product limit, not a failure.
      - alert: ValetSandboxStartupFailures
        expr: sum(increase(valet_sandbox_startup_failed_total{kind!="capacity"}[15m])) > 3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: Sandboxes are failing to start
          description: "More than 3 terminal sandbox startup failures in 15m (crash loops, image pulls, pod failures, ownership waits). Check recent sessions' startup errors and the valet-api logs. See docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
      - alert: ValetImageFallbacks
        expr: sum(increase(valet_sandbox_image_fallback_total[1h])) > 0
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: Sessions are starting on a fallback image
          description: "At least one session in the last hour started on the stock image because its repository image failed the runtime contract check. The rebake is automatic; if this persists past an hour, open /settings/organization/sandbox-images. See docs/runbooks/agents-dev-flux-operations.md, Image pipeline alerts."
```

`modules/platform/image-pipeline-alerts.tf`:

```hcl
# Image pipeline alerts (tkhq/valet docs/plans/2026-10-26-image-pipeline-health-design.md,
# section 10). Written after the 2026-10-26 incident: a repository image built
# before tini landed in the base crash-looped for a week, the scheduler had not
# rebaked anything since 2026-09-29, and nothing paged. Two criticals (a bound
# source unusable for 30m; the scheduler silent for 30m) route to Slack through
# the severity=critical route in monitoring.tf; two warnings stay UI-only.
# Rules live in files/image-pipeline/rules.yaml so promtool can unit-test them
# (tests/image-pipeline-rules.test.yaml, run by tests/validate-image-pipeline.sh).
resource "kubectl_manifest" "image_pipeline_alert_rules" {
  yaml_body = yamlencode({
    apiVersion = "monitoring.coreos.com/v1"
    kind       = "PrometheusRule"
    metadata = {
      name      = "valet-image-pipeline"
      namespace = "monitoring"
    }
    spec = yamldecode(file("${path.module}/files/image-pipeline/rules.yaml"))
  })

  depends_on = [helm_release.kube_prometheus_stack]
}
```

- [ ] **Step 4: Run the tests**

Run: `promtool check rules modules/platform/files/image-pipeline/rules.yaml && promtool test rules tests/image-pipeline-rules.test.yaml && tofu fmt -check modules/platform/image-pipeline-alerts.tf`
Expected: all pass.

- [ ] **Step 5: Stage and record**

Commit message (batch): `Add image pipeline alerts: unusable bound source, stalled scheduler, startup failures, fallbacks`.

---

### Task 2: Offline validation script, Makefile target, CI job

**Files:**
- Create: `tests/validate-image-pipeline.sh`
- Modify: `Makefile` (new `validate-alerts` target, `.PHONY`, help line), `.github/workflows/validate.yml` (new `alerts` job)

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Offline validation of the image pipeline alert rules; no cluster, no state.
set -euo pipefail
cd "$(dirname "$0")/.."
TF="${TF:-tofu}"
PROMTOOL="${PROMTOOL:-promtool}"
command -v "$PROMTOOL" >/dev/null || {
  echo "ERROR: promtool not found. Install Prometheus (brew install prometheus, or the prometheus-*.tar.gz from https://prometheus.io/download/) or set PROMTOOL=/path/to/promtool" >&2
  exit 1
}
"$PROMTOOL" check rules modules/platform/files/image-pipeline/rules.yaml
"$PROMTOOL" test rules tests/image-pipeline-rules.test.yaml
"$TF" fmt -check modules/platform/image-pipeline-alerts.tf
python3 - <<'PY'
import yaml
spec = yaml.safe_load(open('modules/platform/files/image-pipeline/rules.yaml'))
rules = {r['alert']: r for g in spec['groups'] for r in g['rules']}
assert set(rules) == {'ValetImageSourceUnusable', 'ValetBakeSchedulerStalled', 'ValetSandboxStartupFailures', 'ValetImageFallbacks'}, set(rules)
assert rules['ValetImageSourceUnusable']['labels']['severity'] == 'critical'
assert rules['ValetBakeSchedulerStalled']['labels']['severity'] == 'critical'
assert rules['ValetSandboxStartupFailures']['labels']['severity'] == 'warning'
assert rules['ValetImageFallbacks']['labels']['severity'] == 'warning'
for r in rules.values():
    assert 'Image pipeline alerts' in r['annotations']['description'], r['alert']
print('Validated 4 image pipeline alert rules (no messages sent).')
PY
```

`chmod +x tests/validate-image-pipeline.sh`. Makefile: add `validate-alerts` to `.PHONY`, a help line `make validate-alerts   - promtool-check and unit-test the alert rules`, and

```make
validate-alerts:
	./tests/validate-storage.sh
	./tests/validate-image-pipeline.sh
```

(If `validate-storage.sh` needs `tofu` and the CI runner has `terraform` only, pass `TF=terraform` in the workflow.) `validate.yml` gets a job:

```yaml
  alerts:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.5"
      - run: python3 -m pip install PyYAML==6.0.2
      - name: Install promtool
        run: |
          curl -fsSL https://github.com/prometheus/prometheus/releases/download/v3.2.1/prometheus-3.2.1.linux-amd64.tar.gz | tar -xz
          sudo install prometheus-3.2.1.linux-amd64/promtool /usr/local/bin/promtool
      - run: TF=terraform make validate-alerts
```

- [ ] **Step 2: Run locally**

Run: `make validate-alerts` (install promtool first if absent: `brew install prometheus`).
Expected: both scripts pass. If `validate-storage.sh`'s Terraform render step fails offline on this machine for reasons unrelated to this PR (provider download), run `tests/validate-image-pipeline.sh` alone, record the storage failure's first line in the report, and keep the Makefile target as written (CI has network).

- [ ] **Step 3: Stage and record**

Commit message: `Validate alert rules offline with promtool; run it in CI`.

---

### Task 3: Runbook section

**Files:**
- Modify: `docs/runbooks/agents-dev-flux-operations.md` (new section before "## Troubleshoot")

- [ ] **Step 1: Write the section**

```markdown
## Image pipeline alerts

Four rules in `modules/platform/files/image-pipeline/rules.yaml` watch the sandbox image pipeline (design: tkhq/valet `docs/plans/2026-10-26-image-pipeline-health-design.md`). The page to open for all of them is **Settings → Organization → Sandbox images** (`/settings/organization/sandbox-images`, org admins); sort by status and expand the red row. Each row shows the reason and the same guidance as below.

| Alert | Means | First look |
| --- | --- | --- |
| `ValetImageSourceUnusable` (critical) | A repository or base image that a session used in the last 7 days has been failing, incompatible, or unbuilt for 30 minutes. Sessions bound to it start on the stock image. | The sources page, sorted by status. The reason column maps to the table below. |
| `ValetBakeSchedulerStalled` (critical) | valet-api's scheduler has not completed a pass in 30 minutes. Nothing rebakes while this holds. | `kubectl -n valet logs deploy/valet-api | grep 'prebuild scheduler'`; a pass that throws for one source is logged and skipped, so a stall means the loop itself is stuck or the pod is unhealthy. |
| `ValetSandboxStartupFailures` (warning) | More than three terminal sandbox start failures in 15 minutes (crash loop, image pull, pod failed, ownership wait). | Recent sessions' startup error text names the kind; a crash loop quotes the container's last log line. |
| `ValetImageFallbacks` (warning) | A session started on the stock image because its repository image failed the runtime contract check. The rebake is automatic. | Nothing, unless it persists past an hour; then the sources page. |

Reason to action (same table the UI shows):

| Reason | Action |
| --- | --- |
| `resolve_failed` | Valet could not read the repo's recipe or lockfile. Usually a platform bug; the detail names the file. Open a valet issue with the detail text. |
| `repo_unreachable` | The Valet GitHub app lost access. Reinstall it on this repository. |
| `credentials` | Anonymous bakes are off for this org. Connect an org GitHub credential, or turn anonymous bakes on for public repos. |
| `registry_full` | The image registry is out of space. Retention needs to run; check `valet_prebuild_registry_*` and the registry PVC. |
| `bake_failed` | The setup commands failed. The log tail on the expanded row shows where. |
| `contract` | The image was built before a runtime change. A rebuild is already queued; wait for it, or press Bake now. |
| `contract_unknown` | Valet could not read the image's label from the registry. It will retry on the next pass; if it persists, check the registry. |
| `waiting_for_base` | The base image is building first. Nothing to do. |

Manual recovery: **Bake now** on the affected row starts a bake immediately; a base image rebake cascades to its repositories when it pushes.
```

- [ ] **Step 2: Check rendering**

Run: `grep -n '^## Image pipeline alerts' docs/runbooks/agents-dev-flux-operations.md` and open the file to confirm the tables sit before "## Troubleshoot".

- [ ] **Step 3: Stage and record**

Commit message: `Runbook: image pipeline alerts and the reason-to-action table`.

---

### Task 4: Dashboard refresh

**Files:**
- Modify: `modules/platform/dashboards/valet.json` (vendored copy of tkhq/valet `deploy/chart/valet/dashboards/valet.json` at PR 3's head), `modules/platform/dashboards/valet-overview.json`
- Create: `tests/test_dashboards.py` (unittest, picked up by a new line in `tests/validate-image-pipeline.sh`)

- [ ] **Step 1: Write the failing test**

```python
import json, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'modules/platform/dashboards'
IMAGE_METRICS = ['valet_prebuild_sources', 'valet_prebuild_sources_bound_unhealthy', 'valet_prebuild_scheduler_last_pass_age_seconds', 'valet_sandbox_image_fallback_total', 'valet_sandbox_startup_failed_total']

def exprs(dashboard):
    out = []
    for p in dashboard['panels']:
        for t in p.get('targets', []): out.append(t.get('expr', ''))
        for c in p.get('panels', []):
            for t in c.get('targets', []): out.append(t.get('expr', ''))
    return '\n'.join(out)

class Dashboards(unittest.TestCase):
    def test_vendored_valet_json_has_images_row(self):
        d = json.loads((ROOT / 'valet.json').read_text())
        self.assertTrue(any(p['type'] == 'row' and p['title'] == 'Images' for p in d['panels']))
        for m in IMAGE_METRICS: self.assertIn(m, exprs(d))
    def test_overview_has_images_row_with_unique_ids_and_monotonic_rows(self):
        d = json.loads((ROOT / 'valet-overview.json').read_text())
        self.assertTrue(any(p['type'] == 'row' and p['title'] == 'Images' for p in d['panels']))
        for m in IMAGE_METRICS: self.assertIn(m, exprs(d))
        ids = [p['id'] for p in d['panels']] + [c['id'] for p in d['panels'] for c in p.get('panels', [])]
        self.assertEqual(len(ids), len(set(ids)))
        ys = [p['gridPos']['y'] for p in d['panels'] if p['type'] == 'row']
        self.assertEqual(ys, sorted(ys))

if __name__ == '__main__':
    unittest.main()
```

Add `python3 -m unittest discover -s tests -p 'test_dashboards.py'` to `tests/validate-image-pipeline.sh`.

- [ ] **Step 2: Run to verify it fails**

Run: `python3 -m unittest tests/test_dashboards.py`
Expected: FAIL (no Images row).

- [ ] **Step 3: Refresh the vendored file and copy the row into the overview**

Copy `deploy/chart/valet/dashboards/valet.json` from the valet PR 3 worktree over `modules/platform/dashboards/valet.json`. Then run this once from the repo root and commit its output:

```python
import json
from pathlib import Path
root = Path('modules/platform/dashboards')
app = json.loads((root / 'valet.json').read_text())
ov = json.loads((root / 'valet-overview.json').read_text())
panels = app['panels']
start = next(i for i, p in enumerate(panels) if p['type'] == 'row' and p['title'] == 'Images')
end = next((i for i, p in enumerate(panels[start + 1:], start + 1) if p['type'] == 'row'), len(panels))
block = json.loads(json.dumps(panels[start:end]))
ovp = ov['panels']
anchor = next(i for i, p in enumerate(ovp) if p['type'] == 'row' and p['title'] == 'Tools, sandbox & credentials')
insert_at = next((i for i, p in enumerate(ovp[anchor + 1:], anchor + 1) if p['type'] == 'row'), len(ovp))
height = max(p['gridPos']['y'] + p['gridPos']['h'] for p in block) - block[0]['gridPos']['y']
base_y = ovp[insert_at]['gridPos']['y'] if insert_at < len(ovp) else max(p['gridPos']['y'] + p['gridPos']['h'] for p in ovp)
next_id = max([p['id'] for p in ovp] + [c['id'] for p in ovp for c in p.get('panels', [])]) + 1
dy = base_y - block[0]['gridPos']['y']
for p in block:
    p['id'] = next_id; next_id += 1
    p['gridPos']['y'] += dy
for p in ovp[insert_at:]:
    p['gridPos']['y'] += height
ov['panels'] = ovp[:insert_at] + block + ovp[insert_at:]
(root / 'valet-overview.json').write_text(json.dumps(ov, indent=2) + '\n')
print(f'inserted {len(block)} panels at y={base_y}, shifted {len(ovp) - insert_at} panels by {height}')
```

Save the snippet as `scripts/refresh-overview-images-row.py` so the next refresh is `python3 scripts/refresh-overview-images-row.py` after re-vendoring, and reference it from the comment in `tempo.tf`.

- [ ] **Step 4: Run the tests**

Run: `tests/validate-image-pipeline.sh` and `make validate` (the dashboard ConfigMap `file()` must still parse).
Expected: PASS.

- [ ] **Step 5: Stage and record**

Commit message: `Dashboards: vendor the Images row and add it to the overview`.

---

### Task 5: Verification and PR

- [ ] Run `make fmt-check`, `make validate`, `make validate-flux`, `make validate-alerts`.
- [ ] Push `conner/image-pipeline-alerts` and open the PR against `main` with: what pages and why (the incident), the four rules, the deploy note that `ValetImageSourceUnusable` depends on PR 3 of tkhq/valet being deployed (until then the series is absent and the rule stays silent), and the validation commands.

## Self-review notes

- Spec 14 item 4 mapped: `image-pipeline-alerts.tf` (Task 1), promtool CI step and test file (Tasks 1, 2), runbook section (Task 3), dashboard row (Task 4). The chart guard bump in `scripts/validate-flux-render.sh` is not needed: this PR moves no chart version.
- Review Focus: 1 → "absent series" test; 2 → "restart within the hold" test; 3 → the two startup-failure tests; 4 → the `command -v promtool` guard; 5 → `test_dashboards.py` id/y assertions.
- Spec amendments: 10 (promtool exists; CI step is the new part); `ValetSandboxStartupFailures` excludes `capacity`.
