import { expect, it } from 'vitest';
import { parseRequest } from '../src/protocol.js';
const base = {
  protocolVersion: '1.0',
  sessionId: 's',
  threadId: 't',
  actorId: 'a',
  ownerId: 'a',
  audience: 'viewer',
};
it('rejects malformed human inputs and invalid tab commands at the transport boundary', () => {
  for (const input of [
    { type: 'click', x: 'wrong', y: 1 },
    { type: 'key', key: 'A', phase: 'shell' },
    { type: 'pointer', phase: 'wrong', x: 0, y: 0 },
    { type: 'shell', code: '1' },
  ])
    expect(() =>
      parseRequest({
        ...base,
        command: 'input',
        leaseId: 'lease',
        runtimeId: 'r',
        tabId: 'tab',
        documentId: 'doc',
        input,
      }),
    ).toThrow();
  expect(() =>
    parseRequest({
      ...base,
      command: 'tab',
      action: 'anything',
      leaseId: 'lease',
      runtimeId: 'r',
    }),
  ).toThrow();
});
