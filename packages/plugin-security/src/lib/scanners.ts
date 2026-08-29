/**
 * The scanners the sandbox bootstrap installs or probes (§coverage honesty).
 *
 * `SEC_PREFLIGHT_SCRIPT` (packages/api/src/engine/security-bootstrap.ts) probes
 * exactly this set and tells an absent scanner to record a not_assessed
 * coverage gap. `reportCoverage` validates a claimed `tool` against this set so
 * "we scanned it with X" names a real scanner, not an invented one. Keep the
 * two lists in sync: a scanner added to the preflight probe belongs here too.
 */
export const KNOWN_SCANNERS: readonly string[] = [
  "gitleaks",
  "semgrep",
  "trufflehog",
  "bandit",
  "gosec",
  "brakeman",
  "eslint",
  "cargo-audit",
];

const KNOWN_SCANNER_SET = new Set(KNOWN_SCANNERS);

/**
 * True when `tool` names a known scanner. Case-insensitive; matches on the
 * first whitespace-delimited token, so a scanner with a rule pack or version
 * suffix ("semgrep p/owasp-top-ten", "gitleaks 8.18.0") still matches.
 */
export function isKnownScanner(tool: string): boolean {
  const firstToken = tool.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return KNOWN_SCANNER_SET.has(firstToken);
}
