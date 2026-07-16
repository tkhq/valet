import { describe, expect, it } from 'vitest';
import {
  canRecallForward,
  canRecallHistory,
  getUserMessageHistory,
  recallNextIndex,
  recallPrevIndex,
  stripFileContextBlocks,
  valueForRecallIndex,
} from './message-history';

describe('stripFileContextBlocks', () => {
  it('leaves a plain prompt untouched', () => {
    expect(stripFileContextBlocks('run the tests')).toBe('run the tests');
  });

  it('removes the inlined file body and keeps the typed prompt', () => {
    const sent = '<file path="src/a.ts">\nconst a = 1;\n</file>\n\nexplain @src/a.ts';

    expect(stripFileContextBlocks(sent)).toBe('explain @src/a.ts');
  });

  it('removes every inlined file when several were mentioned', () => {
    const sent =
      '<file path="a.ts">\nA\n</file>\n\n<file path="b.ts">\nB\n</file>\n\ncompare @a.ts and @b.ts';

    expect(stripFileContextBlocks(sent)).toBe('compare @a.ts and @b.ts');
  });

  it('does not strip a file tag the user typed inside their prompt body', () => {
    const sent = 'why does this print <file path="x">?';

    expect(stripFileContextBlocks(sent)).toBe(sent);
  });
});

describe('getUserMessageHistory', () => {
  it('keeps only user prompts, oldest first', () => {
    const history = getUserMessageHistory([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'sure' },
      { role: 'tool', content: 'ran something' },
      { role: 'user', content: 'second' },
      { role: 'system', content: 'note' },
    ]);

    expect(history).toEqual(['first', 'second']);
  });

  it('drops empty and whitespace-only prompts', () => {
    const history = getUserMessageHistory([
      { role: 'user', content: '' },
      { role: 'user', content: '   \n  ' },
      { role: 'user', content: 'real' },
    ]);

    expect(history).toEqual(['real']);
  });

  it('collapses a prompt that was sent twice in a row', () => {
    const history = getUserMessageHistory([
      { role: 'user', content: 'retry' },
      { role: 'user', content: 'retry' },
      { role: 'user', content: 'done' },
    ]);

    expect(history).toEqual(['retry', 'done']);
  });

  it('keeps a repeated prompt when other prompts came between', () => {
    const history = getUserMessageHistory([
      { role: 'user', content: 'build' },
      { role: 'user', content: 'test' },
      { role: 'user', content: 'build' },
    ]);

    expect(history).toEqual(['build', 'test', 'build']);
  });

  it('recalls the typed prompt rather than the inlined file contents', () => {
    const history = getUserMessageHistory([
      { role: 'user', content: '<file path="src/a.ts">\nconst a = 1;\n</file>\n\nexplain @src/a.ts' },
    ]);

    expect(history).toEqual(['explain @src/a.ts']);
  });

  it('returns nothing for a thread with no user prompts yet', () => {
    expect(getUserMessageHistory([])).toEqual([]);
    expect(getUserMessageHistory([{ role: 'assistant', content: 'hi' }])).toEqual([]);
  });

  it('keeps only the current user\'s prompts in a shared thread', () => {
    const history = getUserMessageHistory(
      [
        { role: 'user', content: 'mine one', authorId: 'me' },
        { role: 'user', content: 'theirs', authorId: 'them' },
        { role: 'user', content: 'mine two', authorId: 'me' },
      ],
      'me',
    );

    expect(history).toEqual(['mine one', 'mine two']);
  });

  it('keeps unattributed prompts so single-player and legacy recall still work', () => {
    const history = getUserMessageHistory(
      [
        { role: 'user', content: 'no author' },
        { role: 'user', content: 'mine', authorId: 'me' },
      ],
      'me',
    );

    expect(history).toEqual(['no author', 'mine']);
  });

  it('does not filter by author when the current user is unknown', () => {
    const history = getUserMessageHistory([
      { role: 'user', content: 'a', authorId: 'x' },
      { role: 'user', content: 'b', authorId: 'y' },
    ]);

    expect(history).toEqual(['a', 'b']);
  });
});

describe('canRecallForward', () => {
  it('steps forward from an empty composer', () => {
    expect(canRecallForward('', 0)).toBe(true);
  });

  it('steps forward when the caret sits at the very end of a recalled prompt', () => {
    expect(canRecallForward('recalled prompt', 'recalled prompt'.length)).toBe(true);
  });

  it('leaves the caret alone before the end so arrowing down through lines still works', () => {
    expect(canRecallForward('some draft', 4)).toBe(false);
    expect(canRecallForward('line one\nline two', 3)).toBe(false);
  });
});

describe('canRecallHistory', () => {
  it('recalls from an empty composer', () => {
    expect(canRecallHistory('', 0)).toBe(true);
  });

  it('recalls when the caret sits at the very start of a draft', () => {
    expect(canRecallHistory('some draft', 0)).toBe(true);
  });

  it('leaves the caret alone mid-draft so arrowing through lines still works', () => {
    expect(canRecallHistory('some draft', 4)).toBe(false);
    expect(canRecallHistory('line one\nline two', 12)).toBe(false);
  });
});

describe('recall navigation', () => {
  const history = ['oldest', 'middle', 'newest'];

  it('starts at the most recent prompt', () => {
    expect(recallPrevIndex(history, null)).toBe(2);
  });

  it('walks back one prompt at a time', () => {
    expect(recallPrevIndex(history, 2)).toBe(1);
    expect(recallPrevIndex(history, 1)).toBe(0);
  });

  it('stops at the oldest prompt instead of wrapping around', () => {
    expect(recallPrevIndex(history, 0)).toBe(0);
  });

  it('does nothing when there is no history to recall', () => {
    expect(recallPrevIndex([], null)).toBe(null);
  });

  it('walks forward one prompt at a time', () => {
    expect(recallNextIndex(history, 0)).toBe(1);
    expect(recallNextIndex(history, 1)).toBe(2);
  });

  it('returns to the draft when stepping forward past the newest prompt', () => {
    expect(recallNextIndex(history, 2)).toBe(null);
  });

  it('stays on the draft when stepping forward from the draft', () => {
    expect(recallNextIndex(history, null)).toBe(null);
  });
});

describe('valueForRecallIndex', () => {
  const history = ['oldest', 'middle', 'newest'];

  it('restores the draft at the draft position', () => {
    expect(valueForRecallIndex(history, null, 'my draft')).toBe('my draft');
  });

  it('shows the recalled prompt at a history position', () => {
    expect(valueForRecallIndex(history, 0, 'my draft')).toBe('oldest');
    expect(valueForRecallIndex(history, 2, 'my draft')).toBe('newest');
  });

  it('falls back to the draft if the index no longer exists', () => {
    expect(valueForRecallIndex(history, 9, 'my draft')).toBe('my draft');
  });
});

describe('recall round trip', () => {
  it('returns the draft untouched after arrowing up and back down', () => {
    const history = getUserMessageHistory([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ]);
    const draft = 'half-written thought';

    let index = recallPrevIndex(history, null);
    expect(valueForRecallIndex(history, index, draft)).toBe('second');

    index = recallPrevIndex(history, index);
    expect(valueForRecallIndex(history, index, draft)).toBe('first');

    index = recallNextIndex(history, index);
    expect(valueForRecallIndex(history, index, draft)).toBe('second');

    index = recallNextIndex(history, index);
    expect(index).toBe(null);
    expect(valueForRecallIndex(history, index, draft)).toBe(draft);
  });
});
