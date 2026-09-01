# Part 03: Tool Provisioning and Coverage

*Depends on: Part 00, Part 01. Conformance: L1.*

## Purpose

This part fixes the per-persona tool inventory, the install mechanics inside the persona sandbox, the preflight probe, and the NOT_ASSESSED coverage contract. The v0 preflight probe covered six tools (`gitleaks`, `semgrep`, `bandit`, `gosec`, `npm`, `trivy`). v1 covers 60+ tools across the scanner-bearing personas. Every install pins an exact version.

## Non-goals in this part

- **Kali sidecar.** The base design and the concept notes converged on in-sandbox install (Lambda cold-start model). This part MUST NOT reintroduce a shared Kali container.
- **MCP daemons for ZAP / Burp / Playwright.** Deferred to v2 (Appendix C §C.4). Personas that would benefit (dast, fuzz, exploit) list the CLI-tool subset that ships in v1.
- **Cross-engagement tool cache.** Deferred to v2 (Appendix C §C.7).

## The eight persona-tool inventories

Every persona below is one of Valet's bundled personas (`packages/plugin-security/src/lib/personas.ts::BUNDLED_PERSONAS`). The `pivot-coordinator` inventory (§3.5.8) covers the persona that ships new in this spec.

Format for each row:
- **name.** Binary name the persona invokes.
- **install.** Command template. Pin the version.
- **entry.** How the persona calls it (Bash, MCP, HTTP).
- **rule pack / area.** What coverage area maps to this tool.
- **absent-consequence.** The NOT_ASSESSED reason the persona records when the tool is missing.

### 3.5.1 `code-review` persona

`code-review` reads by hand. Its tools are lightweight and mostly Unix (grep, git, wc). Two scanner adjuncts triage secrets and known SAST rules.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `rg` (ripgrep) | `apt-get install -y ripgrep=13.0.0-2+b3` | Bash | grep sweeps over the clone | secrets/config search falls back to `grep -r`, slower but present |
| `git` | pre-baked in sandbox image | Bash | blame / log / diff for provenance | not applicable (pre-baked) |
| `wc` | pre-baked in sandbox image | Bash | line counts for coverage floor | not applicable (pre-baked) |
| `gitleaks` | GitHub release tag `v8.18.2`, SHA `<pin>` | Bash | hardcoded secret sweep | "secrets not scanned because gitleaks is missing" |
| `semgrep` | `pip3 install --break-system-packages semgrep==1.72.0` | Bash | rule-pack triage adjunct (Semgrep Registry: `p/owasp-top-ten`, `p/cwe-top-25`) | "semgrep rule packs not applied" |
| `trufflehog` | `apt-get install -y trufflehog=3.63.2-1` | Bash | secondary secret sweep, entropy-based | "trufflehog not run, entropy secret paths only checked by gitleaks" |

**Playbook reads:** `packages/plugin-security/playbooks/authz.md`, `injection.md`, `secrets-config.md`. Playbooks list the sink taxonomy per language.

### 3.5.2 `sast` persona

