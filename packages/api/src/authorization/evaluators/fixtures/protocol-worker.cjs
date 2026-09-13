'use strict';

const { parentPort } = require('node:worker_threads');
if (parentPort === null) throw new Error('The test worker requires a parent port.');

const identity = {
  engineDigest: '0'.repeat(64),
  engineName: 'valet-policy-engine',
  engineVersion: '0.1.0',
  contractVersion: 1,
  capabilityProfileVersion: 1,
  regoVersion: 'v1',
  interpreterName: 'regorus',
  interpreterVersion: '0.12.0',
  interpreterRevision: 'aee1a9b12b1ec1e0599a53acd665b31d3bb5ea2e',
  target: 'wasm32-unknown-unknown-worker',
  maxWallTimeMs: 100,
  maxEngineMemoryBytes: 67108864,
};

parentPort.postMessage({ type: 'ready', identity });
parentPort.on('message', ({ id, command }) => {
  parentPort.postMessage({ type: 'started', id });
  if (command.operation === 'fatal') {
    parentPort.postMessage({
      type: 'result',
      id,
      fatal: true,
      response: { status: 'error', code: 'engine_trap', message: 'intentional test trap' },
    });
    return;
  }
  const delay = command.operation === 'slow' ? 7_000 : ['evaluate', 'measure_stall'].includes(command.operation) ? 500 : 0;
  setTimeout(() => {
    parentPort.postMessage({ type: 'result', id, response: { status: 'ok', value: command.value ?? command.operation } });
  }, delay);
});
