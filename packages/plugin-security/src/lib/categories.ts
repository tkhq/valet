import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * The threat-category library (categories/*.yml, dynamic-config M-P2a, spec
 * §Threat-category library). Each category is a domain threat-pattern library:
 * the concrete attack patterns a persona reviewing a repo in that domain must
 * check against, grounded in CWE and CAPEC. Modeled on Akshar's pentest
 * harness `.claude/threat-model-categories/*.yml`.
 *
 * The engagement config (`.valet/security.yml`) and the panel name which
 * categories to load; `categoryDigest` folds the loaded categories into every
 * persona dispatch alongside the invariants (M-F3), so a persona has the
 * domain's known attack surface in front of it.
 *
 * A category id in the config is validated against KNOWN_CATEGORIES, so an
 * unknown name is a config error, never a missing-file read at dispatch time.
 */
export const KNOWN_CATEGORIES = [
  "authz",
  "authn",
  "multi-tenancy",
  "key-management",
  "crypto-wallets",
  "secrets-handling",
  "policy-engines",
  "webhooks",
  "parsers",
  "state-machines",
] as const;

export type CategoryId = (typeof KNOWN_CATEGORIES)[number];

export function isKnownCategory(id: string): id is CategoryId {
  return (KNOWN_CATEGORIES as readonly string[]).includes(id);
}

/** One threat pattern within a category: a named attack pattern with its
 * CWE/CAPEC identifiers and what to look for in the code. `cwe`, `capec`, and
 * `mitreAttack` are null when the pattern has no matching public identifier. */
export interface ThreatPattern {
  id: string;
  description: string;
  cwe: string | null;
  capec: string | null;
  mitreAttack: string | null;
  skill: string | null;
  likelihood: string | null;
  prereqs: string[];
  lookFor: string[];
}

/** A parsed threat category. `dedup` names the ownership boundary against a
 * sibling category (which file owns which threat), absent on most. */
export interface ThreatCategory {
  id: string;
  name: string;
  detectWhen: string[];
  dedup?: string;
  threatPatterns: ThreatPattern[];
}

const cache = new Map<string, string>();
const parsedCache = new Map<string, ThreatCategory>();

// One STATIC single-call `readFileSync(new URL("<literal>", import.meta.url),
// "utf8")` per category id — the ONLY shape the api bundle's inline-assets step
// can embed. A dynamic `../../categories/${id}.yml` template, or a read that
// indexes a `Record<id, URL>`, is NOT matched by the inliner, so it survives to
// the bundle and resolves against the bundle's own dir at runtime (a broken
// read). The `.yml` extension is in the inliner's ASSET_EXTS. The compiled
// module lives at dist/lib/, so `../../categories/` resolves to the package-root
// categories/ dir at runtime for the non-bundled (tsc) build.
function readCategoryYaml(id: CategoryId): string {
  switch (id) {
    case "authz":
      return readFileSync(new URL("../../categories/authz.yml", import.meta.url), "utf8");
    case "authn":
      return readFileSync(new URL("../../categories/authn.yml", import.meta.url), "utf8");
    case "multi-tenancy":
      return readFileSync(new URL("../../categories/multi-tenancy.yml", import.meta.url), "utf8");
    case "key-management":
      return readFileSync(new URL("../../categories/key-management.yml", import.meta.url), "utf8");
    case "crypto-wallets":
      return readFileSync(new URL("../../categories/crypto-wallets.yml", import.meta.url), "utf8");
    case "secrets-handling":
      return readFileSync(new URL("../../categories/secrets-handling.yml", import.meta.url), "utf8");
    case "policy-engines":
      return readFileSync(new URL("../../categories/policy-engines.yml", import.meta.url), "utf8");
    case "webhooks":
      return readFileSync(new URL("../../categories/webhooks.yml", import.meta.url), "utf8");
    case "parsers":
      return readFileSync(new URL("../../categories/parsers.yml", import.meta.url), "utf8");
    case "state-machines":
      return readFileSync(new URL("../../categories/state-machines.yml", import.meta.url), "utf8");
  }
}

/** The raw YAML for a known category. Throws on an unknown id. */
export function categoryYaml(id: string): string {
  if (!isKnownCategory(id)) {
    throw new Error(
      `Unknown threat category "${id}". Known categories: ${KNOWN_CATEGORIES.join(", ")}.`,
    );
  }
  const hit = cache.get(id);
  if (hit !== undefined) return hit;
  const text = readCategoryYaml(id);
  cache.set(id, text);
  return text;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Parse a known category's YAML into the typed shape. Throws on an unknown id
 * or a malformed file (a bundled asset, so a parse failure is a ship bug). */
export function parseCategory(id: string): ThreatCategory {
  const hit = parsedCache.get(id);
  if (hit !== undefined) return hit;
  const yaml = categoryYaml(id);
  const raw: unknown = parse(yaml);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Threat category "${id}" is not a YAML map.`);
  }
  const map = raw as Record<string, unknown>;
  const name = typeof map.name === "string" && map.name.trim() !== "" ? map.name : id;

  const patternsRaw = map.threat_patterns;
  const threatPatterns: ThreatPattern[] = [];
  if (typeof patternsRaw === "object" && patternsRaw !== null && !Array.isArray(patternsRaw)) {
    for (const [patternId, value] of Object.entries(patternsRaw as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const p = value as Record<string, unknown>;
      threatPatterns.push({
        id: patternId,
        description: typeof p.description === "string" ? p.description : "",
        cwe: asStringOrNull(p.cwe),
        capec: asStringOrNull(p.capec),
        mitreAttack: asStringOrNull(p.mitre_attack),
        skill: asStringOrNull(p.skill),
        likelihood: asStringOrNull(p.likelihood),
        prereqs: asStringArray(p.prereqs),
        lookFor: asStringArray(p.look_for),
      });
    }
  }

  const category: ThreatCategory = {
    id,
    name,
    detectWhen: asStringArray(map.detect_when),
    threatPatterns,
  };
  const dedup = asStringOrNull(map.dedup);
  if (dedup !== null) category.dedup = dedup;

  parsedCache.set(id, category);
  return category;
}

/** Human-readable pattern id: `credential_stuffing` → `credential stuffing`. */
function patternLabel(id: string): string {
  return id.replace(/_/g, " ");
}

/** A compact markdown digest of the named categories' threat patterns, for
 * prompt injection (M-P2a). One heading per category, then one line per
 * pattern: `<pattern>: <description> (CWE-x, CAPEC-y) — look for: <first
 * look_for items>`. Unknown ids are skipped, so a stale config never throws
 * here. Bounded: at most the first three `look_for` items per pattern, so a
 * ten-category load stays a scannable brief, not a full library dump. */
export function categoryDigest(ids: string[]): string {
  const known = ids.filter(isKnownCategory);
  if (known.length === 0) return "";
  const lines: string[] = [];
  for (const id of known) {
    const category = parseCategory(id);
    lines.push(`### ${category.name}`);
    if (category.dedup) lines.push(`Ownership: ${category.dedup}`);
    for (const pattern of category.threatPatterns) {
      const refs = [pattern.cwe, pattern.capec].filter((r): r is string => r !== null);
      const refPart = refs.length > 0 ? ` (${refs.join(", ")})` : "";
      const lookFor = pattern.lookFor.slice(0, 3);
      const lookPart = lookFor.length > 0 ? ` — look for: ${lookFor.join("; ")}` : "";
      lines.push(`- ${patternLabel(pattern.id)}: ${pattern.description}${refPart}${lookPart}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
