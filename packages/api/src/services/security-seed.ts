/**
 * Seed a security review's config + plan from a repo's `.valet/security.yml`,
 * with the sweep preset as the fallback (dynamic-config M-F1, spec §Dynamic
 * configuration). ONE owner of the create-time seeding logic.
 *
 * The setup page's preview endpoint (`POST /api/sessions/security/preview`) and
 * the session-create route both call `seedSecurityReview`, so a preview shows
 * exactly what create would seed. The function reads the config through the
 * GitHub contents API BEFORE any sandbox exists; a public repo needs no token.
 *
 * Behavior, identical to the create route's old inline block:
 *   - A valid config with steps seeds the plan from the steps.
 *   - A valid config with no steps keeps the preset plan but carries the
 *     config's focus / invariants / categories / personas / tools / scope.
 *   - An absent, malformed, or unreadable config falls back to the preset plan;
 *     `hasRepoConfig` is false and the config fields are null/empty.
 *   - Repo-declared persona role markdown resolves from the clone at seed time;
 *     a missing/unreadable file is skipped with a note.
 */
import {
  bundledPersonaIds,
  configToPlanYaml,
  parseSecurityConfig,
  presetPlan,
  type SecurityConfig,
  type SecurityScope,
  type ToolDecl,
} from "@valet/plugin-security";
import { fetchRepoFile, resolveApiTokenOrNull } from "../bakes/source-service.js";
import type { GitHubTokenDeps } from "../services/github-tokens.js";

export interface SeedSecurityReviewArgs {
  /** The repo owner (the `owner` half of `owner/repo`). */
  owner: string;
  /** The repo name (the `repo` half of `owner/repo`). */
  repo: string;
  /** Optional branch / tag / SHA to read the config at. Omit for the default
   * branch HEAD. */
  ref?: string;
  /** The sweep preset id, the plan fallback when the repo has no config steps. */
  presetId: string;
  /** Optional include globs the preset sweeps scope to. */
  paths?: string[];
  /** "Include a written report at the end" (Part 08 §Setup Step 1). When
   * present, the seeded preset plan appends or skips the report cell. When
   * absent, `presetPlan` falls to the preset's own default per
   * `presetReportDefault`. */
  includeReport?: boolean;
  /** GitHub token resolution deps (db + credentials + key). */
  tokenDeps: GitHubTokenDeps;
  /** The owning org, for `resolveApiTokenOrNull`. */
  orgId: string;
}

/** The seeded config + plan a preview shows and a create stores. */
export interface SeededSecurityReview {
  /** The plan YAML: the config's steps, or the preset fallback. */
  planYaml: string;
  focus: string | null;
  invariants: string[];
  categories: string[];
  /** Repo-defined personas: id → the markdown path in the clone. Null when
   * absent. */
  personas: Record<string, string> | null;
  /** Repo-defined persona role markdown, resolved from the clone. Null when
   * absent. */
  configPersonaMarkdown: Record<string, string> | null;
  /** Declared tools (M-P4a). Null when absent. */
  tools: ToolDecl[] | null;
  /** The authorized live-testing scope (M-P4b). Null when absent. */
  scope: SecurityScope | null;
  /** True when a valid `.valet/security.yml` seeded this review. */
  hasRepoConfig: boolean;
}

/**
 * Seed the config + plan a security review starts from. Never throws for a
 * missing / malformed / unreadable config — it falls back to the preset plan
 * and records `hasRepoConfig: false`. A malformed preset id DOES throw
 * (`presetPlan`), because the caller validated it first.
 */
