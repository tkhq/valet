import { randomUUID } from 'node:crypto';
import type { BrowserContext, Frame, Page } from 'playwright-core';
import type { BrowserAgentCursor } from '@valet/shared';

interface Capture {
  generation: number;
  startedAt: number;
  endedAt?: number;
}
interface CursorState {
  generation: number;
  suspended: number;
  capture?: Capture;
  latest?: Omit<BrowserAgentCursor, 'ageMs'> & { recordedAt: number };
}
interface CursorEvent {
  x: number;
  y: number;
  kind: BrowserAgentCursor['kind'];
  document: number;
  timestamp: number;
}

/** Cursor telemetry has no effect on browser commands or their completion. */
export class AgentCursorTracker {
  private readonly states = new WeakMap<Page, CursorState>();
  private sequence = 0;
  private enabled = true;

  async install(context: BrowserContext): Promise<void> {
    const binding = `__valetCursor_${randomUUID().replaceAll('-', '')}`;
    await context.exposeBinding(binding, ({ page, frame }, payload: unknown) => {
      const state = this.states.get(page);
      const capture = state?.capture;
      if (!this.enabled || !state || !capture || !isCursorEvent(payload) ||
          payload.timestamp < capture.startedAt ||
          payload.timestamp >= (capture.endedAt ?? timestamp() + 1000)) return;
      const sequence = ++this.sequence;
      const recordedAt = Date.now();
      // Frame lookups can finish after an action. Invalidations revoke these callbacks.
      void viewportPoint(page, frame, payload).then((point) => {
        if (!point || !this.enabled || state.generation !== capture.generation ||
            sequence <= (state.latest?.sequence ?? 0)) return;
        state.latest = { ...point, kind: payload.kind, sequence, recordedAt };
      }).catch(() => {});
    });
    await context.addInitScript((name) => {
      const report = (event: Event) => {
        if (!event.isTrusted) return;
        let x: number;
        let y: number;
        let kind: 'move' | 'click' | 'type';
        if (event instanceof MouseEvent) {
          x = event.clientX;
          y = event.clientY;
          kind = event.type === 'pointermove' ? 'move' : 'click';
        } else {
          const target = event.composedPath()[0];
          if (!(target instanceof HTMLElement) ||
              !(target.isContentEditable || target.matches('textarea,input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],input[type="password"],input[type="number"]'))) return;
          const box = target.getBoundingClientRect();
          if (!box.width || !box.height) return;
          x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
          y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
          kind = 'type';
        }
        // The binding accepts display coordinates only. It never receives keys or text.
        const send: unknown = Reflect.get(globalThis, name);
        if (typeof send === 'function') {
          try {
            void Promise.resolve(send({ x, y, kind, document: performance.timeOrigin,
              timestamp: performance.timeOrigin + performance.now() })).catch(() => {});
          } catch { /* Telemetry must not interrupt page event handlers. */ }
        }
      };
      for (const name of ['pointermove', 'pointerdown', 'pointerup', 'focusin', 'input'])
        document.addEventListener(name, report, true);
    }, binding);
  }

  begin(page: Page): () => void {
    if (!this.enabled) return () => {};
    const state = this.state(page);
    if (state.suspended) return () => {};
    const capture: Capture = { generation: state.generation, startedAt: timestamp() };
    state.capture = capture;
    return () => {
      // Chromium can deliver the binding after the input command resolves.
      capture.endedAt = timestamp();
    };
  }

  suspend(page: Page): () => void {
    const state = this.state(page);
    this.clear(page);
    state.suspended++;
    return () => {
      this.clear(page);
      state.suspended--;
    };
  }

  private state(page: Page): CursorState {
    let state = this.states.get(page);
    if (!state) {
      state = { generation: 0, suspended: 0 };
      this.states.set(page, state);
    }
    return state;
  }

  clear(page: Page): void {
    const state = this.states.get(page);
    if (!state) return;
    state.generation++;
    state.capture = undefined;
    state.latest = undefined;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  get(page: Page): BrowserAgentCursor | undefined {
    const latest = this.states.get(page)?.latest;
    if (!this.enabled || !latest) return;
    const { recordedAt, ...cursor } = latest;
    const ageMs = Math.max(0, Date.now() - recordedAt);
    return ageMs < 2500 ? { ...cursor, ageMs } : undefined;
  }
}

function timestamp() {
  return performance.timeOrigin + performance.now();
}

function isCursorEvent(value: unknown): value is CursorEvent {
  if (value === null || typeof value !== 'object') return false;
  const x: unknown = Reflect.get(value, 'x');
  const y: unknown = Reflect.get(value, 'y');
  const document: unknown = Reflect.get(value, 'document');
  const timestamp: unknown = Reflect.get(value, 'timestamp');
  const kind: unknown = Reflect.get(value, 'kind');
  return typeof x === 'number' && Number.isFinite(x) && Math.abs(x) < 1_000_000 &&
    typeof y === 'number' && Number.isFinite(y) && Math.abs(y) < 1_000_000 &&
    typeof document === 'number' && Number.isFinite(document) &&
    typeof timestamp === 'number' && Number.isFinite(timestamp) &&
    (kind === 'move' || kind === 'click' || kind === 'type');
}

async function viewportPoint(page: Page, frame: Frame, event: CursorEvent) {
  // Frame objects survive navigation. Check the document that emitted the event.
  if (await frame.evaluate(() => performance.timeOrigin) !== event.document) return;
  let point = { x: event.x, y: event.y };
  for (let depth = 0; frame !== page.mainFrame(); depth++) {
    if (depth >= 16) return;
    const parent = frame.parentFrame();
    if (!parent) return;
    const element = await frame.frameElement();
    try {
      const box = await element.evaluate((element) => {
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, sx: rect.width / element.offsetWidth,
          sy: rect.height / element.offsetHeight, left: element.clientLeft, top: element.clientTop };
      });
      if (!box || !Number.isFinite(box.sx) || !Number.isFinite(box.sy) || !box.sx || !box.sy) return;
      point = { x: box.x + (point.x + box.left) * box.sx,
        y: box.y + (point.y + box.top) * box.sy };
    } finally {
      await element.dispose();
    }
    frame = parent;
  }
  const viewport = page.viewportSize();
  if (!viewport || point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height) return;
  return point;
}
