import { parse } from "yaml";
import { isKnownCategory, KNOWN_CATEGORIES } from "./categories.js";
import { parsePlan, type PlanCell } from "./plan.js";
import { serializePlan } from "./presets.js";

/**
 * The `.valet/security.yml` schema (dynamic-config M-F1, spec §Dynamic
 * configuration). A scanned repo commits this file to configure its own
 * review: the ordered steps, the focus, the known invariants, the threat
 * categories, repo-defined personas, and the declared tools. Valet fetches it
 * through the GitHub contents API at create time and seeds the plan from it,
 * with the bundled presets as the fallback.
 *
 * M-F1 parses, stores, and exposes every field. Only `steps` feed the plan
 * this milestone; `focus`, `invariants`, `categories`, `personas`, and `tools`
 * are stored on the engagement for later milestones (M-F3 invariants, M-P2a
 * categories, M-P4 tools). Nothing here wires them into prompts yet.
 */
export interface SecurityConfig {
  /** Schema version. Must be 1. */
  version: number;
  /** Free-text focus note, folded into the review at start (M-F3). */
  focus?: string;
  /** Known invariants the team already holds (M-F3). */
  invariants?: string[];
  /** Threat category names to load (M-P2a). */
  categories?: string[];
  /** Repo-defined personas: id → the path of the persona's markdown in the
   * clone (for example `.claude/agents/threat-model.md`). A step may name one
   * of these keys as its persona. */
  personas?: Record<string, string>;
  /** The ordered review steps. Seed the plan from these when present. */
  steps?: PlanCell[];
  /** Declared tools a step needs (M-P4). */
  tools?: string[];
}

const CORRECTIVE = "Fix .valet/security.yml and commit it, or remove it to use a preset.";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Parse and validate `.valet/security.yml`. Throws an Error with a corrective
 * message on the first violation. `knownPersonas` is the bundled persona
 * registry; a step's `persona` must be a bundled id OR a key in the config's
 * own `personas` map. The steps validate through `parsePlan`'s cell rules
 * (dense ordinals, earlier-only reads, known playbooks) against the union of
 * both persona sources.
 */
export function parseSecurityConfig(yaml: string, knownPersonas: readonly string[]): SecurityConfig {
  let raw: unknown;
  try {
    raw = parse(yaml);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`.valet/security.yml is not valid YAML (${detail}). ${CORRECTIVE}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`.valet/security.yml must be a YAML map. ${CORRECTIVE}`);
  }
  const map = raw as Record<string, unknown>;

  if (map.version !== 1) {
    throw new Error(
      `.valet/security.yml needs "version: 1"; found ${JSON.stringify(map.version)}. ${CORRECTIVE}`,
    );
  }

  const config: SecurityConfig = { version: 1 };

  if (map.focus !== undefined) {
    if (typeof map.focus !== "string") {
      throw new Error(`.valet/security.yml "focus" must be text. ${CORRECTIVE}`);
    }
    config.focus = map.focus;
  }

  if (map.invariants !== undefined) {
    if (!isStringArray(map.invariants)) {
      throw new Error(`.valet/security.yml "invariants" must be a list of strings. ${CORRECTIVE}`);
    }
    config.invariants = map.invariants;
  }

  if (map.categories !== undefined) {
    if (!isStringArray(map.categories)) {
      throw new Error(`.valet/security.yml "categories" must be a list of strings. ${CORRECTIVE}`);
    }
    const unknown = map.categories.filter((id) => !isKnownCategory(id));
    if (unknown.length > 0) {
      throw new Error(
        `.valet/security.yml names unknown threat categor${unknown.length === 1 ? "y" : "ies"} ` +
          `${unknown.map((id) => `"${id}"`).join(", ")}. Known categories: ${KNOWN_CATEGORIES.join(", ")}. ${CORRECTIVE}`,
      );
    }
    config.categories = map.categories;
  }

  if (map.tools !== undefined) {
    if (!isStringArray(map.tools)) {
      throw new Error(`.valet/security.yml "tools" must be a list of strings. ${CORRECTIVE}`);
    }
    config.tools = map.tools;
  }

  let personaKeys: string[] = [];
  if (map.personas !== undefined) {
    if (
      typeof map.personas !== "object" ||
      map.personas === null ||
      Array.isArray(map.personas)
    ) {
      throw new Error(
        `.valet/security.yml "personas" must be a map of id to markdown path. ${CORRECTIVE}`,
      );
    }
    const personas: Record<string, string> = {};
    for (const [id, value] of Object.entries(map.personas as Record<string, unknown>)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `.valet/security.yml persona "${id}" must map to a non-empty markdown path. ${CORRECTIVE}`,
        );
      }
      personas[id] = value;
    }
    config.personas = personas;
    personaKeys = Object.keys(personas);
  }

  if (map.steps !== undefined) {
    // Reuse the plan validator: a step is a plan cell. The persona set is the
    // union of bundled ids and repo-declared persona keys, so a step may name
    // either. parsePlan wants a YAML string, so re-serialize the steps map.
    if (!Array.isArray(map.steps) || map.steps.length === 0) {
      throw new Error(`.valet/security.yml "steps" must be a non-empty list. ${CORRECTIVE}`);
    }
    const allPersonas = [...knownPersonas, ...personaKeys];
    let plan;
    try {
      plan = parsePlan(stepsToPlanYaml(map.steps), allPersonas);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`.valet/security.yml "steps" are not a valid plan: ${detail}`);
    }
    config.steps = plan.cells;
  }

  return config;
}

/** Serialize a raw `steps` list back to plan YAML so `parsePlan` can validate
 * it. The steps arrive already parsed from the config YAML, so this is a
 * round-trip through the YAML serializer, not hand-written text. */
function stepsToPlanYaml(steps: unknown[]): string {
  return JSON.stringify({ cells: steps });
}

/**
 * Serialize a config's steps to plan YAML (the engagement plan the create
 * route seeds). Throws when the config declares no steps — a config without
 * steps still configures focus/invariants/etc., but the caller must fall back
 * to a preset plan, not call this.
 */
export function configToPlanYaml(config: SecurityConfig): string {
  if (!config.steps || config.steps.length === 0) {
    throw new Error(".valet/security.yml declares no steps; use a preset plan instead.");
  }
  return serializePlan(config.steps);
}
