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
] as const;

export type PlaybookName = (typeof KNOWN_PLAYBOOKS)[number];

export function isKnownPlaybook(name: string): name is PlaybookName {
  return (KNOWN_PLAYBOOKS as readonly string[]).includes(name);
}

const cache = new Map<string, string>();

/** The markdown for a known playbook. Throws on an unknown name. */
export function playbookMarkdown(name: string): string {
  if (!isKnownPlaybook(name)) {
    throw new Error(`Unknown playbook "${name}". Known playbooks: ${KNOWN_PLAYBOOKS.join(", ")}.`);
  }
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = readFileSync(
    fileURLToPath(new URL(`../../playbooks/${name}.md`, import.meta.url)),
    "utf8",
  );
  cache.set(name, text);
  return text;
}
