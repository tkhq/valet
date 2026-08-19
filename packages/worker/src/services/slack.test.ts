/**
 * Tests for narrow, pure helpers in the Slack service. The service itself
 * reaches into D1 and the Slack Web API, so the wider surface is exercised
 * end-to-end in Wrangler local runs — this file covers only what can be
 * asserted without a live worker binding.
 */
import { describe, expect, it } from 'vitest';

// The template lives in its own side-effect-free file so this test does not
// drag in D1 bindings via `../lib/drizzle`. The main `services/slack.ts`
// re-exports the same symbol, so runtime callers see one canonical string.
import { slackLinkDmText } from './slack-link-dm.js';

describe('slackLinkDmText', () => {
  it('embeds the code verbatim, bold, with the paste-in-Valet instruction', () => {
    const dm = slackLinkDmText('AX7K2M');
    // Exact string contract — the connect card echoes this character-for-character.
    expect(dm).toBe(
      'Your Valet verification code is: *AX7K2M*. Paste this in Valet to link your account. Expires in 10 minutes.',
    );
  });

  it('is deterministic — same input, same output — so the card preview matches the DM', () => {
    expect(slackLinkDmText('ABC123')).toBe(slackLinkDmText('ABC123'));
  });

  it('mentions the 10-minute expiry so the user knows the code will not sit forever', () => {
    expect(slackLinkDmText('ZZZZZZ')).toContain('10 minutes');
  });
});
