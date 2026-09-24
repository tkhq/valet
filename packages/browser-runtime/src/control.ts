import { randomUUID } from 'node:crypto';
import type { BrowserControlLease } from '@valet/shared';
import { BrowserFault } from './protocol.js';
export class Control {
  lease: BrowserControlLease | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private takeover = false;
  constructor(
    private readonly runtimeId: string,
    private readonly invalidate: () => void = () => {},
  ) {}
  run<T>(
    actorId: string,
    operation: () => Promise<T>,
    humanLease?: string,
  ): Promise<T> {
    const allowed = () => {
      if (humanLease) this.validate(humanLease, actorId, this.runtimeId);
      else if (this.lease || this.takeover)
        throw new BrowserFault(
          'CONTROL_HELD',
          'A person holds browser control.',
          'Wait for the person to release control.',
        );
    };
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
  async take(actorId: string, privateMode = false) {
    if (this.lease && this.lease.actorId !== actorId)
      throw new BrowserFault(
        'CONTROL_HELD',
        'Another person holds browser control.',
        'Ask the control owner to release control.',
      );
    this.takeover = true;
    await this.tail;
    this.invalidate();
    this.lease = {
      id: randomUUID(),
      actorId,
      runtimeId: this.runtimeId,
      state: 'active',
      privateMode,
      expiresAt: Date.now() + 120_000,
    };
    this.takeover = false;
    return this.lease;
  }
  validate(id: string, actor: string, runtime: string) {
    if (
      !this.lease ||
      this.lease.id !== id ||
      this.lease.actorId !== actor ||
      runtime !== this.runtimeId ||
      this.lease.state !== 'active' ||
      this.lease.expiresAt < Date.now()
    )
      throw new BrowserFault(
        'CONTROL_HELD',
        'The control lease is invalid or expired.',
        'Take control again before sending input.',
      );
    this.lease.expiresAt = Date.now() + 120_000;
    return this.lease;
  }
  pause(id: string, actor: string) {
    const lease = this.validate(id, actor, this.runtimeId);
    lease.state = 'paused';
    lease.expiresAt = Date.now() + 30_000;
  }
  resume(id: string, actor: string) {
    if (
      !this.lease ||
      this.lease.id !== id ||
      this.lease.actorId !== actor ||
      this.lease.expiresAt < Date.now()
    )
      throw new BrowserFault(
        'CONTROL_HELD',
        'The reconnect lease expired.',
        'Release control, then take control again.',
      );
    this.lease.state = 'active';
    this.lease.expiresAt = Date.now() + 120_000;
  }
  release(id: string, actor: string) {
    if (!this.lease || this.lease.id !== id || this.lease.actorId !== actor)
      throw new BrowserFault(
        'CONTROL_HELD',
        'The control lease does not match.',
        'Release the lease held by this actor.',
      );
    this.lease = null;
    this.invalidate();
  }
}
