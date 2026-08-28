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
 * M-F1 parses `focus`, `invariants`, `categories`, `personas`, `steps`.
 * M-P4a firms up `tools` into structured `ToolDecl`s and adds `scope` (the
 * authorized live-testing hosts). `steps` seed the plan; the rest are stored on
 * the engagement for the milestone that consumes them (M-F3 invariants, M-P2a
 * categories, M-P4a tools + provisioning, M-P4b live personas + scope).
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
  /** Declared tools a step needs (M-P4a). Each item normalizes to a `ToolDecl`,
   * so a bare string `gitleaks` becomes `{ id: "gitleaks" }`. */
  tools?: ToolDecl[];
  /** The authorized live-testing scope (M-P4b): the hosts the live personas
   * (dast/fuzz/exploit) may reach. A live persona must NEVER act outside this
   * scope, and a declared tool's egress must fall inside it. Absent means no
   * live testing is authorized — the dispatch prompt says so, and a live
   * persona has no target. */
  scope?: SecurityScope;
}

/**
 * One declared tool a step needs (M-P4a). The mechanism accepts the decl; the
 * host provisions it. `id` is the only required field.
 *
 *   - `install` — a shell command the sandbox prep runs to install the tool
 *     (a per-repo install path; a common tool is baked into the image instead).
 *   - `image` — a container image the tool runs from (provisioning DATA the
 *     mechanism records; wiring a specific scanner container is deferred).
 *   - `mcp` — an MCP server the host wires into the persona child's tool set
 *     (a URL, plus the tool-name prefix the server's tools carry).
 *   - `egress` — the hosts the tool needs to reach. Every egress host MUST be
 *     within the engagement's authorized `scope`; `parseSecurityConfig` refuses
 *     a decl whose egress escapes scope.
 */
export interface ToolDecl {
  /** The tool id (a short name: `gitleaks`, `nuclei`, `zap`). */
  id: string;
  /** A shell command that installs the tool at sandbox prep (optional). */
  install?: string;
  /** A container image the tool runs from (optional; recorded, not yet run). */
  image?: string;
  /** An MCP server to wire into the persona child (optional). */
  mcp?: McpToolDecl;
  /** Hosts the tool reaches. Must be within the authorized scope (optional). */
  egress?: string[];
}

/** An MCP server a declared tool attaches (M-P4a). The host wires it into the
 * persona child's tool set through the same MCP client other plugins use. */
export interface McpToolDecl {
  /** The MCP server URL the client connects to. */
  url: string;
  /** The prefix the server's tools carry in the child's tool list (for example
   * `mcp__nuclei__`). Defaults to the tool id when absent. */
  prefix?: string;
}

/** The authorized live-testing scope (M-P4b): the hosts the live personas may
 * hit, human-declared in `.valet/security.yml`. A live finding or action
 * outside these hosts is forbidden by the persona role and by the egress gate. */
export interface SecurityScope {
  /** The authorized hosts (bare host or host:port; no scheme). A live persona
   * probes ONLY these. At least one host when `scope` is present. */
  hosts: string[];
}

const CORRECTIVE = "Fix .valet/security.yml and commit it, or remove it to use a preset.";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Normalize an authorized-scope host to a bare host for the egress check: drop
 * a scheme, a path, and surrounding whitespace, keep an explicit port. So
 * `https://api.example.com/v1` and `api.example.com` both compare as
 * `api.example.com`. Returns "" for an empty or malformed value. */
export function normalizeScopeHost(raw: string): string {
  let host = raw.trim();
  if (host === "") return "";
  const scheme = host.indexOf("://");
  if (scheme !== -1) host = host.slice(scheme + 3);
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  return host.toLowerCase();
}

/** True when `egressHost` is inside the authorized scope: its normalized host
 * equals an authorized host, OR is a subdomain of one (so `scope: example.com`
 * covers `api.example.com`). An empty scope host list authorizes nothing. */