`sast` runs scanners first, triages second. It ships language-native scanners plus Semgrep Registry rule packs.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `semgrep` | `pip3 install --break-system-packages semgrep==1.72.0` | Bash | Semgrep Registry rule packs per language (`p/owasp-top-ten`, `p/cwe-top-25`, `p/nodejsscan`, `p/react`, `p/nextjs`, `p/express`, `p/python`, `p/flask`, `p/django`, `p/golang`, `p/java`, `p/csharp`, `p/ruby`, `p/rust`) | "semgrep rule packs not applied for languages X, Y, Z" |
| `bandit` | `pip3 install --break-system-packages bandit==1.7.9` | Bash | Python SAST (`B301`, `B506`, `B608`, `B411`, ...) | "python SAST not applied" |
| `gosec` | `go install github.com/securego/gosec/v2/cmd/gosec@v2.20.0` | Bash | Go SAST (`G101`, `G201`, `G303`, ...) | "go SAST not applied" |
| `brakeman` | `apt-get install -y brakeman=6.1.2-1` | Bash | Rails SAST | "ruby-on-rails SAST not applied" |
| `phpstan` | `composer global require phpstan/phpstan=1.11.1` | Bash | PHP SAST | "php SAST not applied" |
| `psalm` | `composer global require vimeo/psalm=5.24.0` | Bash | PHP SAST (Vimeo Psalm) | "php SAST psalm rules not applied" |
| `security-scan` | `dotnet tool install --global security-scan --version 5.6.7` | Bash | .NET SAST (Roslyn analyzers) | ".NET SAST not applied" |
| `eslint`+`eslint-plugin-security` | `npm install -g eslint@9.4.0 eslint-plugin-security@3.0.1` | Bash | JS/TS SAST (semgrep is primary; eslint is secondary) | "javascript SAST secondary pass not applied" |
| `cargo-audit` | `cargo install cargo-audit --version 0.20.0 --locked` | Bash | Rust dependency vuln audit | "rust dependency audit not run" |
| `trivy` | GitHub release tag `v0.55.0`, SHA `<pin>` | Bash | SBOM and dep-vuln scan (multi-language) | "SBOM and dep-vuln scan not run" |
| `syft` | GitHub release tag `v1.12.0`, SHA `<pin>` | Bash | SBOM enumeration (used with trivy) | "SBOM enumeration missing, dep classification incomplete" |
| `trufflehog` | `apt-get install -y trufflehog=3.63.2-1` | Bash | secondary secret sweep | "trufflehog secret sweep skipped" |
| `gitleaks` | GitHub release tag `v8.18.2`, SHA `<pin>` | Bash | primary secret sweep | "gitleaks secret sweep skipped" |

**Playbook reads:** `packages/plugin-security/playbooks/sast.md`.

### 3.5.3 `dast` persona

`dast` sweeps a running HTTP target within `authorized_scope.hosts`. Every tool below has an egress allowlist gated to that scope.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `nmap` | `apt-get install -y nmap=7.94-1` | Bash | port + service enum on scope hosts | "port and service enum not performed" |
| `nikto` | `apt-get install -y nikto=2.5.0-3` | Bash | HTTP misconfiguration sweep | "HTTP misconfig sweep not run" |
| `nuclei` | GitHub release tag `v3.2.9`, SHA `<pin>` | Bash | template-driven vuln sweep (`~/nuclei-templates` refreshed to tag `v9.9.0`) | "nuclei template sweep not run" |
| `httpx` | `go install github.com/projectdiscovery/httpx/cmd/httpx@v1.6.0` | Bash | HTTP probing, headers, TLS handshake | "HTTP probing incomplete, headers uncollected" |
| `subfinder` | `go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@v2.6.6` | Bash | passive subdomain enum (in-scope only) | "subdomain enum not performed" |
| `gobuster` | `apt-get install -y gobuster=3.6.0-3` | Bash | active directory + subdomain brute force | "content discovery skipped" |
| `dirb` | `apt-get install -y dirb=2.22+dfsg-6` | Bash | fallback content discovery | "content discovery skipped (dirb backup)" |
| `sqlmap` | `apt-get install -y sqlmap=1.8.3-1` | Bash | SQLi confirmation per suspect endpoint | "SQLi confirmation not run" |
| `wafw00f` | `pip3 install --break-system-packages wafw00f==2.3.0` | Bash | WAF fingerprint | "WAF detection not run" |
| `testssl.sh` | `git clone --branch v3.2.1 --depth 1 https://github.com/drwetter/testssl.sh /opt/testssl.sh && ln -s /opt/testssl.sh/testssl.sh /usr/local/bin/testssl` | Bash | TLS/SSL misconfig sweep | "TLS/SSL misconfig sweep not run" |
| `graphql-cop` | `pip3 install --break-system-packages graphql-cop==1.5.0` | Bash | GraphQL introspection + auth checks | "GraphQL sweep skipped" |
| `whatweb` | `apt-get install -y whatweb=0.5.5-4` | Bash | tech-stack fingerprint | "tech fingerprint skipped" |

**Playbook reads:** `packages/plugin-security/playbooks/dast.md`, `authz.md`, `injection.md`.

### 3.5.4 `fuzz` persona

