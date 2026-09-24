import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BrowserArtifact,
  BrowserCellReceipt,
  BrowserEventPayload,
  BrowserIdentity,
  BrowserPolicyRequest,
  BrowserRequest,
  BrowserResponse,
  BrowserRpc,
  BrowserRuntimeStatus,
} from '@valet/shared';
import { PlaywrightBackend, type BrowserBackendOptions } from './browser.js';
import { Control } from './control.js';
import { FileBroker } from './files.js';
import { Journal } from './journal.js';
import {
  BrowserFault,
  canonicalHash,
  fault,
  object,
  parseRequest,
} from './protocol.js';
import { documentation, methodClass } from './registry.js';
import { ReplProcess, type ReplLaunchOptions } from './repl/process.js';
export type BrowserBackend = Pick<
  PlaywrightBackend,
  | 'capabilities'
  | 'start'
  | 'close'
  | 'tabs'
  | 'invalidate'
  | 'setPrivate'
  | 'policyState'
  | 'execute'
  | 'turnEnd'
  | 'info'
  | 'newTab'
  | 'select'
  | 'frame'
  | 'viewport'
  | 'humanInput'
> &
  Partial<
    Pick<
      PlaywrightBackend,
      'selected' | 'dialogs' | 'releaseInput' | 'screenshot'
    >
  >;
