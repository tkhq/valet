'use strict';

const { parentPort } = require('node:worker_threads');
const engine = require('./wasm/valet_policy_engine_wasm.cjs');

if (parentPort === null) throw new Error('The policy worker requires a parent port.');

parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ id, command }) => {
  try {
    parentPort.postMessage({ id, response: JSON.parse(engine.run(JSON.stringify(command))) });
  } catch (error) {
    parentPort.postMessage({
      id,
      response: {
        status: 'error',
        code:
          error instanceof RangeError || error instanceof WebAssembly.RuntimeError
            ? 'memory_limit'
            : 'worker_failure',
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});