`fuzz` runs mutation and coverage-guided fuzzers against a running target or a library.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `ffuf` | `go install github.com/ffuf/ffuf/v2@v2.1.0` | Bash | web param + path fuzzing | "web param fuzzing skipped" |
| `wfuzz` | `pip3 install --break-system-packages wfuzz==3.1.0` | Bash | HTTP fuzzer fallback | "HTTP fuzzer fallback skipped" |
| `wapiti3` | `pip3 install --break-system-packages wapiti3==3.2.2` | Bash | web app scanner + injection fuzz | "wapiti scan skipped" |
| `sqlmap` | `apt-get install -y sqlmap=1.8.3-1` | Bash | SQLi mutation with `--random-agent --level=5 --risk=3` | "SQLi mutation skipped" |
| `commix` | `pip3 install --break-system-packages commix==4.0` | Bash | command injection sweep | "OS command injection sweep skipped" |
| `schemathesis` | `pip3 install --break-system-packages schemathesis==3.30.0` | Bash | OpenAPI-spec-driven fuzz | "API contract fuzzing skipped" |
| `restler` | `git clone --branch v9.2.4 --depth 1 https://github.com/microsoft/restler-fuzzer /opt/restler-fuzzer && cd /opt/restler-fuzzer && dotnet build --configuration Release && ln -sf /opt/restler-fuzzer/restler/bin/Release/net6.0/Restler /usr/local/bin/restler` | Bash | REST API stateful fuzz | "REST API stateful fuzz skipped" |
| `radamsa` | `apt-get install -y radamsa=0.6-1` | Bash | binary format mutation | "binary format mutation skipped" |
| `zzuf` | `apt-get install -y zzuf=0.15-2+b1` | Bash | stdin mutation for CLI binaries | "CLI binary mutation skipped" |
| `boofuzz` | `pip3 install --break-system-packages boofuzz==0.4.2` | Bash | protocol fuzzing | "protocol fuzzing skipped" |
| `atheris` | `pip3 install --break-system-packages atheris==2.3.0` | Bash | Python library fuzzing | "python library fuzz skipped" |
| `afl-fuzz` (AFL++) | `apt-get install -y aflplusplus=4.21c-1` | Bash | coverage-guided binary fuzz | "coverage-guided binary fuzz skipped" |
| `cargo-fuzz` | `cargo install cargo-fuzz --version 0.12.0 --locked` | Bash | Rust library fuzz | "rust library fuzz skipped" |
| `go-fuzz` | `go install github.com/dvyukov/go-fuzz/go-fuzz@e07ad4b1` | Bash | Go library fuzz | "go library fuzz skipped" |
| `jazzer` | `git clone --branch v0.22.1 --depth 1 https://github.com/CodeIntelligenceTesting/jazzer /opt/jazzer && cd /opt/jazzer && bazel build //deploy:jazzer` | Bash | JVM library fuzz | "jvm library fuzz skipped" |
| `graphql-cop` | `pip3 install --break-system-packages graphql-cop==1.5.0` | Bash | GraphQL injection + auth fuzz | "GraphQL fuzz skipped" |
| `smuggler` | `pip3 install --break-system-packages smuggler==1.1` | Bash | HTTP request smuggling sweep | "HTTP request smuggling sweep skipped" |
| `h2c-smuggler` | `git clone --depth 1 https://github.com/BishopFox/h2csmuggler /opt/h2csmuggler` | Bash | h2c smuggle sweep | "h2c smuggling sweep skipped" |

**Multi-kind coverage rule:** when `target_kinds` includes `web` or `api` AND the clone at `/workspace` has a `fuzz/` directory OR any `func Fuzz*` test, the persona MUST also plan `library` coverage (cargo-fuzz / go-fuzz / atheris / AFL++ / jazzer, whichever language matches). See the persona role markdown for the multi-kind gating.

**Playbook reads:** `packages/plugin-security/playbooks/fuzz.md`.

### 3.5.5 `exploit` persona

