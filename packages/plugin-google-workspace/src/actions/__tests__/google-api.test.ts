import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Drive base URL can be pointed at a local stand-in so the folder scope
 * can be exercised end to end without a Google account. Docs and Sheets stay
 * on Google: only Drive is involved in the scope and the picker.
 */
describe('Google API base URLs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('default to Google', async () => {
    vi.resetModules();
    const { DRIVE_API, DOCS_API, SHEETS_API } = await import('../google-api.js');
    expect(DRIVE_API).toBe('https://www.googleapis.com/drive/v3');
    expect(DOCS_API).toBe('https://docs.googleapis.com/v1');
    expect(SHEETS_API).toBe('https://sheets.googleapis.com/v4/spreadsheets');
  });

  it('point Drive at GOOGLE_DRIVE_API_URL when it is set, and nothing else', async () => {
    vi.stubEnv('GOOGLE_DRIVE_API_URL', 'http://127.0.0.1:47322/drive/v3/');
    vi.resetModules();
    const { DRIVE_API, DOCS_API } = await import('../google-api.js');
    // A trailing slash would double up against the paths the actions append.
    expect(DRIVE_API).toBe('http://127.0.0.1:47322/drive/v3');
    expect(DOCS_API).toBe('https://docs.googleapis.com/v1');
  });
});