export interface BrowserDaemonOptions {
  sessionId: string;
  stateDirectory: string;
  workingDirectory: string;
  repl: ReplLaunchOptions;
  browserLaunch?: BrowserBackendOptions['launch'];
  testOnlyUnconfinedBrowser?: boolean;
  backendFactory?: (options: BrowserBackendOptions) => BrowserBackend;
  authorizeOrigin?: (origin: string) => void;
  revokeNetwork?: () => void;
}
interface LiveCell {
  request: Extract<BrowserRequest, { command: 'submit' }>;
  cell: BrowserCellReceipt;
  repl: ReplProcess;
  cancelled: boolean;
  active: Set<Promise<unknown>>;
  operationCount: number;
}
interface PendingApproval {
  request: BrowserPolicyRequest;
  params: Record<string, unknown>;
  state: unknown;
  live: LiveCell;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export class BrowserDaemon {
  readonly runtimeId = randomUUID();
  readonly files: FileBroker;
  readonly control: Control;
  private journal!: Journal;
  private backend!: BrowserBackend;
  private repls = new Map<string, ReplProcess>();
  private cells = new Map<string, LiveCell>();
  private approvals = new Map<string, PendingApproval>();
  private waiters = new Set<() => void>();
  private restorableTabs: BrowserRuntimeStatus['tabs'] = [];
  private state: BrowserRuntimeStatus['state'] = 'starting';
  private closed = false;
  private takingControl = false;
  private effects = new Set<Promise<unknown>>();
  private deferredCleanup = new Set<string>();
  private frameInFlight = new Set<string>();
  private frameGeneration = 0;
  constructor(private readonly options: BrowserDaemonOptions) {
    this.files = new FileBroker(
      options.stateDirectory,
      options.sessionId,
      this.runtimeId,
      options.workingDirectory,
    );
    this.control = new Control(this.runtimeId, () => {
      // A complete private-control cycle can occur during an awaited capture.
      this.frameGeneration++;
      this.backend?.invalidate();
    });
  }
  async start() {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    await this.files.initialize();
    this.journal = new Journal(
      join(this.options.stateDirectory, 'journal.sqlite'),
      this.runtimeId,
    );
    this.restorableTabs =
      this.journal.metadata('restorableTabs') ??
      this.journal.metadata('tabs') ??
      [];
    const opts: BrowserBackendOptions = {
      runtimeId: this.runtimeId,
      profile: join(this.options.stateDirectory, 'profile'),
      files: this.files,
      launch: this.options.browserLaunch,
      testOnlyUnconfined: this.options.testOnlyUnconfinedBrowser,
      onTabs: (tabs) => {
        this.journal.setMetadata('tabs', tabs);
        this.emit({ type: 'tabs', tabs });
      },
      onDialog: (tabId, dialogId, kind, message) =>
        this.emit({ type: 'dialog', tabId, dialogId, kind, message }),
    };
    this.backend =
      this.options.backendFactory?.(opts) ?? new PlaywrightBackend(opts);
    try {
      await this.backend.start();
      this.state = 'ready';
    } catch (error) {
      this.state = 'crashed';
      throw error;
    }
  }
  private emit(event: BrowserEventPayload, cellId?: string) {
    this.journal.emit(event, cellId);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  status(identity?: BrowserIdentity): BrowserRuntimeStatus {
    const hidden = Boolean(
      this.control.lease?.privateMode &&
      (!identity ||
        identity.audience !== 'viewer' ||
        identity.actorId !== this.control.lease.actorId),
    );
    return {
      state: this.state,
      runtimeId: this.runtimeId,
      protocolVersion: '1.0',
      capabilities: this.backend?.capabilities ?? {},
      tabs: hidden ? [] : (this.backend?.tabs() ?? []),
      control: this.control.lease,
      restorableTabs: hidden ? [] : this.restorableTabs,
      selectedTabId: hidden ? undefined : this.backend?.selected?.(),
      dialogs: hidden ? [] : (this.backend?.dialogs?.() ?? []),
      downloads: hidden
        ? []
        : this.files
            .list()
            .filter((a) => a.mimeType === 'application/octet-stream'),
    };
  }
  private receipt(invocation: string, identity: BrowserIdentity) {
    const cell = this.journal.cell(
      invocation,
      identity.sessionId,
      identity.threadId,
      identity.actorId,
    );
    if (!cell)
      throw new BrowserFault(
        'CELL_LOST',
        'The invocation receipt is missing.',
        'Submit a new invocation after checking browser state.',
      );
    return cell;
  }
  async handle(raw: unknown): Promise<BrowserResponse> {
    const response: BrowserResponse = {
      protocolVersion: '1.0',
      runtimeId: this.runtimeId,
      ok: true,
      events: [],
      cursor: 0,
      gap: false,
    };
    try {
      const request = parseRequest(raw);
      if (request.sessionId !== this.options.sessionId)
        throw new BrowserFault(
          'IDENTITY_MISMATCH',
          'The browser belongs to another session.',
          'Use the browser for the current session.',
        );
      if (
        this.state !== 'ready' &&
        ![
          'status',
          'describe',
          'events',
          'cancel',
          'export',
          'ack',
          'audit',
          'suspend',
          'revoke',
        ].includes(request.command)
      )
        throw new BrowserFault(
          'BROWSER_UNAVAILABLE',
          'The browser runtime is not ready.',
          'Read browser status and wake or rebuild the sandbox.',
        );
      switch (request.command) {
        case 'submit': {
          const hash = canonicalHash({
            code: request.code,
            title: request.title,
            policyVersion: request.policyVersion ?? '1',
            sessionId: request.sessionId,
            threadId: request.threadId,
            actorId: request.actorId,
            ownerId: request.ownerId,
          });
          const existing = this.journal.cell(
            request.invocationId,
            request.sessionId,
            request.threadId,
            request.actorId,
          );
          if (
            !existing &&
            [...this.cells.values()].some(
              (c) => c.request.threadId === request.threadId,
            )
          )
            throw new BrowserFault(
              'CONTROL_HELD',
              'This thread already has an active browser cell.',
              'Wait for the cell to finish or cancel it.',
            );
          const { created, cell } = this.journal.submit(
            request.sessionId,
            request.threadId,
            request.actorId,
            request.invocationId,
            hash,
          );
          if (created) this.begin(request, cell);
          response.cell = cell;
          Object.assign(response, this.journal.events(cell.cellId, 0));
          return response;
        }
        case 'events': {
          const cell = this.receipt(request.invocationId, request);
          let batch = this.journal.events(cell.cellId, request.after ?? 0);
          if (
            !batch.events.length &&
            ['running', 'awaiting_approval'].includes(cell.status) &&
            (request.waitMs ?? 0) > 0
          ) {
            await new Promise<void>((resolve) => {
              const wake = () => {
                clearTimeout(timer);
                this.waiters.delete(wake);
                resolve();
              };
              const timer = setTimeout(wake, request.waitMs);
              this.waiters.add(wake);
            });
            batch = this.journal.events(cell.cellId, request.after ?? 0);
          }
          Object.assign(response, batch);
          response.cell = this.receipt(request.invocationId, request);
          return response;
        }
        case 'status':
          response.status = this.status(request);
          if (request.invocationId)
            response.cell = this.receipt(request.invocationId, request);
          return response;
        case 'describe':
          response.status = this.status(request);
          response.description = documentation();
          return response;
        case 'resolve':
          await this.resolve(request);
          response.cell = this.receipt(request.invocationId, request);
          return response;
        case 'cancel': {
          const cell = this.receipt(request.invocationId, request);
          this.cancel(cell.cellId);
          response.cell = this.receipt(request.invocationId, request);
          return response;
        }
        case 'reset': {
          for (const live of this.cells.values())
            if (live.request.threadId === request.threadId) {
              if (live.request.actorId !== request.actorId)
                throw new BrowserFault(
                  'IDENTITY_MISMATCH',
                  'Another actor owns this cell.',
                  'Ask the owning actor to reset it.',
                );
              this.cancel(live.cell.cellId);
            }
          this.repls.get(request.threadId)?.close();
          this.repls.delete(request.threadId);
          return response;
        }
        case 'export':
          if (
            this.control.lease?.privateMode &&
            (request.audience !== 'viewer' ||
              this.control.lease.actorId !== request.actorId)
          )
            throw new BrowserFault(
              'CONTROL_HELD',
              'Private sign-in is active.',
              'Wait for private mode to end.',
            );
          response.artifact = await this.files.export(request.artifactId);
          return response;
        case 'ack':
          await this.files.ack(request.transferId);
          return response;
        case 'control': {
          if (request.action === 'take') {
            this.takingControl = true;
            try {
              await Promise.allSettled([...this.effects]);
              await this.backend.releaseInput?.();
              await this.control.take(request.actorId, request.privateMode);
            } finally {
              this.takingControl = false;
            }
          } else if (request.action === 'release') {
            await this.backend.releaseInput?.();
            this.control.release(request.leaseId ?? '', request.actorId);
            for (const thread of this.deferredCleanup)
              await this.backend.turnEnd(thread);
            this.deferredCleanup.clear();
          } else if (request.action === 'pause') {
            await this.backend.releaseInput?.();
            this.control.pause(request.leaseId ?? '', request.actorId);
          } else this.control.resume(request.leaseId ?? '', request.actorId);
          this.backend.setPrivate(this.control.lease?.privateMode ?? false);
          this.emit({ type: 'control', lease: this.control.lease });
          response.status = this.status(request);
          return response;
        }
        case 'input': {
          this.control.validate(
            request.leaseId,
            request.actorId,
            request.runtimeId,
          );
          if (request.input.type === 'navigate')
            this.options.authorizeOrigin?.(
              request.input.url === 'about:blank'
                ? 'about:blank'
                : new URL(request.input.url).origin,
            );
          const operation = () =>
            this.backend.humanInput(
              request.tabId,
              request.documentId,
              request.input,
            );
          if (request.input.type === 'dialog') await operation();
          else
            await this.control.run(request.actorId, operation, request.leaseId);
          response.status = this.status(request);
          return response;
        }
        case 'evidence': {
          if (this.control.lease?.privateMode)
            throw new BrowserFault(
              'CONTROL_HELD',
              'Private sign-in blocks saved screenshots.',
              'Release private control before saving evidence.',
            );
          if (request.runtimeId !== this.runtimeId)
            throw new BrowserFault(
              'RUNTIME_CHANGED',
              'The viewer runtime changed.',
              'Reconnect the Browser panel.',
            );
          if (!this.backend.screenshot)
            throw new BrowserFault(
              'UNSUPPORTED_CAPABILITY',
              'Evidence capture is unavailable.',
              'Use a browser backend with PNG evidence support.',
            );
          const artifact = await this.backend.screenshot(request.tabId);
          response.artifact = await this.files.export(artifact.id);
          return response;
        }
        case 'frame': {
          if (
            this.control.lease?.privateMode &&
            (request.audience !== 'viewer' ||
              this.control.lease.actorId !== request.actorId)
          )
            throw new BrowserFault(
              'CONTROL_HELD',
              'Private sign-in is active.',
              'Wait for the control owner to release private mode.',
            );
          if (request.runtimeId !== this.runtimeId)
            throw new BrowserFault(
              'RUNTIME_CHANGED',
              'The viewer runtime changed.',
              'Reconnect the Browser panel.',
            );
          if (this.frameInFlight.has(request.actorId))
            throw new BrowserFault(
              'QUOTA_EXCEEDED',
              'A viewer frame is already being captured.',
              'Wait for the current frame.',
            );
          this.frameInFlight.add(request.actorId);
          try {
            const generation = this.frameGeneration;
            const tab = { ...this.backend.info(request.tabId) };
            const validateCapture = () => {
              if (generation !== this.frameGeneration)
                throw new BrowserFault(
                  'CONTROL_HELD',
                  'Browser control changed during capture.',
                  'Request a new viewer frame.',
                );
              const current = this.backend.info(request.tabId);
              if (this.state !== 'ready' || current.runtimeId !== this.runtimeId || tab.runtimeId !== this.runtimeId)
                throw new BrowserFault(
                  'RUNTIME_CHANGED',
                  'The viewer runtime changed during capture.',
                  'Reconnect the Browser panel.',
                );
              if (current.id !== tab.id || tab.id !== request.tabId || current.documentId !== tab.documentId)
                throw new BrowserFault(
                  'STALE_REFERENCE',
                  'The browser document changed during capture.',
                  'Request a frame of the current document.',
                );
            };
            validateCapture();
            const bytes = await this.backend.frame(tab.id);
            const viewport = await this.backend.viewport(tab.id);
            validateCapture();
            if (request.inline) {
              // Base64 and metadata must fit inside the 1,000,000-byte reply.
              if (bytes.length > 700_000)
                throw new BrowserFault(
                  'QUOTA_EXCEEDED',
                  'The viewer frame exceeds the inline size limit.',
                  'Use a smaller browser viewport.',
                );
              response.frame = {
                mimeType: 'image/jpeg',
                data: bytes.toString('base64'),
                bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                tabId: tab.id,
                documentId: tab.documentId,
                viewport: { width: viewport.width, height: viewport.height },
              };
            } else {
              const artifact = await this.files.frame(bytes, {
                tabId: tab.id, documentId: tab.documentId, viewport,
              }, request.actorId);
              try {
                validateCapture();
              } catch (error) {
                await this.files.ack(artifact.transferId);
                throw error;
              }
              response.artifact = artifact;
            }
          } finally {
            this.frameInFlight.delete(request.actorId);
          }
          return response;
        }
        case 'tab': {
          this.control.validate(
            request.leaseId,
            request.actorId,
            request.runtimeId,
          );
          await this.control.run(
            request.actorId,
            async () => {
              if (request.action === 'new') {
                if (request.url)
                  this.options.authorizeOrigin?.(
                    request.url === 'about:blank'
                      ? 'about:blank'
                      : new URL(request.url).origin,
                  );
                await this.backend.newTab(null, request.actorId, request.url);
              } else if (request.action === 'select')
                this.backend.select(request.tabId ?? '');
              else if (request.action === 'close')
                await this.backend.execute(
                  'tab.close',
                  { tabId: request.tabId, runtimeId: this.runtimeId },
                  request.threadId,
                  request.actorId,
                );
              else
                throw new BrowserFault(
                  'INVALID_REQUEST',
                  'Unknown tab action.',
                  'Use new, close, or select.',
                );
            },
            request.leaseId,
          );
          response.status = this.status(request);
          return response;
        }
        case 'revoke':
          this.options.revokeNetwork?.();
          await this.backend.releaseInput?.();
          await this.suspend();
          this.state = 'disabled';
          response.status = this.status(request);
          return response;
        case 'audit':
          response.audit = this.journal.audit();
          response.auditTotal = this.journal.auditTotal();
          response.auditTruncated = response.audit.length < response.auditTotal;
          return response;
        case 'turn_end':
          if (this.control.lease) this.deferredCleanup.add(request.threadId);
          else await this.backend.turnEnd(request.threadId);
          response.status = this.status(request);
          return response;
        case 'suspend':
          await this.suspend();
          response.status = this.status(request);
          return response;
      }
    } catch (error) {
      return { ...response, ok: false, error: fault(error) };
    }
  }
  private begin(
    request: Extract<BrowserRequest, { command: 'submit' }>,
    cell: BrowserCellReceipt,
  ) {
    let repl = this.repls.get(request.threadId);
    if (!repl?.alive) {
      if (this.repls.size >= 4 && !this.repls.has(request.threadId)) {
        this.journal.settle(
          cell.cellId,
          'failed',
          fault(
            new BrowserFault(
              'QUOTA_EXCEEDED',
              'The REPL process limit was reached.',
              'Reset an unused thread REPL.',
            ),
          ),
        );
        return;
      }
      repl = new ReplProcess(
        this.options.repl,
        (rpc) => this.rpc(rpc),
        (value) => this.output(cell.cellId, value),
      );
      this.repls.set(request.threadId, repl);
    }
    // Output follows the active cell, including after a persistent REPL is reused.
    const live: LiveCell = {
      request,
      cell,
      repl,
      cancelled: false,
      active: new Set(),
      operationCount: 0,
    };
    this.cells.set(cell.cellId, live);
    void repl
      .evaluate(cell.cellId, request.code, request.timeoutMs)
      .then(
        async (value) => {
          await Promise.allSettled([...live.active]);
          if (live.cancelled) return;
          this.journal.settle(cell.cellId, 'completed');
        },
        (error) => {
          const detail =
            this.journal
              .byId(cell.cellId)
              .operations.reverse()
              .find((operation) => operation.error)?.error ?? fault(error);
          this.journal.settle(
            cell.cellId,
            live.cancelled ? 'cancelled' : 'failed',
            detail,
          );
        },
      )
      .finally(() => {
        for (const pending of this.approvals.values())
          if (pending.live === live) {
            clearTimeout(pending.timer);
            pending.reject(
              new BrowserFault(
                'CELL_LOST',
                'The cell continuation ended.',
                'Submit a new cell.',
              ),
            );
            this.approvals.delete(pending.request.operationId);
          }
        this.cells.delete(cell.cellId);
        this.emit(
          { type: 'cell', cell: this.journal.byId(cell.cellId) },
          cell.cellId,
        );
      });
  }
  private output(cellId: string, value: unknown) {
    const live =
      this.cells.get(cellId) ??
      [...this.cells.values()].find(
        (c) => c.request.threadId === this.journal.byId(cellId).threadId,
      );
    if (!live) return;
    const targetCell = live.cell.cellId;
    if (value && typeof value === 'object' && Reflect.get(value, 'image')) {
      const image = object(Reflect.get(value, 'image'));
      const artifact = this.files.get(String(image.id));
      if (!artifact.mimeType.startsWith('image/'))
        throw new BrowserFault(
          'INVALID_REQUEST',
          'The handle is not an image.',
          'Use a screenshot image handle.',
        );
      this.emit({ type: 'artifact', artifact }, targetCell);
    } else
      this.emit(
        {
          type: 'text',
          text: (typeof value === 'string'
            ? value
            : (JSON.stringify(value) ?? 'undefined')
          ).slice(0, 24000),
        },
        targetCell,
      );
  }
  private rpc(rpc: BrowserRpc) {
    const live = this.cells.get(rpc.cellId);
    if (!live || live.cancelled)
      return Promise.reject(
        new BrowserFault(
          'CELL_LOST',
          'The cell is no longer active.',
          'Start a new cell.',
        ),
      );
    const work = this.perform(live, rpc);
    live.active.add(work);
    void work.finally(() => live.active.delete(work)).catch(() => {});
    return work;
  }
  private async perform(live: LiveCell, rpc: BrowserRpc): Promise<unknown> {
    if (++live.operationCount > 64)
      throw new BrowserFault(
        'QUOTA_EXCEEDED',
        'The cell operation limit was reached.',
        'Split the work into smaller cells.',
      );
    const operationClass = methodClass(rpc.method);
    if (this.control.lease?.privateMode || this.takingControl)
      throw new BrowserFault(
        'CONTROL_HELD',
        'Private sign-in pauses agent browser access.',
        'Wait for the person to release control.',
      );
    const state = await this.backend.policyState(rpc.method, rpc.params);
    const hash = canonicalHash({
      sessionId: live.request.sessionId,
      actorId: live.request.actorId,
      ownerId: live.request.ownerId,
      threadId: live.request.threadId,
      runtimeId: this.runtimeId,
      method: rpc.method,
      params: rpc.params,
      state,
      policyVersion: live.request.policyVersion ?? '1',
    });
    const operationId = `${live.cell.cellId}:${rpc.id}`;
    const old = this.journal.prepare(
      live.cell.cellId,
      operationId,
      rpc.method,
      hash,
    );
    if (old.status !== 'prepared') {
      if (old.status === 'completed') return old.result;
      throw new BrowserFault(
        'OUTCOME_UNKNOWN',
        'This operation cannot be replayed.',
        'Inspect its receipt and observe the browser.',
        old.status === 'outcome_unknown' ? 'possible' : 'none',
      );
    }
    const request: BrowserPolicyRequest = {
      operationId,
      cellId: live.cell.cellId,
      invocationId: live.request.invocationId,
      runtimeId: this.runtimeId,
      hash,
      actorId: live.request.actorId,
      ownerId: live.request.ownerId,
      threadId: live.request.threadId,
      sessionId: live.request.sessionId,
      method: rpc.method,
      operationClass,
      ...state,
      target: rpc.method,
      policyVersion: live.request.policyVersion ?? '1',
      expiresAt: Date.now() + 30 * 60_000,
    };
    try {
      this.journal.operation(operationId, 'awaiting_approval');
      this.journal.settle(live.cell.cellId, 'awaiting_approval');
      live.repl.pauseDeadline();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.approvals.delete(operationId);
          reject(
            new BrowserFault(
              'APPROVAL_STALE',
              'The browser approval expired.',
              'Observe the page and request a new approval.',
            ),
          );
        }, 30 * 60_000);
        timer.unref();
        this.approvals.set(operationId, {
          request,
          params: rpc.params,
          state,
          live,
          resolve,
          reject,
          timer,
        });
        this.emit({ type: 'approval', request }, live.cell.cellId);
      });
      if (live.cancelled)
        throw new BrowserFault(
          'CANCELLED',
          'The cell was cancelled.',
          'Observe the browser before continuing.',
        );
      const run = async () => {
        if (this.control.lease?.privateMode || this.takingControl)
          throw new BrowserFault(
            'CONTROL_HELD',
            'Human control pauses this operation.',
            'Wait for control to be released.',
          );
        if (live.cancelled)
          throw new BrowserFault(
            'CANCELLED',
            'The cell was cancelled.',
            'Observe the browser before continuing.',
          );
        if (
          canonicalHash(
            await this.backend.policyState(rpc.method, rpc.params),
          ) !== canonicalHash(state)
        )
          throw new BrowserFault(
            'APPROVAL_STALE',
            'The page changed after approval.',
            'Take a fresh observation and request approval again.',
          );
        if (this.control.lease?.privateMode || this.takingControl)
          throw new BrowserFault(
            'CONTROL_HELD',
            'Human control pauses this operation.',
            'Wait for control to be released.',
          );
        this.journal.operation(operationId, 'in_flight');
        const result = await this.backend.execute(
          rpc.method,
          rpc.params,
          live.request.threadId,
          live.request.actorId,
        );
        this.journal.operation(operationId, 'completed', result);
        return result;
      };
      const tracked = () => {
        const effect = run();
        this.effects.add(effect);
        void effect.finally(() => this.effects.delete(effect)).catch(() => {});
        return effect;
      };
      const result =
        operationClass === 'observation' ||
        operationClass === 'history' ||
        operationClass === 'diagnostic'
          ? await tracked()
          : rpc.method === 'tab.dialogRespond'
            ? await tracked()
            : await this.control.run(live.request.actorId, tracked);
      this.emit(
        {
          type: 'operation',
          receipt: this.journal
            .byId(live.cell.cellId)
            .operations.find((o) => o.operationId === operationId)!,
        },
        live.cell.cellId,
      );
      const options =
        rpc.params.options && typeof rpc.params.options === 'object'
          ? object(rpc.params.options)
          : {};
      if (options.emit !== false) {
        if (rpc.method === 'tab.getAXState') {
          const observation = object(result);
          this.emit(
            { type: 'text', text: String(observation.text) },
            live.cell.cellId,
          );
        }
        if (rpc.method === 'tab.getScreenshot' || rpc.method === 'tab.export')
          this.emit(
            { type: 'artifact', artifact: result as BrowserArtifact },
            live.cell.cellId,
          );
        if (rpc.method === 'tab.getAXStateAndScreenshot') {
          const combined = object(result);
          this.emit(
            { type: 'text', text: String(object(combined.observation).text) },
            live.cell.cellId,
          );
          this.emit(
            {
              type: 'artifact',
              artifact: combined.artifact as BrowserArtifact,
            },
            live.cell.cellId,
          );
        }
      }
      return result;
    } catch (error) {
      const detail = fault(error);
      const receipt = this.journal
        .byId(live.cell.cellId)
        .operations.find((o) => o.operationId === operationId);
      this.journal.operation(
        operationId,
        receipt?.status === 'in_flight' && detail.effect === 'possible'
          ? 'outcome_unknown'
          : 'failed',
        undefined,
        detail,
      );
      throw error;
    } finally {
      if (![...this.approvals.values()].some((p) => p.live === live)) {
        live.repl.resumeDeadline();
        if (this.cells.has(live.cell.cellId))
          this.journal.settle(live.cell.cellId, 'running');
      }
    }
  }
  private async resolve(
    request: Extract<BrowserRequest, { command: 'resolve' }>,
  ) {
    const cell = this.receipt(request.invocationId, request);
    const pending = this.approvals.get(request.operationId);
    if (
      !pending ||
      pending.live.cell.cellId !== cell.cellId ||
      request.runtimeId !== this.runtimeId ||
      pending.request.hash !== request.hash ||
      pending.request.policyVersion !== request.policyVersion ||
      request.expiresAt < Date.now() ||
      pending.request.expiresAt < Date.now()
    )
      throw new BrowserFault(
        'APPROVAL_STALE',
        'The approval no longer matches a live operation.',
        'Observe current state and request a new approval.',
      );
    if (
      request.decision === 'allow' &&
      canonicalHash(
        await this.backend.policyState(pending.request.method, pending.params),
      ) !== canonicalHash(pending.state)
    )
      throw new BrowserFault(
        'APPROVAL_STALE',
        'The page changed while approval was pending.',
        'Take a fresh observation before requesting approval.',
      );
    clearTimeout(pending.timer);
    this.approvals.delete(request.operationId);
    if (request.decision === 'allow') {
      try {
        this.options.authorizeOrigin?.(pending.request.origin);
        pending.resolve();
      } catch (error) {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }
    } else
      pending.reject(
        new BrowserFault(
          'ORIGIN_DENIED',
          'The browser operation was denied.',
          'Request browser access or choose an allowed operation.',
        ),
      );
  }
  private cancel(cellId: string) {
    const live = this.cells.get(cellId);
    if (!live) return;
    live.cancelled = true;
    for (const pending of this.approvals.values())
      if (pending.live === live) {
        clearTimeout(pending.timer);
        pending.reject(
          new BrowserFault(
            'CANCELLED',
            'The browser cell was cancelled.',
            'Observe the browser before continuing.',
          ),
        );
        this.approvals.delete(pending.request.operationId);
      }
    live.repl.close();
    this.repls.delete(live.request.threadId);
    this.journal.settle(cellId, 'cancelled');
  }
  async suspend() {
    if (this.state === 'sleeping') return;
    this.journal.setMetadata('restorableTabs', this.backend.tabs());
    this.state = 'sleeping';
    for (const id of this.cells.keys()) this.cancel(id);
    for (const repl of this.repls.values()) repl.close();
    this.repls.clear();
    await this.backend.close();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.suspend();
    await Promise.allSettled(
      [...this.cells.values()].flatMap((c) => [...c.active]),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.journal.close();
  }
}