`exploit` chains a confirmed finding to a non-destructive PoC. It reuses `dast` and `fuzz` tools by reference; the entries below cover chaining and delivery.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `curl` | pre-baked in sandbox image | Bash | manual HTTP replays with cookies from `/loot/catalog.yml` | not applicable |
| `pwntools` | `pip3 install --break-system-packages pwntools==4.13.0` | Bash | payload crafting for chain PoCs | "chain PoC crafting library missing, manual only" |
| `sqlmap` | `apt-get install -y sqlmap=1.8.3-1` | Bash | bounded read PoC for SQLi finding | "SQLi PoC skipped" |
| `hydra` | `apt-get install -y hydra=9.5-1+b3` | Bash | credential spraying for confirmed weak-cred finding | "cred-spraying PoC skipped" |
| `msfvenom` (Metasploit CLI, no daemon) | `apt-get install -y metasploit-framework=6.4.19-0kali1` | Bash | payload generation only (no auto-launch, no listener) | "PoC generation library missing, manual only" |

**No metasploit console.** v1 does NOT wire the msfconsole daemon. `msfvenom` runs offline to generate a payload, then a persona delivers it manually within scope. See Appendix B §T-2 for the safety analysis.

**Playbook reads:** `packages/plugin-security/playbooks/exploit.md`.

### 3.5.6 `threat-model` persona

`threat-model` is source-only. It reads the clone, the loaded threat-category YAMLs, and the recon map from `reads[]`. No scanner binaries; grep and read only.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `rg` | `apt-get install -y ripgrep=13.0.0-2+b3` | Bash | trust-boundary and entry-point sweep | fall back to `grep -r` |
| `wc` | pre-baked | Bash | code-volume floor | not applicable |
| Category YAMLs | ships in `packages/plugin-security/categories/*.yml`, read via `sec_fs_read /categories/<name>.yml` (v1 does NOT mount categories under `/categories/`; the persona `sec_fs_read`s the mounted `/playbooks/threat-model.md` which lists the category names, then downloads each category YAML by `sec_fs_read /categories/<name>.yml`, added as read-only mount in v1) | Read | STRIDE + domain patterns | "threat categories not loaded, STRIDE coverage from memory only" |

**New read-only mount in v1:** `/categories/<name>.yml` for each loaded category. `sec_fs_read` serves these from the plugin package (mirroring how `/protocol.md` and `/plan.yml` mount today).

**Playbook reads:** `packages/plugin-security/playbooks/threat-model.md`.

### 3.5.7 `attack-tree` persona

`attack-tree` composes AND/OR chains from confirmed findings. Source-only; no scanner binaries.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `rg`, `wc`, `git` | as above | Bash | evidence gathering per node | not applicable |
| Category YAMLs | see §3.5.6 | Read | attacker-goal enumeration | "goals seeded from memory only, prior category YAMLs not loaded" |
| CAPEC / CWE lookups | WebFetch through the runner cell (no in-persona web access) | Read | pattern id resolution for nodes | "CAPEC/CWE ids left un-normalized, tree may miss standard patterns" |

**Playbook reads:** `packages/plugin-security/playbooks/attack-tree.md`.

### 3.5.8 `pivot-coordinator` persona

`pivot-coordinator` is a new v1 persona. It reads `needs.yml` from every prior cell, classifies each need, executes catalog patterns, and writes `pivot.yml`. Its tools are file operations plus one lightweight IP-in-CIDR check.

| Tool | Install | Entry | Area | Absent consequence |
|---|---|---|---|---|
| `python3` + stdlib `ipaddress` module | pre-baked in sandbox image | Bash | IP-in-CIDR check for `scope-auto-include` | not applicable (pre-baked) |
| `curl` | pre-baked in sandbox image | Bash | login POST (`create-test-account`, L4) | "signup and login not attempted at L4" |
| `python3` + stdlib `http.cookiejar` | pre-baked in sandbox image | Bash | Netscape cookies.txt read/write for `propagate-session` | not applicable (pre-baked) |
| `sec_loot_write` | engine `ToolDef` in `packages/api/src/engine/security-tools.ts` | Tool | append-only write to `/loot/catalog.yml` | new v1 tool; MUST ship |

**Playbook reads:** `packages/plugin-security/playbooks/pivot-coordinator.md`. See Part 05 §5.1 for the persona role.

## Install mechanisms (normative)

### APT install

Debian/Ubuntu packages ship with `apt-get`.

