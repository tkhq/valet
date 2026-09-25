import { randomUUID } from 'node:crypto';
import type { BrowserControlLease } from '@valet/shared';
import { BrowserFault } from './protocol.js';
export class Control {
  private storedLease: BrowserControlLease | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private takeoverActor: string | undefined;
  constructor(
    private readonly runtimeId: string,
    private readonly invalidate: () => void = () => {},
  ) {}
  get lease(): BrowserControlLease | null {
    if (this.storedLease && this.storedLease.expiresAt <= Date.now()) {
      this.storedLease = null;
      this.invalidate();
    }
    return this.storedLease;
  }
  get taking() {
    return this.takeoverActor !== undefined;
  }
  authorize(
    actorId: string,
    runtimeId: string,
    humanLease?: string,
    dialog = false,
  ) {
    if (runtimeId !== this.runtimeId)
      throw new BrowserFault(
        'RUNTIME_CHANGED',
        'The viewer runtime changed.',
        'Reconnect the Browser panel.',
      );
    if (this.takeoverActor && (!dialog || this.takeoverActor !== actorId))
      throw new BrowserFault(
        'CONTROL_HELD',
        'A person is taking browser control.',
        'Wait for shared browser use to resume.',
      );
    if (humanLease !== undefined) this.validate(humanLease, actorId, runtimeId);
    else if (this.lease)
      throw new BrowserFault(
        'CONTROL_HELD',
        'A person holds browser control.',
        'Wait for the person to resume shared browser use.',
      );
  }
  run<T>(
    actorId: string,
    operation: () => Promise<T>,
    humanLease?: string,
  ): Promise<T> {
    const allowed = () => this.authorize(actorId, this.runtimeId, humanLease);
    try {
      allowed();
    } catch (error) {
      return Promise.reject(error);
    }
    const next = this.tail.then(() => {
      allowed();
      return operation();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async take(
    actorId: string,
    privateMode = false,
    beforeGrant?: () => Promise<void>,
  ) {
    const current = this.lease;
    if (this.taking || (current && current.actorId !== actorId))
      throw new BrowserFault(
        'CONTROL_HELD',
        'Another person holds browser control.',
        'Ask the control owner to release control.',
      );
    this.takeoverActor = actorId;
    try {
      await this.tail;
      await beforeGrant?.();
      this.invalidate();
      this.storedLease = {
        id: randomUUID(),
        actorId,
        runtimeId: this.runtimeId,
        state: 'active',
        privateMode,
        expiresAt: Date.now() + 120_000,
      };
      return this.storedLease;
    } finally {
      this.takeoverActor = undefined;
    }
  }
  validate(id: string, actor: string, runtime: string) {
    const lease = this.lease;
    if (
      !lease ||
      lease.id !== id ||
      lease.actorId !== actor ||
      runtime !== this.runtimeId ||
      lease.state !== 'active'
    )
      throw new BrowserFault(
        'CONTROL_HELD',
        'The control lease is invalid or expired.',
        'Renew control or resume shared use in the Browser panel.',
      );
    lease.expiresAt = Date.now() + 120_000;
    return lease;
  }
  pause(id: string, actor: string) {
    const lease = this.validate(id, actor, this.runtimeId);
    lease.state = 'paused';
    lease.expiresAt = Date.now() + 30_000;
  }
  resume(id: string, actor: string) {
    const lease = this.lease;
    if (
      !lease ||
      lease.id !== id ||
      lease.actorId !== actor
    )
      throw new BrowserFault(
        'CONTROL_HELD',
        'The reconnect lease expired.',
        'Renew control or resume shared use in the Browser panel.',
      );
    lease.state = 'active';
    lease.expiresAt = Date.now() + 120_000;
  }
  validateOwner(id: string, actor: string) {
    const lease = this.lease;
    if (!lease || lease.id !== id || lease.actorId !== actor)
      throw new BrowserFault(
        'CONTROL_HELD',
        'The control lease does not match.',
        'Release the lease held by this actor.',
      );
    return lease;
  }
  release(id: string, actor: string) {
    this.validateOwner(id, actor);
    this.storedLease = null;
    this.invalidate();
  }
}
