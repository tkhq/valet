/**
 * DesignSystemProvider port, v1 `codebase` implementation (spec §Ports).
 *
 * The design system is read from files the team already ships:
 *
 *   - `design-tokens.json` at the repository root — flat name→value map,
 *     or `{ "tokens": { ... } }`
 *   - `components.index.json` — component name → export path map
 *   - fallback: any `:root { --x: y }` rules in a CSS file the caller
 *     hands over
 *
 * The reader is a port (`DesignSystemSource`) so callers decide where
 * bytes come from — GitHub contents API, the session sandbox, or a test
 * fixture. Missing files degrade to an empty system, never a throw: a
 * design session without a design system is fine.
 */

export interface DesignSystem {
  /** CSS custom-property map, keys with leading `--`. */
  tokens: Record<string, string>;
  /** Component name → source path map. NEVER shipped on share links. */
  components: Record<string, string>;
}

export interface DesignSystemSource {
  /** Return file content, or null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
}

function normalizeTokenName(name: string): string {
  return name.startsWith("--") ? name : `--${name}`;
}

/** Parse a design-tokens.json body. Accepts a flat map or `{ tokens: map }`. */
export function parseDesignTokens(json: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const container = parsed as Record<string, unknown>;
  const source =
    typeof container.tokens === "object" && container.tokens !== null
      ? (container.tokens as Record<string, unknown>)
      : container;
  const tokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" || typeof value === "number") {
      tokens[normalizeTokenName(key)] = String(value);
    }
  }
  return tokens;
}

/** Extract `--name: value` declarations from `:root { ... }` blocks. */
export function parseRootCustomProperties(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const rootRe = /:root\s*\{([^}]*)\}/g;
  let block: RegExpExecArray | null;
  while ((block = rootRe.exec(css)) !== null) {
    const declRe = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);?/g;
    let decl: RegExpExecArray | null;
    while ((decl = declRe.exec(block[1])) !== null) {
      tokens[decl[1]] = decl[2].trim();
    }
  }
  return tokens;
}

export interface LoadDesignSystemOpts {
  /** Extra CSS paths to scan for `:root` custom properties when
   * design-tokens.json is absent. */
  cssFallbackPaths?: string[];
}

export async function loadDesignSystem(
  source: DesignSystemSource,
  opts: LoadDesignSystemOpts = {},
): Promise<DesignSystem> {
  const system: DesignSystem = { tokens: {}, components: {} };

  const tokensJson = await source.readFile("design-tokens.json");
  if (tokensJson !== null) {
    system.tokens = parseDesignTokens(tokensJson);
  } else {
    for (const path of opts.cssFallbackPaths ?? []) {
      const css = await source.readFile(path);
      if (css !== null) Object.assign(system.tokens, parseRootCustomProperties(css));
    }
  }

  const componentsJson = await source.readFile("components.index.json");
  if (componentsJson !== null) {
    try {
      const parsed: unknown = JSON.parse(componentsJson);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [name, path] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof path === "string") system.components[name] = path;
        }
      }
    } catch {
      // Malformed index degrades to no components.
    }
  }

  return system;
}
