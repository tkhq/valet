'use strict';

const { parentPort } = require('node:worker_threads');
const engine = require('./wasm/valet_policy_engine_wasm.cjs');

if (parentPort === null) throw new Error('The policy worker requires a parent port.');

const parse = (value) => JSON.parse(value);
const identity = parse(engine.run(JSON.stringify({ operation: 'identity' })));
if (identity.status !== 'ok') throw new Error(identity.message);
parentPort.postMessage({ type: 'ready', identity: identity.value });

let poisoned = false;
parentPort.on('message', ({ id, command }) => {
  if (poisoned) return;
  parentPort.postMessage({ type: 'started', id });
  try {
    if (command.operation === 'trigger_range_error') throw new RangeError('intentional memory containment failure');
    parentPort.postMessage({ type: 'result', id, response: parse(engine.run(JSON.stringify(command))) });
  } catch (error) {
    poisoned = true;
    const code =
      error instanceof RangeError
        ? 'memory_limit'
        : error instanceof SyntaxError
          ? 'malformed_output'
          : 'engine_trap';
    parentPort.postMessage({
      type: 'result',
      id,
      fatal: true,
      response: {
        status: 'error',
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
