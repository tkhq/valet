/** Browser-provided topical context. Never use this value to authorize a tool. */
export interface AppPageHint { pathname: string; workspace: string }

const pages = new Set([
  "/chat", "/workflows", "/events", "/integrations", "/skills", "/library", "/settings",
  ...["profile", "preferences", "notifications", "models", "api-keys", "proxy", "agent-access", "policies", "connected-accounts", "mcp-servers"].map(page => `/settings/${page}`),
  ...["", "/members", "/teams", "/models", "/proxy", "/plugins", "/mcp-servers", "/github", "/slack", "/linear", "/onepassword", "/library", "/policies", "/sandbox-images", "/action-log"].map(page => `/settings/organization${page}`),
]);

export function readAppPageHint(value: unknown): AppPageHint | undefined {
  if (!value || typeof value !== "object" || !("pathname" in value) || !("workspace" in value)) return undefined;
  const { pathname, workspace } = value;
  if (typeof pathname !== "string" || pathname.length > 200 || typeof workspace !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(workspace)) return undefined;
  if (!pages.has(pathname) && !/^\/settings\/teams\/[A-Za-z0-9_-]{1,128}(?:\/(?:access|policies))?$/.test(pathname)) return undefined;
  return { pathname, workspace };
}