export function egressHostInScope(egressHost: string, scopeHosts: readonly string[]): boolean {
  const host = normalizeScopeHost(egressHost);
  if (host === "") return false;
  return scopeHosts.some((s) => {
    const authorized = normalizeScopeHost(s);
    if (authorized === "") return false;
    if (host === authorized) return true;
    // Subdomain match: strip an authorized port before the suffix check.
    const bare = authorized.split(":")[0];
    return bare !== "" && host.endsWith(`.${bare}`);
  });
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

  // Authorized live-testing scope (M-P4b). Parse it before tools so a declared
  // tool's egress can validate against it.
  let scopeHosts: string[] = [];
  if (map.scope !== undefined) {
    if (typeof map.scope !== "object" || map.scope === null || Array.isArray(map.scope)) {
      throw new Error(
        `.valet/security.yml "scope" must be a map with a "hosts" list. ${CORRECTIVE}`,
      );
    }
    const rawHosts = (map.scope as Record<string, unknown>).hosts;
    if (!isStringArray(rawHosts) || rawHosts.length === 0) {
      throw new Error(
        `.valet/security.yml "scope.hosts" must be a non-empty list of authorized hosts. ${CORRECTIVE}`,
      );
    }
    scopeHosts = rawHosts.map((h) => h.trim()).filter((h) => h !== "");
    if (scopeHosts.length === 0) {
      throw new Error(
        `.valet/security.yml "scope.hosts" must name at least one authorized host. ${CORRECTIVE}`,
      );
    }
    config.scope = { hosts: scopeHosts };
  }

  if (map.tools !== undefined) {
    config.tools = parseToolDecls(map.tools, scopeHosts);
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

/**
 * Parse and validate the `tools` list into `ToolDecl`s (M-P4a). Each item is a
 * bare string (a tool id, no install/mcp/egress) OR a map with `id` and the
 * optional `install`/`image`/`mcp`/`egress` fields. Every declared egress host
 * MUST be within the authorized `scope.hosts`; a decl whose egress escapes
 * scope is a config error, so live tooling can never be told to reach a host
 * the human never authorized.
 */
export function parseToolDecls(value: unknown, scopeHosts: readonly string[]): ToolDecl[] {
  if (!Array.isArray(value)) {
    throw new Error(`.valet/security.yml "tools" must be a list. ${CORRECTIVE}`);
  }
  return value.map((raw, i) => parseToolDecl(raw, i, scopeHosts));
}

function parseToolDecl(raw: unknown, index: number, scopeHosts: readonly string[]): ToolDecl {
  const where = `.valet/security.yml tools[${index}]`;
  if (typeof raw === "string") {
    const id = raw.trim();
    if (id === "") throw new Error(`${where} must be a non-empty tool id. ${CORRECTIVE}`);
    return { id };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where} must be a tool id or a map with an "id". ${CORRECTIVE}`);
  }
  const map = raw as Record<string, unknown>;
  if (typeof map.id !== "string" || map.id.trim() === "") {
    throw new Error(`${where} must have a non-empty "id". ${CORRECTIVE}`);
  }
  const decl: ToolDecl = { id: map.id.trim() };
  if (map.install !== undefined) {
    if (typeof map.install !== "string" || map.install.trim() === "") {
      throw new Error(`${where} "install" must be a non-empty command. ${CORRECTIVE}`);
    }
    decl.install = map.install;
  }
  if (map.image !== undefined) {
    if (typeof map.image !== "string" || map.image.trim() === "") {
      throw new Error(`${where} "image" must be a non-empty image ref. ${CORRECTIVE}`);
    }
    decl.image = map.image.trim();
  }
  if (map.mcp !== undefined) {
    if (typeof map.mcp !== "object" || map.mcp === null || Array.isArray(map.mcp)) {
      throw new Error(`${where} "mcp" must be a map with a "url". ${CORRECTIVE}`);
    }
    const mcp = map.mcp as Record<string, unknown>;
    if (typeof mcp.url !== "string" || mcp.url.trim() === "") {
      throw new Error(`${where} "mcp.url" must be a non-empty URL. ${CORRECTIVE}`);
    }
    const mcpDecl: McpToolDecl = { url: mcp.url.trim() };
    if (mcp.prefix !== undefined) {
      if (typeof mcp.prefix !== "string" || mcp.prefix.trim() === "") {
        throw new Error(`${where} "mcp.prefix" must be a non-empty string. ${CORRECTIVE}`);
      }
      mcpDecl.prefix = mcp.prefix.trim();
    }
    decl.mcp = mcpDecl;
  }
  if (map.egress !== undefined) {
    if (!isStringArray(map.egress)) {
      throw new Error(`${where} "egress" must be a list of hosts. ${CORRECTIVE}`);
    }
    const egress = map.egress.map((h) => h.trim()).filter((h) => h !== "");
    // Scoped-egress gate (M-P4b): a declared egress host must sit within the
    // authorized scope. Refuse a tool that would reach outside it, so live
    // tooling is never told to hit a host the human never authorized.
    for (const host of egress) {
      if (!egressHostInScope(host, scopeHosts)) {
        const authorized = scopeHosts.length > 0 ? scopeHosts.join(", ") : "(none declared)";
        throw new Error(
          `${where} egress host "${host}" is outside the authorized scope [${authorized}]. ` +
            "Add the host to scope.hosts, or remove it from the tool's egress. " +
            CORRECTIVE,
        );
      }
    }
    if (egress.length > 0) decl.egress = egress;
  }
  return decl;
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
