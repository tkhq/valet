import { describe, expect, it } from 'vitest';
import { parseModelId } from './model-id.js';

describe('parseModelId', () => {
  it('parses the colon dialect', () => {
    expect(parseModelId('anthropic:claude-sonnet-4-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
  });

  it('parses the slash dialect (catalog/picker format)', () => {
    expect(parseModelId('anthropic/claude-sonnet-4-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(parseModelId('openai/gpt-5')).toEqual({ provider: 'openai', model: 'gpt-5' });
  });

  it('splits on the first separator so model names keep embedded ones', () => {
    expect(parseModelId('google:models/gemini-2.5-pro')).toEqual({ provider: 'google', model: 'models/gemini-2.5-pro' });
    expect(parseModelId('openai/gpt-5:beta')).toEqual({ provider: 'openai', model: 'gpt-5:beta' });
  });

  it('rejects bare ids and separator-at-edge forms', () => {
    for (const bad of ['claude-sonnet-4-5', ':claude', '/claude', '', 'anthropic:', 'anthropic/']) {
      expect(() => parseModelId(bad)).toThrow(/invalid model id/);
    }
  });

  it('rejects providers outside the AI SDK whitelist in either dialect', () => {
    expect(() => parseModelId('openrouter:some-model')).toThrow(/unsupported LLM provider/);
    expect(() => parseModelId('openrouter/some-model')).toThrow(/unsupported LLM provider/);
  });
});
