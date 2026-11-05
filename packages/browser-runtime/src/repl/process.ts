import { openSync, closeSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BrowserRpc } from '@valet/shared';
import { BrowserFault, object, string } from '../protocol.js';
export interface ReplLaunchOptions {
  launcher?: { executable: string; args: string[]; seccompPath?: string };
  childPath?: URL;
  execArgv?: string[];
  testOnlyUnconfined?: boolean;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
  remaining: number;
  started: number;
}
/** Only this subprocess evaluates cell source. Production requires an OS confinement launcher. */
export class ReplProcess {
  private readonly child: ChildProcess;
  private pending?: Pending;
  private currentCell?: string;
  private stopped = false;
  private diagnostic = '';
  get alive() {
    return !this.stopped;
  }
  constructor(
    options: ReplLaunchOptions,
    private readonly rpc: (rpc: BrowserRpc) => Promise<unknown>,
    private readonly output: (value: unknown) => void,
  ) {
    if (!options.launcher && !options.testOnlyUnconfined)
      throw new BrowserFault(
        'BROWSER_UNAVAILABLE',
        'The REPL confinement launcher is missing.',
        'Install the verified Linux browser runtime image.',
      );
    const args = [
      '--max-old-space-size=192',
      ...(options.execArgv ?? []),
      fileURLToPath(
        options.childPath ?? new URL('./child.js', import.meta.url),
      ),
    ];
    const seccompFd = options.launcher?.seccompPath
      ? openSync(options.launcher.seccompPath, 'r')
      : undefined;
    this.child = spawn(
      options.launcher?.executable ?? process.execPath,
      options.launcher
        ? [...options.launcher.args, process.execPath, ...args]
        : args,
      {
        stdio: [
          'ignore',
          'ignore',
          'pipe',
          'ipc',
          ...(seccompFd === undefined ? [] : [seccompFd]),
        ],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          NODE_NO_WARNINGS: '1',
        },
      },
    );
    if (seccompFd !== undefined) closeSync(seccompFd);
    this.child.on('message', (message) => {
      void this.message(message);
    });
    this.child.on('error', (error) => {
      this.fail(error);
    });
    this.child.on('exit', () => {
      this.stopped = true;
      this.fail(
        new BrowserFault(
          'CELL_LOST',
          `The cell process exited.${this.diagnostic ? ` ${this.diagnostic.trim()}` : ''}`,
          'Reset the REPL and observe the browser before continuing.',
          'possible',
        ),
      );
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.diagnostic = (this.diagnostic + chunk.toString()).slice(-2000);
    });
  }
  evaluate(cellId: string, code: string, timeoutMs = 30_000): Promise<unknown> {
    if (this.pending)
      return Promise.reject(
        new BrowserFault(
          'CONTROL_HELD',
          'A cell already runs in this thread.',
          'Wait for the current cell or cancel it.',
        ),
      );
    if (this.stopped)
      return Promise.reject(
        new BrowserFault(
          'CELL_LOST',
          'The REPL process is unavailable.',
          'Reset the REPL before executing another cell.',
        ),
      );
    this.currentCell = cellId;
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        remaining: timeoutMs,
        started: Date.now(),
      };
      this.resumeDeadline();
      this.child.send({ kind: 'evaluate', cellId, code });
    });
  }
  pauseDeadline() {
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer);
      this.pending.timer = undefined;
      this.pending.remaining -= Date.now() - this.pending.started;
    }
  }
  resumeDeadline() {
    if (!this.pending || this.pending.timer) return;
    this.pending.started = Date.now();
    this.pending.timer = setTimeout(
      () => {
        this.fail(
          new BrowserFault(
            'ACTION_TIMEOUT',
            'The cell execution deadline expired.',
            'Reset the REPL and inspect the last operation receipt.',
            'possible',
          ),
        );
        this.close();
      },
      Math.max(1, this.pending.remaining),
    );
  }
  private async message(message: unknown) {
    try {
      const m = object(message);
      if (m.cellId !== this.currentCell || !this.pending) return;
      if (m.kind === 'result') {
        const pending = this.pending;
        clearTimeout(pending.timer);
        this.pending = undefined;
        if (m.error) pending.reject(new Error(String(m.error)));
        else pending.resolve(m.value);
      } else if (m.kind === 'output') this.output(m.value);
      else if (m.kind === 'rpc') {
        const id = string(m.id, 'RPC ID');
        try {
          const value = await this.rpc({
            id,
            cellId: this.currentCell!,
            method: string(m.method, 'method'),
            params: object(m.params),
          });
          if (this.child.connected)
            this.child.send({ kind: 'rpc-result', id, value });
        } catch (error) {
          if (this.child.connected)
            this.child.send({
              kind: 'rpc-result',
              id,
              error:
                error instanceof BrowserFault
                  ? error.detail
                  : {
                      message:
                        error instanceof Error ? error.message : String(error),
                    },
            });
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.close();
    }
  }
  private fail(error: Error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
  }
  close() {
    if (!this.stopped) {
      this.stopped = true;
      this.child.kill('SIGKILL');
      this.fail(
        new BrowserFault(
          'CANCELLED',
          'The cell process was cancelled.',
          'Observe the browser before starting another cell.',
          'possible',
        ),
      );
    }
  }
}
