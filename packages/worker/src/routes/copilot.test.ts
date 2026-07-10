import { describe, it, expect, vi, beforeEach } from 'vitest';

// ──────────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────────

const listPackagesMock = vi.fn();
const isBuiltinServiceMock = vi.fn();
const loadCustomMcpConnectorContextMock = vi.fn();
const listMcpToolCacheMock = vi.fn();

vi.mock('../integrations/registry.js', () => ({
  integrationRegistry: {
    listPackages: (...args: unknown[]) => listPackagesMock(...args),
    isBuiltinService: (...args: unknown[]) => isBuiltinServiceMock(...args),
  },
}));

vi.mock('../services/custom-mcp-connectors.js', () => ({
  loadCustomMcpConnectorContext: (...args: unknown[]) =>
    loadCustomMcpConnectorContextMock(...args),
}));

vi.mock('../lib/db/mcp-tool-cache.js', () => ({
  listMcpToolCache: (...args: unknown[]) => listMcpToolCacheMock(...args),
}));

// Import AFTER mocks are registered so the service picks them up.
import {
  buildActionCatalog,
  getActionCatalogEntry,
} from '../services/action-catalog.js';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a minimal integration package fixture. The registry only calls
 * `pkg.actions.listActions()` and reads `pkg.provider.displayName` /
 * `pkg.service`, so the rest can be omitted.
 */
function makePackage(service: string, displayName: string, actions: Array<{
  id: string;
  name: string;
  description: string;
  riskLevel: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}>) {
  return {
    service,
    provider: { displayName },
    actions: {
      listActions: () => actions.map((a) => ({
        ...a,
        // action-catalog falls back to zodToJsonSchema(params) when
        // inputSchema is absent. Provide an explicit inputSchema in every
        // fixture so we never invoke the zod converter.
        inputSchema: a.inputSchema ?? { type: 'object', properties: {} },
        params: undefined as unknown,
      })),
    },
  };
}

const linearListIssues = {
  id: 'linear.list_issues',
  name: 'List issues',
  description: 'List Linear issues in a team.',
  riskLevel: 'low',
  inputSchema: { type: 'object', properties: { teamId: { type: 'string' } } },
  outputSchema: { type: 'array' },
};

const linearCreateIssue = {
  id: 'linear.create_issue',
  name: 'Create issue',
  description: 'Create a new Linear issue.',
  riskLevel: 'medium',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  outputSchema: { type: 'object' },
};

const linearPackage = makePackage('linear', 'Linear', [
  linearListIssues,
  linearCreateIssue,
]);

const env = {} as Env;
const db = {} as AppDb;

// ──────────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────────

beforeEach(() => {
  listPackagesMock.mockReset();
  isBuiltinServiceMock.mockReset();
  loadCustomMcpConnectorContextMock.mockReset();
  listMcpToolCacheMock.mockReset();

  // Default: no custom MCP connectors, no cached MCP tools.
  loadCustomMcpConnectorContextMock.mockResolvedValue({
    connectors: new Map(),
  });
  listMcpToolCacheMock.mockResolvedValue([]);
  isBuiltinServiceMock.mockImplementation((service: string) => service === 'linear');
  listPackagesMock.mockReturnValue([linearPackage]);
});

// ──────────────────────────────────────────────────────────────────────
// Tests — mirror the copilot's `getActionSchema` tool behavior
// ──────────────────────────────────────────────────────────────────────

describe('copilot getActionSchema tool (action-catalog helper)', () => {
  it('returns a single matching entry when actionId is provided', async () => {
    const entry = await getActionCatalogEntry(env, db, 'linear', 'linear.list_issues');
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      service: 'linear',
      serviceDisplayName: 'Linear',
      actionId: 'linear.list_issues',
      name: 'List issues',
      riskLevel: 'low',
    });
    expect(entry?.inputSchema).toEqual(linearListIssues.inputSchema);
    expect(entry?.outputSchema).toEqual(linearListIssues.outputSchema);
  });

  it('returns all entries for the service when actionId is omitted', async () => {
    const catalog = await buildActionCatalog(env, db, 'linear');
    expect(catalog).toHaveLength(2);
    expect(catalog.map((c) => c.actionId).sort()).toEqual([
      'linear.create_issue',
      'linear.list_issues',
    ]);
  });

  it('returns an empty array for an unknown service', async () => {
    const catalog = await buildActionCatalog(env, db, 'nonexistent');
    expect(catalog).toEqual([]);
  });

  it('returns null when the actionId does not exist under a known service', async () => {
    const entry = await getActionCatalogEntry(env, db, 'linear', 'linear.does_not_exist');
    expect(entry).toBeNull();
  });
});
