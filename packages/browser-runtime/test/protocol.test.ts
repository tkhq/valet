import { describe, expect, it } from 'vitest';
import { parseRequest, canonicalHash, BrowserFault } from '../src/protocol.js';
const identity = {
  protocolVersion: '1.0',
  sessionId: 'session:1',
  threadId: 'thread:1',
  actorId: 'user:1',
  ownerId: 'user:1',
};
describe('browser protocol', () => {
  it('accepts viewer input and tab commands without an exclusive lease', () => {
    for (const command of [
      { command: 'input', tabId: 'tab', documentId: 'doc', input: { type: 'key', key: 'A' } },
      { command: 'tab', action: 'new' },
    ])
      expect(parseRequest({ ...identity, audience: 'viewer', runtimeId: 'runtime', ...command }).command).toBe(command.command);
  });
  it('requires the viewer audience for human input, tab commands, and exclusive control', () => {
    for (const audience of [undefined, 'agent', 'lifecycle'])
      for (const command of [
        { command: 'input', tabId: 'tab', documentId: 'doc', input: { type: 'key', key: 'A' } },
        { command: 'tab', action: 'new' },
        { command: 'control', action: 'take' },
      ])
        expect(() => parseRequest({ ...identity, audience, runtimeId: 'runtime', leaseId: 'lease', ...command })).toThrow(/viewer/);
  });
  it('accepts fixed submit messages and retains invocation identity', () => {
    expect(
      parseRequest({
        ...identity,
        command: 'submit',
        invocationId: 'call:1',
        code: 'let x = 1',
        title: 'Inspect',
      }).command,
    ).toBe('submit');
  });
  it('accepts only non-negative integer audit offsets', () => {
    expect(parseRequest({ ...identity, command: 'audit', offset: 500 })).toMatchObject({ offset: 500 });
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => parseRequest({ ...identity, command: 'audit', offset })).toThrow(BrowserFault);
  });
  it('rejects command injection, oversized cells, unsupported versions and missing actors', () => {
    for (const change of [
      { command: 'shell' },
      { code: 'x'.repeat(100_001) },
      { protocolVersion: '2.0' },
      { actorId: '' },
    ]) {
      expect(() =>
        parseRequest({
          ...identity,
          command: 'submit',
          invocationId: 'call:1',
          code: '1',
          title: 'Inspect',
          ...change,
        }),
      ).toThrow(BrowserFault);
    }
  });
  it('hashes canonical nested objects without depending on key order', () => {
    expect(canonicalHash({ b: { y: 1, x: 2 }, a: 2 })).toBe(
      canonicalHash({ a: 2, b: { x: 2, y: 1 } }),
    );
    expect(canonicalHash({ a: '1' })).not.toBe(canonicalHash({ a: 1 }));
  });
});
