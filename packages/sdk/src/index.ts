// Channel metadata (display info, capabilities — usable by both backend and frontend)
export * from './meta.js';

// MCP client infrastructure (for MCP-backed action sources)
export { McpClient } from './mcp/client.js';
export type { McpTool, McpToolResult } from './mcp/types.js';

// MCP OAuth (dynamic client registration + PKCE)
export {
  discoverAuthServer,
  registerClient,
  generatePkceChallenge,
  buildAuthorizationUrl,
  exchangeCodePkce,
  refreshTokenPkce,
} from './mcp/oauth.js';
export type { AuthServerMetadata, RegisteredClient, TokenResponse } from './mcp/oauth.js';

// NOTE: React UI components are exported from '@valet/sdk/ui'
// to avoid pulling React into backend bundles.