```bash
apt-get update
apt-get install -y <package>=<version>
```

**Version pinning is REQUIRED.** `nmap=7.94-1`, not `nmap`. `latest` is not allowed. A tool whose exact pinned version is not available on the sandbox distro's mirror MUST fail install; the preflight probe records `present: false` and the persona records NOT_ASSESSED for every rule pack that tool covers.

**Cache.** An implementation MAY cache APT packages in a per-user volume for speed. Caching MUST NOT change semantics: the exact pinned version installs regardless of cache state.

### GitHub release install

Standalone binaries ship with `wget` + SHA-256 verify + extract.

```bash
wget https://github.com/<org>/<repo>/releases/download/<tag>/<artifact> -O /tmp/<artifact>
echo "<sha256>  /tmp/<artifact>" | sha256sum -c
tar -xzf /tmp/<artifact> -C /tmp/
mv /tmp/<binary> /usr/local/bin/<binary>
chmod +x /usr/local/bin/<binary>
```

**Both the tag and the SHA-256 MUST be exact.** A tag mismatch fails download; a SHA mismatch fails verify. Either failure records `present: false`. GPG signature verification is deferred to v2 (Appendix C §C.5).

### `go install`

Go tools ship with a pinned tag or commit hash.

```bash
GOBIN=/usr/local/bin go install <module>@<version>
```

**Version pinning is REQUIRED.** `@latest` is not allowed. `go-fuzz` uses `@e07ad4b1` (commit hash) because the project does not tag; every other Go tool uses a tag.

**Go version pin.** The sandbox image MUST ship a specific Go version (e.g. `golang-1.22`). Different Go versions may produce different binaries; behavior SHOULD be identical modulo stdlib evolution. Record the Go version in the coverage report `runtime.go_version` field.

### `pip3` install

Python tools install with `pip3 --break-system-packages` (PEP 668 override; sandboxes have no venv layer for tools).

```bash
pip3 install --break-system-packages <package>==<version>
```

**Version pinning is REQUIRED.** `==<version>`, not `>=<version>`.

### `git clone` + build

Tools that ship only as source ship with a shallow clone at a pinned branch/tag.

```bash
git clone --branch <tag> --depth 1 https://github.com/<org>/<repo> /opt/<repo>
cd /opt/<repo>
<build command>
ln -s /opt/<repo>/<binary> /usr/local/bin/<binary>
```

**Both the tag and the build command MUST be exact.** `testssl.sh` and `restler` follow this pattern. `jazzer` uses Bazel; the build step MUST record the Bazel version in the coverage report.

## Preflight probes (per persona)

Every scanner-bearing persona ships its own preflight script. The default script `docker/sec-preflight.sh` is the UNION of every persona's set, retained for backward compatibility.

Per-persona scripts:
- `docker/sec-preflight-code-review.sh`
- `docker/sec-preflight-sast.sh`
- `docker/sec-preflight-dast.sh`
- `docker/sec-preflight-fuzz.sh`
- `docker/sec-preflight-exploit.sh`
- `docker/sec-preflight-threat-model.sh`
- `docker/sec-preflight-attack-tree.sh`
- `docker/sec-preflight-pivot-coordinator.sh`

Each script probes every tool the persona's inventory lists. Output format is a normative YAML file written to `/tmp/tools.yml` inside the sandbox. The persona reads it and commits a revision to `/cells/<own>/tools.yml` through `sec_fs_write`.

**Probe script shape (normative):**

