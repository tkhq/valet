/**
 * Security scanner bootstrap: installs the scanners a security cell persona
 * assumes are present, at runtime, into an already-cloned sandbox.
 *
 * ── Why runtime, not a baked image ──────────────────────────────────────
 * The scanner playbooks (`packages/plugin-security/playbooks/*.md`) tell each
 * persona to run `sec-preflight` first, then run `gitleaks` / `semgrep`. None
 * of those tools shipped in any sandbox image, and `sec-preflight` did not
 * exist at all. Rather than bake a warm image, we install the tools at cell
 * start via best-effort {@link PrepStep}s. Every security cell sandbox gets the
 * SAME three steps — there is no per-persona or per-playbook scoping, so every
 * persona may assume the tools are present.
 *
 * ── Best-effort contract ────────────────────────────────────────────────
 * Every step is `critical: false`: a failed step does NOT abort the sandbox.
 * Each `apply` also swallows its own exec failures (network reject, non-zero
 * exit) and resolves. An absent tool is already handled downstream as a
 * NOT_ASSESSED coverage row — `sec-preflight` prints exactly which tools are
 * present, so a persona that cannot find `gitleaks` records
 * `sec_coverage_report status=not_assessed` instead of silently skipping.
 *
 * ── Egress ──────────────────────────────────────────────────────────────
 * The gitleaks step needs egress to github.com; the semgrep step needs
 * egress to pypi.org (and the apt mirror for python3-pip). If egress is
 * blocked, the step fails best-effort and `sec-preflight` reports the tool
 * absent — nothing crashes.
 *
 * ── Path discipline ─────────────────────────────────────────────────────
 * `Sandbox.writeFile` only reliably targets workspace-relative paths (see the
 * header of `workspace-prep.ts`). So `sec-preflight` is staged at a
 * workspace-relative path via `writeFile`, then `exec`d (privileged) into
 * `/usr/local/bin`. The gitleaks/semgrep steps run entirely inside privileged
 * `exec` command strings — they never `writeFile` an absolute path.
 */
import type { Sandbox } from "@valet/engine";

/** Workspace-relative staging path for the preflight script — written via
 * `writeFile` (workspace-relative only), then `exec`d into place. */
const PREFLIGHT_STAGING_PATH = ".valet-prep/sec-preflight";
/** Final in-sandbox location — referenced only inside `exec` strings. */
const PREFLIGHT_BIN_PATH = "/usr/local/bin/sec-preflight";

/** Pinned gitleaks release. Bump this constant to move the pin. The release
 * ships per-arch assets (`gitleaks_<version>_linux_x64.tar.gz` and
 * `..._linux_arm64.tar.gz`); the install step selects the asset by the
 * sandbox's real arch at run time (see the gitleaks step). A hardcoded arch
 * installs a binary that cannot execute — gitleaks then reads as absent on an
 * arm64 sandbox (Apple Silicon dev machines, arm64 k8s nodes). */
const GITLEAKS_VERSION = "8.28.0";
export const GITLEAKS_RELEASE_URL = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;

/** The semgrep install command. bookworm-slim ships no pip and enforces
 * PEP 668 (externally-managed), so we install pip via apt then pip-install
 * semgrep with `--break-system-packages`. */
export const SEMGREP_INSTALL_COMMAND =
  "apt-get update && apt-get install -y python3-pip && pip3 install --break-system-packages semgrep";

/**
 * The `sec-preflight` probe. Prints one tab-separated row per known scanner:
 * `name  present(y/n)  version-or-consequence`. A present tool reports its
 * version; an absent tool reports the NOT_ASSESSED consequence so the persona
 * records a `sec_coverage_report status=not_assessed` row for that scanner.
 *
 * A string CONSTANT, not a file read — the api bundle needs no asset inlining.
 */
export const SEC_PREFLIGHT_SCRIPT = `#!/usr/bin/env bash
# sec-preflight — report which security scanners are present in this sandbox.
# One row per tool: <name>\\t<present y/n>\\t<version | consequence-when-absent>.
# Installed at cell start by the Valet Security scanner bootstrap. An absent
# tool means the bootstrap could not reach the network — record a
# sec_coverage_report status=not_assessed row for that scanner.
set -u

row() {
  # $1 name, $2 command, $3 version-flag, $4 consequence-when-absent
  local name="$1" cmd="$2" vflag="$3" consequence="$4"
  if command -v "$cmd" >/dev/null 2>&1; then
    local ver
    ver="$("$cmd" $vflag 2>&1 | head -n1)"
    printf '%s\\ty\\t%s\\n' "$name" "$ver"
  else
    printf '%s\\tn\\t%s\\n' "$name" "$consequence"
  fi
}

row gitleaks    gitleaks    version    "gitleaks absent -> secrets not scanned; record sec_coverage_report status=not_assessed"
row semgrep     semgrep     --version  "semgrep absent -> SAST not run; record sec_coverage_report status=not_assessed"
row trufflehog  trufflehog  --version  "trufflehog absent -> deep secret scan skipped; record sec_coverage_report status=not_assessed"
row bandit      bandit      --version  "bandit absent -> python SAST skipped; record sec_coverage_report status=not_assessed"
row gosec       gosec       -version   "gosec absent -> go SAST skipped; record sec_coverage_report status=not_assessed"
row brakeman    brakeman    --version  "brakeman absent -> ruby SAST skipped; record sec_coverage_report status=not_assessed"
row eslint      eslint      --version  "eslint absent -> js/ts lint SAST skipped; record sec_coverage_report status=not_assessed"
row cargo-audit cargo-audit --version  "cargo-audit absent -> rust dep audit skipped; record sec_coverage_report status=not_assessed"
`;

