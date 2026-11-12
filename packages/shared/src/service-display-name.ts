/**
 * Friendly labels for plugin, service, and skill ids — the one map both the
 * server and the client read.
 *
 * Raw manifest names are lowercase package-ish ids (`google-workspace`,
 * `deepwiki`, `sandbox-tunnels`); people recognize product names. Unknown
 * ids fall back to title-cased words so a dropped-in third-party plugin or
 * skill still reads like a name, not an identifier.
 *
 * Two callers need the same answer and must never disagree: `/integrations`
 * and `/skills` label their cards from it, and the credential refusals in
 * `routes/credentials.ts` drop the label into a sentence. A second copy in
 * `packages/web` drifted once already (nine entries against twenty-plus),
 * so this module is published to the client through the
 * `@valet/api/service-display-name` export subpath.
 *
 * KEEP THIS MODULE DEPENDENCY-FREE. It is bundled into the web client, so
 * it must not import Node built-ins, Drizzle, Hono, or anything else from
 * the server. Pure string work only.
 */
const SERVICE_DISPLAY_NAMES: Record<string, string> = {
  github: "GitHub",
  github_app: "GitHub App",
  gmail: "Gmail",
  "google-calendar": "Google Calendar",
  google_calendar: "Google Calendar",
  "google-workspace": "Google Workspace",
  google_workspace: "Google Workspace",
  onepassword: "1Password",
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
  assistants: "Assistants",
  telegram: "Telegram",
};

/** Config-declared MCP plugins are named `mcp-config:<entry>` (see
 * packages/api/src/plugins/config-mcp.ts). The prefix is a dedupe guard,
 * not a name — strip it before deriving a label. */
const MCP_CONFIG_PREFIX = "mcp-config:";

export function serviceDisplayName(id: string): string {
  const known = SERVICE_DISPLAY_NAMES[id];
  if (known) return known;
  // A config-declared MCP id names a product, so every word capitalizes —
  // matching the server's own fallback (titleCaseSlug in config-mcp.ts).
  // Other unknown ids (skills, first-party plugins) keep sentence case.
  if (id.startsWith(MCP_CONFIG_PREFIX)) {
    return titleCase(id.slice(MCP_CONFIG_PREFIX.length), true);
  }
  // Any other namespaced id (`llm:prov_1`) is an internal service id the
  // caller sent, not a product. Echo it, so a refusal names the same string
  // the caller can search for. Config-declared MCP services are stored under
  // the bare entry name, so they never reach this branch.
  if (id.includes(":")) return id;
  return titleCase(id, false);
}

function titleCase(id: string, everyWord: boolean): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word, i) => (everyWord || i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}
