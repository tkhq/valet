import { start } from 'node:repl';
import { PassThrough, Writable } from 'node:stream';
import { inspect } from 'node:util';
import { createFacade } from './facade.js';
let cellId = '';
let sequence = 0;
let settle: ((error?: Error, value?: unknown) => void) | undefined;
const pending = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
function send(value: unknown) {
  if (process.connected) process.send?.(value);
}
function safe(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json && json.length > 64_000)
      return '[Output exceeds 64000 characters. Emit a smaller value.]';
    return json ? JSON.parse(json) : undefined;
  } catch {
    return inspect(value, { depth: 3, maxArrayLength: 50 }).slice(0, 24_000);
  }
}
const input = new PassThrough();
const stream = new Writable({
  write(chunk: Buffer, _encoding, done) {
    const text = chunk.toString();
    // Node REPL routes uncaught await errors to its output without calling eval's callback.
    if (/Uncaught/.test(text) && settle)
      settle(new Error(text.replace(/^Uncaught\s*/, '').trim()));
    done();
  },
});
const repl = start({
  input,
  output: stream,
  prompt: '',
  terminal: false,
  useGlobal: false,
  ignoreUndefined: true,
});
for (const name of [
  'process',
  'require',
  'module',
  'Buffer',
  'global',
  'fetch',
  'WebSocket',
])
  Object.defineProperty(repl.context, name, {
    value: undefined,
    writable: false,
    configurable: false,
  });
const browser = createFacade(
  (method, params) =>
    new Promise((resolve, reject) => {
      const id = String(++sequence);
      pending.set(id, { resolve, reject });
      send({ kind: 'rpc', cellId, id, method, params });
    }),
);
Object.assign(repl.context, {
  browser,
  cua: browser,
  output: Object.freeze({
    write: (value: unknown) =>
      send({ kind: 'output', cellId, value: safe(value) }),
    image: (handle: unknown) => {
      if (!handle || typeof handle !== 'object' || !Reflect.get(handle, 'id'))
        throw new Error('Use an image handle returned by getScreenshot.');
      send({ kind: 'output', cellId, value: { image: safe(handle) } });
    },
  }),
});
Object.assign(repl.context, {
  console: Object.freeze({
    log: (...args: unknown[]) =>
      send({
        kind: 'output',
        cellId,
        value: args
          .map((v) => (typeof v === 'string' ? v : inspect(v, { depth: 3 })))
          .join(' ')
          .slice(0, 24_000),
      }),
  }),
});
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const kind = Reflect.get(message, 'kind');
  if (kind === 'rpc-result') {
    const id = String(Reflect.get(message, 'id'));
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    const error: unknown = Reflect.get(message, 'error');
    if (error)
      entry.reject(
        new Error(
          typeof error === 'object'
            ? String(Reflect.get(error, 'message'))
            : String(error),
        ),
      );
    else entry.resolve(Reflect.get(message, 'value'));
  } else if (kind === 'evaluate') {
    cellId = String(Reflect.get(message, 'cellId'));
    const code = String(Reflect.get(message, 'code'));
    if (/^\s*\.[a-z]/m.test(code)) {
      send({
        kind: 'result',
        cellId,
        error: 'REPL dot commands are unavailable. Use browser.reset.',
      });
      return;
    }
    let finished = false;
    settle = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      settle = undefined;
      send({
        kind: 'result',
        cellId,
        ...(error
          ? { error: error.stack ?? error.message }
          : { value: safe(value) }),
      });
    };
    repl.eval(`${code}\n`, repl.context, `cell-${cellId}.js`, (error, value) =>
      settle?.(error ?? undefined, value),
    );
  }
});
process.on('disconnect', () => process.exit(0));
