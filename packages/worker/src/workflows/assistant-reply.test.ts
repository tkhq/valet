import { describe, expect, it } from 'vitest';
import { pickFinalAssistantReply, replyMayStillArrive } from './assistant-reply.js';

const finished = (content: string) => ({
  role: 'assistant',
  content,
  parts: [{ type: 'text', text: content }, { type: 'finish', reason: 'end_turn' }],
});

describe('pickFinalAssistantReply', () => {
  it('returns the last assistant message on a clean turn', () => {
    const messages = [
      { role: 'user', content: 'go' },
      finished('first'),
      { role: 'user', content: 'more' },
      finished('second'),
    ];
    const result = pickFinalAssistantReply(messages);
    expect(result.ok).toBe(true);
    expect(result.ok && result.message.content).toBe('second');
  });

  it('reports no_assistant_reply when only user messages exist — never falls back to them', () => {
    const result = pickFinalAssistantReply([{ role: 'user', content: 'the prompt itself' }]);
    expect(result).toEqual({ ok: false, reason: 'no_assistant_reply' });
  });

  it('classifies an error part as turn_error with its message', () => {
    const result = pickFinalAssistantReply([
      {
        role: 'assistant',
        content: '',
        parts: [{ type: 'error', message: 'OpenCode prompt sync failed: 500' }, { type: 'finish', reason: 'error' }],
      },
    ]);
    expect(result).toEqual({ ok: false, reason: 'turn_error', error: 'OpenCode prompt sync failed: 500' });
  });

  it('classifies a finish reason error without an error part as turn_error with a fallback message', () => {
    const result = pickFinalAssistantReply([
      { role: 'assistant', content: 'partial', parts: [{ type: 'finish', reason: 'error' }] },
    ]);
    expect(result).toEqual({ ok: false, reason: 'turn_error', error: 'the agent turn ended with an error' });
  });

  it('classifies a canceled turn as turn_error so partial text is never schema-repaired', () => {
    const result = pickFinalAssistantReply([
      { role: 'assistant', content: 'partial strea', parts: [{ type: 'finish', reason: 'canceled' }] },
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('turn_error');
  });

  it('accepts messages with no parts array (legacy transcripts)', () => {
    const result = pickFinalAssistantReply([{ role: 'assistant', content: 'plain' }]);
    expect(result.ok).toBe(true);
  });
});

describe('replyMayStillArrive', () => {
  it('is true when no assistant message has landed yet', () => {
    expect(replyMayStillArrive(pickFinalAssistantReply([{ role: 'user', content: 'go' }]))).toBe(true);
  });

  it('is true for a streaming (finish-less) assistant message', () => {
    const result = pickFinalAssistantReply([
      { role: 'assistant', content: 'strea', parts: [{ type: 'text', text: 'strea', streaming: true }] },
    ]);
    expect(replyMayStillArrive(result)).toBe(true);
  });

  it('is false for legacy messages with no parts array — they will never gain a finish part', () => {
    expect(replyMayStillArrive(pickFinalAssistantReply([{ role: 'assistant', content: 'legacy reply' }]))).toBe(false);
  });

  it('is false for finalized turns and for turn errors (errors are final)', () => {
    expect(replyMayStillArrive(pickFinalAssistantReply([finished('done')]))).toBe(false);
    const errored = pickFinalAssistantReply([
      { role: 'assistant', content: '', parts: [{ type: 'finish', reason: 'error' }] },
    ]);
    expect(replyMayStillArrive(errored)).toBe(false);
  });
});
