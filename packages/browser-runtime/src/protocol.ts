import { createHash } from 'node:crypto';
import type {
  BrowserError,
  BrowserErrorCode,
  BrowserRequest,
} from '@valet/shared';
export class BrowserFault extends Error {
  readonly detail: BrowserError;
  constructor(
    code: BrowserErrorCode,
    message: string,
    correctiveAction = 'Read browser status, then retry with a new invocation.',
    effect: 'none' | 'possible' = 'none',
  ) {
    super(message);
    this.name = 'BrowserFault';
    this.detail = { code, message, correctiveAction, effect };
  }
}
export function fault(error: unknown): BrowserError {
  return error instanceof BrowserFault
    ? error.detail
    : {
        code: 'BROWSER_UNAVAILABLE',
        message:
          error instanceof Error ? error.message : 'Browser operation failed.',
        correctiveAction:
          'Read browser status before starting a new operation.',
        effect: 'possible',
      };
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Expected a JSON object.',
      'Send one browser protocol request.',
    );
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string, max = 1024): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    value.includes('\0')
  )
    throw new BrowserFault(
      'INVALID_REQUEST',
      `Invalid ${name}.`,
      `Supply a nonempty ${name} within its size limit.`,
    );
  return value;
}
export function number(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new BrowserFault(
      'INVALID_REQUEST',
      `Invalid ${name}.`,
      `Supply ${name} between ${min} and ${max}.`,
    );
  return value;
}
export function canonicalHash(value: unknown): string {
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object')
      return `{${Object.keys(v)
        .sort()
        .filter((k) => Reflect.get(v, k) !== undefined)
        .map((k) => `${JSON.stringify(k)}:${canonical(Reflect.get(v, k))}`)
        .join(',')}}`;
    return JSON.stringify(v) ?? 'null';
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function parseRequest(value: unknown): BrowserRequest {
  const v = object(value);
  if (v.protocolVersion !== '1.0')
    throw new BrowserFault(
      'PROTOCOL_MISMATCH',
      'Browser protocol is incompatible.',
      'Rebuild the sandbox with browser protocol 1.0.',
    );
  for (const key of ['sessionId', 'threadId', 'actorId', 'ownerId'])
    string(v[key], key, 256);
  if (
    v.audience !== undefined &&
    !['agent', 'viewer', 'lifecycle'].includes(String(v.audience))
  )
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Invalid browser audience.',
      'Use the authenticated host audience.',
    );
  const command = string(v.command, 'command');
  const required: Record<string, string[]> = {
    submit: ['invocationId', 'code', 'title'],
    events: ['invocationId'],
    status: [],
    describe: [],
    resolve: [
      'invocationId',
      'operationId',
      'hash',
      'runtimeId',
      'decision',
      'policyVersion',
    ],
    cancel: ['invocationId'],
    reset: [],
    export: ['artifactId'],
    ack: ['transferId'],
    control: ['action'],
    input: ['runtimeId', 'tabId', 'documentId'],
    evidence: ['tabId', 'runtimeId'],
    frame: ['tabId', 'runtimeId'],
    tab: ['action', 'runtimeId'],
    revoke: [],
    audit: [],
    turn_end: [],
    suspend: [],
  };
  if (!(command in required))
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Unknown browser command.',
      'Use browser.describe to list supported commands.',
    );
  for (const key of required[command])
    string(v[key], key, key === 'code' ? 100_000 : 1024);
  if (['input', 'tab', 'control'].includes(command) && v.audience !== 'viewer')
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Human browser commands require the viewer audience.',
      'Send the command through the authenticated Browser panel.',
    );
  if (command === 'frame' && v.inline !== undefined && typeof v.inline !== 'boolean')
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Invalid inline frame flag.',
      'Set inline to true or false.',
    );
  if (command === 'audit' && v.offset !== undefined) {
    number(v.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(v.offset))
      throw new BrowserFault(
        'INVALID_REQUEST',
        'Invalid offset.',
        'Supply a non-negative integer offset.',
      );
  }
  if (command === 'resolve') {
    if (v.decision !== 'allow' && v.decision !== 'deny')
      throw new BrowserFault(
        'INVALID_REQUEST',
        'Invalid decision.',
        'Use allow or deny.',
      );
    number(v.expiresAt, 'expiresAt', 0, Number.MAX_SAFE_INTEGER);
  }
  if (
    command === 'control' &&
    !['take', 'release', 'pause', 'resume'].includes(String(v.action))
  )
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Invalid control action.',
      'Use take, release, pause, or resume.',
    );
  if (
    command === 'tab' &&
    !['new', 'close', 'select'].includes(String(v.action))
  )
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Invalid tab action.',
      'Use new, close, or select.',
    );
  if (command === 'tab' && v.action !== 'new') string(v.tabId, 'tabId');
  if (command === 'input') {
    const input = object(v.input);
    const type = string(input.type, 'input type');
    if (
      ![
        'click',
        'move',
        'pointer',
        'wheel',
        'key',
        'text',
        'navigate',
        'dialog',
        'back',
        'forward',
        'reload',
      ].includes(type)
    )
      throw new BrowserFault(
        'INVALID_REQUEST',
        'Unknown browser input.',
        'Use a supported pointer, keyboard, navigation, or dialog input.',
      );
    if (['click', 'move', 'pointer'].includes(type)) {
      number(input.x, 'x', 0, 1280);
      number(input.y, 'y', 0, 800);
    }
    if (type === 'wheel') {
      number(input.deltaX, 'deltaX', -10000, 10000);
      number(input.deltaY, 'deltaY', -10000, 10000);
    }
    if (type === 'key') {
      string(input.key, 'key', 128);
      if (
        input.phase !== undefined &&
        !['down', 'up', 'press'].includes(String(input.phase))
      )
        throw new BrowserFault(
          'INVALID_REQUEST',
          'Invalid key phase.',
          'Use down, up, or press.',
        );
    }
    if (
      type === 'pointer' &&
      !['down', 'up', 'move'].includes(String(input.phase))
    )
      throw new BrowserFault(
        'INVALID_REQUEST',
        'Invalid pointer phase.',
        'Use down, up, or move.',
      );
    if (
      input.button !== undefined &&
      !['left', 'middle', 'right'].includes(String(input.button))
    )
      throw new BrowserFault(
        'INVALID_REQUEST',
        'Invalid pointer button.',
        'Use left, middle, or right.',
      );
    if (type === 'text') string(input.text, 'text', 24000);
    if (type === 'navigate') string(input.url, 'url', 8192);
    if (type === 'dialog') {
      string(input.dialogId, 'dialogId');
      if (typeof input.accept !== 'boolean')
        throw new BrowserFault(
          'INVALID_REQUEST',
          'Dialog acceptance must be boolean.',
          'Use true or false.',
        );
      if (input.text !== undefined && typeof input.text !== 'string')
        throw new BrowserFault(
          'INVALID_REQUEST',
          'Dialog text must be a string.',
          'Supply plain text.',
        );
    }
  }
  for (const name of [
    'invocationId',
    'leaseId',
    'runtimeId',
    'tabId',
    'policyVersion',
    'topic',
    'reason',
  ])
    if (v[name] !== undefined) string(v[name], name, 1024);
  if (v.privateMode !== undefined && typeof v.privateMode !== 'boolean')
    throw new BrowserFault(
      'INVALID_REQUEST',
      'Private mode must be boolean.',
      'Use true or false.',
    );
  if (v.url !== undefined) string(v.url, 'url', 8192);
  if (v.timeoutMs !== undefined) number(v.timeoutMs, 'timeoutMs', 1, 120_000);
  if (v.waitMs !== undefined) number(v.waitMs, 'waitMs', 0, 5000);
  if (v.after !== undefined)
    number(v.after, 'after', 0, Number.MAX_SAFE_INTEGER);
  // The checks above validate each member before the transport discriminator is narrowed.
  return {
    ...v,
    protocolVersion: '1.0',
    sessionId: string(v.sessionId, 'sessionId'),
    threadId: string(v.threadId, 'threadId'),
    actorId: string(v.actorId, 'actorId'),
    ownerId: string(v.ownerId, 'ownerId'),
  } as BrowserRequest;
}