export async function seedSecurityReview(args: SeedSecurityReviewArgs): Promise<SeededSecurityReview> {
  const { owner, repo, ref, presetId, paths, includeReport, tokenDeps, orgId } = args;

  const result: SeededSecurityReview = {
    planYaml: presetPlan(presetId, {
      ...(paths ? { paths } : {}),
      ...(includeReport !== undefined ? { includeReport } : {}),
    }),
    focus: null,
    invariants: [],
    categories: [],
    personas: null,
    configPersonaMarkdown: null,
    tools: null,
    scope: null,
    hasRepoConfig: false,
  };

  try {
    const token = await resolveApiTokenOrNull(tokenDeps, orgId, owner, repo);
    const raw = await fetchRepoFile(tokenDeps, token, owner, repo, ".valet/security.yml", ref);
    if (raw === null) return result;

    const config: SecurityConfig = parseSecurityConfig(raw, bundledPersonaIds());
    result.hasRepoConfig = true;
    result.focus = config.focus ?? null;
    result.invariants = config.invariants ?? [];
    result.categories = config.categories ?? [];
    result.personas = config.personas ?? null;
    result.tools = config.tools ?? null;
    result.scope = config.scope ?? null;

    // A config with steps seeds the plan; a config with no steps keeps the
    // preset plan but still carries the config context above.
    if (config.steps && config.steps.length > 0) {
      result.planYaml = configToPlanYaml(config);
    }

    // Repo-defined persona roles (M-P2c): resolve each persona's markdown from
    // the clone. A missing / empty / unreadable file is skipped with a note;
    // the host then falls back to the code-review role for that persona.
    if (config.personas && Object.keys(config.personas).length > 0) {
      const resolved: Record<string, string> = {};
      for (const [personaId, personaPath] of Object.entries(config.personas)) {
        try {
          const md = await fetchRepoFile(tokenDeps, token, owner, repo, personaPath, ref);
          if (md !== null && md.trim() !== "") {
            resolved[personaId] = md;
          } else {
            console.warn(
              `security seed: repo persona "${personaId}" file "${personaPath}" is empty or missing; ` +
                "the host will fall back to the code-review role for it.",
            );
          }
        } catch (fetchErr) {
          const m = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          console.warn(
            `security seed: repo persona "${personaId}" file "${personaPath}" is unreadable (${m}); ` +
              "the host will fall back to the code-review role for it.",
          );
        }
      }
      if (Object.keys(resolved).length > 0) result.configPersonaMarkdown = resolved;
    }
  } catch (err) {
    // A missing, malformed, or unreadable config is not a failure — fall back to
    // the preset plan and record why. Reset any partial config state.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`security seed: .valet/security.yml ignored for ${owner}/${repo}: ${message}`);
    result.hasRepoConfig = false;
    result.focus = null;
    result.invariants = [];
    result.categories = [];
    result.personas = null;
    result.configPersonaMarkdown = null;
    result.tools = null;
    result.scope = null;
    result.planYaml = presetPlan(presetId, {
      ...(paths ? { paths } : {}),
      ...(includeReport !== undefined ? { includeReport } : {}),
    });
  }

  return result;
}

/** Build the `SecurityConfigContext` the engagement service stores from a seeded
 * review plus optional user overrides from the setup page. The user edits
 * focus / invariants / categories; the repo-committed tools / scope / personas
 * stay from the seed. Returns undefined only when nothing configures the
 * engagement (a preset-only review with no overrides), so the engagement records
 * `has_repo_config = false`. */
export function seededConfigContext(
  seeded: SeededSecurityReview,
  overrides?: {
    focus?: string | null;
    invariants?: string[];
    categories?: string[];
    /** Setup-page scope override (Part 08 §Setup Step 1). A non-null value
     * with non-empty hosts wins over the repo-seeded scope; null clears the
     * override and falls back to seed. Empty hosts array is not accepted at
     * this seam (rejected by the create-route validator). */
    scope?: SecurityScope | null;
  },
): {
  focus?: string;
  invariants?: string[];
  categories?: string[];
  personas?: Record<string, string>;
  personaMarkdown?: Record<string, string>;
  tools?: ToolDecl[];
  scope?: SecurityScope;
} | undefined {
  const focusRaw = overrides && "focus" in overrides ? overrides.focus : seeded.focus;
  const focus = focusRaw?.trim() ? focusRaw.trim() : undefined;
  const invariants = (overrides?.invariants ?? seeded.invariants)
    .map((v) => v.trim())
    .filter((v) => v !== "");
  const categories = (overrides?.categories ?? seeded.categories)
    .map((v) => v.trim())
    .filter((v) => v !== "");

  const ctx: {
    focus?: string;
    invariants?: string[];
    categories?: string[];
    personas?: Record<string, string>;
    personaMarkdown?: Record<string, string>;
    tools?: ToolDecl[];
    scope?: SecurityScope;
  } = {};
  if (focus !== undefined) ctx.focus = focus;
  if (invariants.length > 0) ctx.invariants = invariants;
  if (categories.length > 0) ctx.categories = categories;
  if (seeded.personas) ctx.personas = seeded.personas;
  if (seeded.configPersonaMarkdown) ctx.personaMarkdown = seeded.configPersonaMarkdown;
  if (seeded.tools) ctx.tools = seeded.tools;
  // Setup-page scope override (Part 08 §Setup Step 1) wins over the repo seed
  // when present with non-empty hosts. `null` explicitly clears the override
  // and falls back to the seed. Undefined leaves the seed untouched.
  if (overrides && "scope" in overrides) {
    const s = overrides.scope;
    if (s !== null && s !== undefined && Array.isArray(s.hosts) && s.hosts.length > 0) {
      ctx.scope = s;
    } else if (seeded.scope) {
      ctx.scope = seeded.scope;
    }
  } else if (seeded.scope) {
    ctx.scope = seeded.scope;
  }

  // The engagement records `has_repo_config` from `config !== undefined`. A
  // repo config OR any user override means "configured"; a bare preset with no
  // override returns undefined so the column stays false.
  const configured =
    seeded.hasRepoConfig ||
    ctx.focus !== undefined ||
    (ctx.invariants?.length ?? 0) > 0 ||
    (ctx.categories?.length ?? 0) > 0 ||
    (ctx.scope !== undefined && ctx.scope.hosts.length > 0);
  return configured ? ctx : undefined;
}
