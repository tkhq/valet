import type { BrowserRequest, BrowserResponse } from '@valet/shared';
import { BrowserFault } from './protocol.js';

interface DaemonClientOptions {
  request(request: BrowserRequest, signal?: AbortSignal): Promise<BrowserResponse>;
  start(signal?: AbortSignal): Promise<void>;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

function unavailable(error: unknown): boolean {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  // These errors occur before the Unix connection sends a request.
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

/** Bootstrap once; never replay a request that reached the daemon. */
export function createDaemonClient(options: DaemonClientOptions) {
  let starting: Promise<void> | undefined;
  let generation = 0;
  return async (request: BrowserRequest, signal?: AbortSignal): Promise<BrowserResponse> => {
    signal?.throwIfAborted();
    const initialGeneration = generation;
    if (starting) await starting;
    signal?.throwIfAborted();
    try { return await options.request(request, signal); }
    catch (error) { if (!unavailable(error)) throw error; }
    signal?.throwIfAborted();
    if (!starting && generation === initialGeneration) {
      generation++;
      const startup = (async () => {
        await options.start(signal);
        for (let attempt = 0; attempt < 100; attempt++) {
          await options.wait(200, signal);
          signal?.throwIfAborted();
          try {
            await options.request({ ...request, command: 'status' }, signal);
            return;
          } catch (error) { if (!unavailable(error)) throw error; }
        }
        throw new BrowserFault('BROWSER_UNAVAILABLE', 'The browser daemon did not start.', 'Inspect the private daemon log and rebuild an incompatible sandbox image.');
      })();
      starting = startup;
      // Both branches consume the settlement; no rejected cleanup promise leaks.
      void startup.then(() => { if (starting === startup) starting = undefined; }, () => { if (starting === startup) starting = undefined; });
    }
    if (starting) await starting;
    signal?.throwIfAborted();
    return options.request(request, signal);
  };
}
