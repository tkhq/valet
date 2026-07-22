import { describe, expect, it, vi } from 'vitest';
import { sendWebSocketMessage, getReconnectDelay, CONNECT_TIMEOUT_MS } from './use-websocket';

describe('sendWebSocketMessage', () => {
  it('reports false when no open socket is available', () => {
    const send = vi.fn();

    expect(sendWebSocketMessage(null, { type: 'ping' })).toBe(false);
    expect(sendWebSocketMessage({ readyState: 3, send }, { type: 'ping' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports true after sending on an open socket', () => {
    const send = vi.fn();

    expect(sendWebSocketMessage({ readyState: 1, send }, { type: 'ping' })).toBe(true);
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('reports false when an open socket fails to send', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(() => {
      throw new Error('closed');
    });

    expect(sendWebSocketMessage({ readyState: 1, send }, { type: 'ping' })).toBe(false);
    expect(consoleError).toHaveBeenCalledWith('[ws] send failed:', expect.any(Error));

    consoleError.mockRestore();
  });
});

describe('getReconnectDelay', () => {
  it('doubles the delay on each successive attempt', () => {
    const noJitter = () => 0;

    expect(getReconnectDelay(0, noJitter)).toBe(1000);
    expect(getReconnectDelay(1, noJitter)).toBe(2000);
    expect(getReconnectDelay(2, noJitter)).toBe(4000);
    expect(getReconnectDelay(3, noJitter)).toBe(8000);
  });

  it('caps the delay at 30s no matter how many attempts have failed', () => {
    const noJitter = () => 0;

    expect(getReconnectDelay(10, noJitter)).toBe(30000);
    expect(getReconnectDelay(50, noJitter)).toBe(30000);
  });

  it('adds up to 20% jitter so retries do not stampede', () => {
    expect(getReconnectDelay(0, () => 1)).toBe(1200);
    expect(getReconnectDelay(0, () => 0.5)).toBe(1100);
    expect(getReconnectDelay(10, () => 1)).toBe(36000);
  });

  it('stays non-negative and finite for every attempt in the retry budget', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = getReconnectDelay(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(Number.isFinite(delay)).toBe(true);
    }
  });
});

describe('CONNECT_TIMEOUT_MS', () => {
  it('gives a handshake long enough to finish but gives up well before a user would', () => {
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
  });
});
