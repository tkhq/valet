import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Methodology playbooks (playbooks/*.md), one per preset cell. Each is a
 * framework-grounded checklist (OWASP Top 10, API Security Top 10, ASVS,
 * WSTG, CWE, CVSS) telling a persona what to actually look for in its cell.
 * The API serves them read-only in the engagement tree at
 * /playbooks/<name>.md, and a cell's dispatch prompt names its playbook so
 * the persona reads it before starting. Read once per name, then cached.
 *
 * A plan cell's `playbook` field is validated against KNOWN_PLAYBOOKS, so an
 * unknown name is a plan error, never a missing-file read at dispatch time.
 */
export const KNOWN_PLAYBOOKS = [
  "recon",
  "authz",
  "injection",
  "secrets-config",
  "verify",
  "threat-model",
  "attack-tree",
  "sast",
  "report",
] as const;

export type PlaybookName = (typeof KNOWN_PLAYBOOKS)[number];

export function isKnownPlaybook(name: string): name is PlaybookName {
  return (KNOWN_PLAYBOOKS as readonly string[]).includes(name);
}

const cache = new Map<string, string>();

// The api bundle's inline-assets step only inlines a `readFileSync(new
// URL("<literal>", import.meta.url), "utf8")` whose literal sits AT the call
// site — a `${name}` template errors, and a Record-indexed URL is silently
// NOT inlined (a runtime read that fails in the single-file bundle). So each
// playbook is read by its own literal call in a switch.
function readPlaybook(name: PlaybookName): string {
  switch (name) {
    case "recon":
      return readFileSync(new URL("../../playbooks/recon.md", import.meta.url), "utf8");
    case "authz":
      return readFileSync(new URL("../../playbooks/authz.md", import.meta.url), "utf8");
    case "injection":
      return readFileSync(new URL("../../playbooks/injection.md", import.meta.url), "utf8");
    case "secrets-config":
      return readFileSync(new URL("../../playbooks/secrets-config.md", import.meta.url), "utf8");
    case "verify":
      return readFileSync(new URL("../../playbooks/verify.md", import.meta.url), "utf8");
    case "threat-model":
      return readFileSync(new URL("../../playbooks/threat-model.md", import.meta.url), "utf8");
    case "attack-tree":
      return readFileSync(new URL("../../playbooks/attack-tree.md", import.meta.url), "utf8");
    case "sast":
      return readFileSync(new URL("../../playbooks/sast.md", import.meta.url), "utf8");
    case "report":
      return readFileSync(new URL("../../playbooks/report.md", import.meta.url), "utf8");
  }
}

/** The markdown for a known playbook. Throws on an unknown name. */
export function playbookMarkdown(name: string): string {
  if (!isKnownPlaybook(name)) {
    throw new Error(`Unknown playbook "${name}". Known playbooks: ${KNOWN_PLAYBOOKS.join(", ")}.`);
  }
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readPlaybook(name);
  cache.set(name, text);
  return text;
}