/** POSIX single-quote escaping for values interpolated into `sh` command
 * strings passed to `Sandbox.exec`. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Runs `sandbox.exec` and swallows a rejection into a resolved failed
 * result, so a network reject or a non-zero exit both stay best-effort. A
 * failure is logged; the caller resolves regardless. `critical: false` keeps
 * the sandbox alive either way. */
async function bestEffortExec(
  sandbox: Sandbox,
  label: string,
  command: string,
  opts?: { privileged?: boolean },
): Promise<void> {
  try {
    const result = await sandbox.exec(command, opts);
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim();
      console.warn(`security-bootstrap: ${label} exited ${result.exitCode}: ${detail}`);
    }
  } catch (err) {
    // Best-effort swallow: an absent tool is a NOT_ASSESSED row downstream,
    // and `critical: false` keeps the sandbox alive. Log and resolve.
    console.warn(
      `security-bootstrap: ${label} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Idempotence guard: install `<tool>` only when it is not already on PATH. */
function ifAbsent(tool: string, install: string): string {
  return `command -v ${tool} >/dev/null 2>&1 || ( ${install} )`;
}

/** Stable content hashes. A step whose `hash` is unchanged is a reconcile
 * no-op, so the ids and hashes are derived from the install content — bump the
 * pinned version or the script and the hash moves with it. */
const SEC_PREFLIGHT_HASH = `sec-preflight:${simpleHash(SEC_PREFLIGHT_SCRIPT)}`;
const GITLEAKS_HASH = `gitleaks:${GITLEAKS_VERSION}`;
const SEMGREP_HASH = `semgrep:${simpleHash(SEMGREP_INSTALL_COMMAND)}`;

/** Small deterministic content fingerprint (FNV-1a, 32-bit) — enough to make
 * a hash move when the script content changes. Not a security hash. */
function simpleHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The three best-effort scanner-install steps installed on EVERY security
 * cell sandbox. No cell/persona/playbook argument — the steps are identical
 * for every security cell, so every persona may assume the tools are present.
 *
 * Order: `sec-preflight` first (so the probe exists even if a scanner install
 * later fails), then gitleaks, then semgrep.
 */
export function securityToolPrepSteps(): import("@valet/engine").PrepStep[] {
  return [
    {
      id: "sec-preflight",
      hash: SEC_PREFLIGHT_HASH,
      critical: false,
      async apply(sandbox: Sandbox): Promise<void> {
        // Stage the script at a workspace-relative path (writeFile only
        // reliably targets workspace-relative), then exec it into
        // /usr/local/bin (privileged: /usr/local/bin needs root). Idempotent:
        // a re-run overwrites the same script and chmod is stable.
        await sandbox.mkdir(".valet-prep").catch(() => {});
        await sandbox
          .writeFile(PREFLIGHT_STAGING_PATH, SEC_PREFLIGHT_SCRIPT)
          .catch((err: unknown) => {
            console.warn(
              "security-bootstrap: staging sec-preflight failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
        await bestEffortExec(
          sandbox,
          "install sec-preflight",
          `mkdir -p /usr/local/bin && cp ${shQuote(PREFLIGHT_STAGING_PATH)} ${PREFLIGHT_BIN_PATH} && chmod 755 ${PREFLIGHT_BIN_PATH}`,
          { privileged: true },
        );
      },
    },
    {
      id: "gitleaks",
      hash: GITLEAKS_HASH,
      critical: false,
      async apply(sandbox: Sandbox): Promise<void> {
        // Download the pinned static release for the sandbox's ARCH, extract,
        // and move the binary into /usr/local/bin (privileged). Idempotent via
        // `command -v`. Needs egress to github.com; if blocked, the step fails
        // best-effort and sec-preflight reports gitleaks absent. The arch is
        // read at run time (`uname -m`) because the sandbox may be x86_64 or
        // aarch64 — a hardcoded arch installs a binary that cannot execute.
        const install = [
          "set -e",
          'tmp="$(mktemp -d)"',
          'case "$(uname -m)" in aarch64|arm64) ga=arm64 ;; x86_64|amd64) ga=x64 ;; *) ga=x64 ;; esac',
          `curl -fsSL "${GITLEAKS_RELEASE_URL}/gitleaks_${GITLEAKS_VERSION}_linux_\${ga}.tar.gz" -o "$tmp/gitleaks.tar.gz"`,
          'tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks',
          'mv "$tmp/gitleaks" /usr/local/bin/gitleaks',
          "chmod 755 /usr/local/bin/gitleaks",
          'rm -rf "$tmp"',
        ].join("\n");
        await bestEffortExec(
          sandbox,
          "install gitleaks",
          ifAbsent("gitleaks", install),
          { privileged: true },
        );
      },
    },
    {
      id: "semgrep",
      hash: SEMGREP_HASH,
      critical: false,
      async apply(sandbox: Sandbox): Promise<void> {
        // Install semgrep via pip for the sandbox python (bookworm-slim needs
        // python3-pip + PEP 668 --break-system-packages). Idempotent via
        // `command -v`. Slow (apt + pip) is acceptable. Needs egress to the
        // apt mirror + pypi.org; if blocked, the step fails best-effort and
        // sec-preflight reports semgrep absent.
        await bestEffortExec(
          sandbox,
          "install semgrep",
          ifAbsent("semgrep", SEMGREP_INSTALL_COMMAND),
          { privileged: true },
        );
      },
    },
  ];
}