```bash
#!/bin/bash
# docker/sec-preflight-<persona>.sh
# Emits YAML to stdout matching the coverage report schema in §3.3.
set -euo pipefail

echo "schema_version: 1"
echo "persona: <persona id>"
echo "probed_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "runtime:"
echo "  go_version: $(go version 2>/dev/null | awk '{print $3}' || echo null)"
echo "  python_version: $(python3 --version 2>/dev/null | awk '{print $2}' || echo null)"
echo "  node_version: $(node --version 2>/dev/null || echo null)"
echo "tools:"

# One block per tool the persona inventory names. Personas parse this file and
# derive rule-pack coverage from `present`.
for tool in <persona-specific tool list>; do
  if command -v "$tool" &>/dev/null; then
    version=$("$tool" --version 2>&1 | head -1 || echo "unknown")
    location=$(command -v "$tool")
    installed_at_runtime="false"
    if [ -f "/var/lib/valet-installed-at-runtime/$tool" ]; then
      installed_at_runtime="true"
    fi
    echo "  - name: $tool"
    echo "    present: true"
    echo "    version: \"$version\""
    echo "    install_location: \"$location\""
    echo "    installed_at_runtime: $installed_at_runtime"
  else
    echo "  - name: $tool"
    echo "    present: false"
    echo "    version: null"
    echo "    install_location: null"
    echo "    installed_at_runtime: false"
  fi
done
```

## Coverage report schema

The preflight probe writes `tools.yml` to `/tmp/tools.yml` in the sandbox. The persona commits it as the first revision of `/cells/<own>/tools.yml` via `sec_fs_write`. Schema is normative.

```yaml
schema_version: 1                        # integer, MUST be 1
persona: <persona id>
probed_at: <iso8601 UTC>
runtime:
  go_version: <string or null>
  python_version: <string or null>
  node_version: <string or null>
tools:
  - name: <string>                       # binary name
    present: <bool>                      # in PATH and executable
    version: <string or null>            # `<tool> --version` first line, or null
    install_location: <path or null>     # absolute path or null
    installed_at_runtime: <bool>         # true iff installed by prep-step
```

**`installed_at_runtime` semantics.** The install prep-step touches `/var/lib/valet-installed-at-runtime/<tool>` on success. The probe reads this marker to differentiate pre-baked vs runtime-installed. Prep-step failure (network, mirror, SHA mismatch) leaves the marker absent AND the tool absent, and the probe reports `present: false`.

## Persona handling of missing tools

When a persona reads `tools.yml` and finds `present: false` on a tool, it MUST:

1. Log a WARN line in the state doc log naming the tool and the oracle it covers.
2. Emit `sec_coverage_report status=not_assessed area=<pack> tool=<tool> reason=<the consequence>` for every rule pack the tool covers. Use the absent-consequence text from the inventory table verbatim.
3. Skip the oracle. Continue with every other oracle whose tools are present.

**A cell with N absent tools is not a failure.** The cell records N NOT_ASSESSED coverage rows and settles with `status: done` when its non-absent checklist items are exhausted. The verifier persona reads every cell's `tools.yml` at engagement close and emits meta-findings for coverage gaps (§7.3).

## Runtime install

If a tool is absent AND the persona has network egress AND the persona has time to install, it MAY install the tool at runtime BEFORE recording NOT_ASSESSED. The install MUST use the exact command in the inventory table (same pinned version). On success, the persona re-runs the probe (or manually stamps `present: true` in `/tmp/tools.yml` and commits a new revision to `/cells/<own>/tools.yml`). On failure, the persona records NOT_ASSESSED and continues.

**Concurrency.** Two personas in the same engagement MAY race to install the same tool. `mv /tmp/<binary> /usr/local/bin/<binary>` is atomic on the same filesystem. The loser detects the binary already present and skips. No lock is required.

## Bootstrap integration

`packages/api/src/engine/security-bootstrap.ts::securityToolPrepSteps(persona)` returns the ordered prep-steps for one persona. `buildSpecProvider` appends these steps when `personaCell != null`. Each step is idempotent (`command -v <tool>` guards) and swallows its own failure (`critical: false`); the persona's preflight probe reports the outcome. A future v2 optimization (Appendix C §C.7) caches installed binaries; v1 installs from scratch every cell.

## Conformance

**L0.** No tool provisioning. L0 is pure decision. Personas do not run tools.

**L1.** Every install mechanism ships (APT, GitHub release, `go install`, `pip3`, `git clone` + build). Every persona ships a preflight script. Every persona reads `tools.yml` and records NOT_ASSESSED for absent tools. Personas MAY runtime-install absent tools.

**L2 and above.** Same as L1.

**L4.** The `verifier` persona (base design M-P3, Part 07 §7.3) reads `tools.yml` from every cell and emits meta-findings for version mismatches against the inventory pinning.
