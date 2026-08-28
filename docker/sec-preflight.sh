#!/usr/bin/env sh
# sec-preflight — tool-presence probe for the security personas (NOT_ASSESSED
# ledger, M-P2d; valet-security design §Coverage honesty). Modeled on Akshar's
# tools/preflight-registry.py: a canonical tool registry with a presence probe,
# a version, and a `consequence` naming the oracle that becomes NOT ASSESSED
# when the tool is absent.
#
# The sast and secrets-config personas run this first, then record a coverage
# row per tool: sec_coverage_report status=assessed for a present tool, and
# status=not_assessed with the consequence as the reason for an absent one.
#
# Output is one row per tool: TOOL PRESENT VERSION CONSEQUENCE. It stays
# machine-readable (tab-separated) AND human-readable. No network, no writes —
# a read-only probe against the sandbox PATH.
#
# The registry below is the tool set the sast persona and the secrets-config
# playbook name. gitleaks is baked into the image; semgrep and the language
# scanners are NOT (the image carries no Python runtime; see the Dockerfile
# security-scanners note), so they probe absent and become NOT_ASSESSED rows.

set -eu

# One entry per tool: "name|consequence". The probe is `command -v <name>`.
REGISTRY='gitleaks|Committed secrets and high-entropy strings are not scanned.
semgrep|Pattern-based SAST over the OWASP/CWE rule packs is not run; injection and taint sinks are not scanned.
bandit|Python security lint (subprocess, yaml.load, pickle) is not run.
gosec|Go security lint (command exec, weak crypto, SQL) is not run.
npm|JavaScript/TypeScript dependency audit (npm audit) is not run.
trivy|Dependency and container CVE scanning is not run.'

printf '%s\t%s\t%s\t%s\n' TOOL PRESENT VERSION CONSEQUENCE

printf '%s\n' "$REGISTRY" | while IFS='|' read -r name consequence; do
  [ -z "$name" ] && continue
  if command -v "$name" >/dev/null 2>&1; then
    # Best-effort version — first line of `<tool> version` or `--version`.
    version="$("$name" version 2>/dev/null | head -n1 || true)"
    [ -z "$version" ] && version="$("$name" --version 2>/dev/null | head -n1 || true)"
    [ -z "$version" ] && version="present"
    printf '%s\ty\t%s\t%s\n' "$name" "$version" "$consequence"
  else
    printf '%s\tn\t-\t%s\n' "$name" "$consequence"
  fi
done
