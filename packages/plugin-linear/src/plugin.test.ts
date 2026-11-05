import { describe, expect, it } from 'vitest';
import plugin from './plugin.js';

describe('linear plugin manifest', () => {
  it('names linear:app on its MCP action plugin so list_tools counts the app connection', () => {
    const [actions] = plugin.actions ?? [];
    expect(actions?.service).toBe('linear');
    expect(actions?.appCredentialService).toBe('linear:app');
    expect(actions?.requiresCredential).toBe(true);
  });
});
