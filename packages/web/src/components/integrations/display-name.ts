/**
 * Friendly labels for plugin, service, and skill ids on `/integrations`
 * and `/skills`. Raw manifest names are lowercase package-ish ids
 * (`google-workspace`, `deepwiki`, `sandbox-tunnels`); people recognize
 * product names. Unknown ids fall back to title-cased words so a
 * dropped-in third-party plugin or skill still reads like a name, not an
 * identifier.
 */
const DISPLAY_NAMES: Record<string, string> = {
  github: "GitHub",
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  google_calendar: "Google Calendar",
  "google-workspace": "Google Workspace",
  google_workspace: "Google Workspace",
  slack: "Slack",
  cloudflare: "Cloudflare",
  deepwiki: "DeepWiki",
  linear: "Linear",
  notion: "Notion",
  sentry: "Sentry",
  stripe: "Stripe",
  typefully: "Typefully",
  figma: "Figma",
  browser: "Browser",
  workflows: "Workflows",
  "sandbox-tunnels": "Sandbox tunnels",
  personas: "Personas",
  telegram: "Telegram",
};

/** Config-declared MCP plugins are named `mcp-config:<entry>` (see
 * packages/api/src/plugins/config-mcp.ts). The prefix is a dedupe guard,
 * not a name — strip it before deriving a label. */
const MCP_CONFIG_PREFIX = "mcp-config:";

export function displayName(id: string): string {
  const known = DISPLAY_NAMES[id];
  if (known) return known;
  // A config-declared MCP id names a product, so every word capitalizes —
  // matching the server's own fallback (titleCaseSlug in config-mcp.ts).
  // Other unknown ids (skills, first-party plugins) keep sentence case.
  if (id.startsWith(MCP_CONFIG_PREFIX)) {
    return id
      .slice(MCP_CONFIG_PREFIX.length)
      .split(/[-_]/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** The card title for a plugin: the manifest's own `displayName` when it
 * declares one (config-declared MCP servers do), else the id-derived label. */
export function pluginDisplayName(plugin: { name: string; displayName?: string }): string {
  return plugin.displayName ?? displayName(plugin.name);
}
