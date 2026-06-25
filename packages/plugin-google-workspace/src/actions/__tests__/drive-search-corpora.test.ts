import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeDriveAction } from '../drive-actions.js';
import type { ActionContext } from '@valet/sdk/integrations';

// ─── Mocked Drive API ─────────────────────────────────────────────────────────
//
// End-to-end coverage for the corpora wiring of Drive list/search actions: we
// stub global fetch, run the real action through `executeDriveAction`, and assert
// on the outgoing Drive v3 `files.list` query string + the returned files.
//
// Context: corpora 'user' (the default) is My Drive only and EXCLUDES files that
// live in a Shared Drive (Team Drive). These tests pin the Option-2 behavior:
//   - the default corpus stays 'user' (no org-wide behavior change), AND
//   - opting into 'allDrives' (per-request OR via the org `driveCorpora` setting)
//     actually surfaces a shared-drive doc.

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

interface ListedFile {
  id: string;
  name: string;
  mimeType: string;
  driveId?: string;
  webViewLink?: string;
}

interface DriveData {
  files: ListedFile[];
}

// One file in My Drive, one resident in a Shared Drive (driveId set).
const PERSONAL: ListedFile = {
  id: 'mydrive-1',
  name: 'Personal Note',
  mimeType: 'application/vnd.google-apps.document',
  webViewLink: 'https://docs.google.com/document/d/mydrive-1',
};
const SHARED_DRIVE: ListedFile = {
  id: 'shared-1',
  name: 'Team Roadmap',
  mimeType: 'application/vnd.google-apps.document',
  driveId: 'sd-1',
  webViewLink: 'https://docs.google.com/document/d/shared-1',
};

function mockDriveResponse(files: ListedFile[]): void {
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ files }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function makeCtx(guardConfig?: Record<string, unknown>): ActionContext {
  return { credentials: { access_token: 'test-token' }, userId: 'u1', guardConfig };
}

/** URL of the most recent fetch call. */
function lastUrl(): URL {
  const call = mockFetch.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  return new URL(String(call[0]));
}

function returnedNames(data: unknown): string[] {
  return ((data as DriveData).files ?? []).map((f) => f.name);
}

describe('Drive search corpora wiring (e2e)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the "user" corpus and always sends the all-drives capability flags', async () => {
    // Default config: Google would return only My Drive items for corpora=user.
    mockDriveResponse([PERSONAL]);

    const res = await executeDriveAction('drive.search_files', { query: 'roadmap' }, makeCtx());
    expect(res.success).toBe(true);

    const url = lastUrl();
    // Option 2: the default corpus is unchanged ('user').
    expect(url.searchParams.get('corpora')).toBe('user');
    // Capability flags are present so that, once the corpus is widened, shared-drive
    // items are eligible to come back.
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });

  it('returns shared-drive docs when the caller opts into corpora="allDrives"', async () => {
    // With the widened corpus, Google returns the shared-drive file too.
    mockDriveResponse([PERSONAL, SHARED_DRIVE]);

    const res = await executeDriveAction(
      'drive.search_files',
      { query: 'roadmap', corpora: 'allDrives' },
      makeCtx(),
    );
    expect(res.success).toBe(true);

    expect(lastUrl().searchParams.get('corpora')).toBe('allDrives');
    const names = returnedNames(res.data);
    expect(names).toContain('Team Roadmap'); // previously-missed shared-drive doc
    expect(names).toContain('Personal Note');
  });

  it('uses the org-configured driveCorpora when no per-request value is given', async () => {
    mockDriveResponse([PERSONAL, SHARED_DRIVE]);

    await executeDriveAction(
      'drive.search_documents',
      { query: 'q' },
      makeCtx({ driveCorpora: 'allDrives' }),
    );
    expect(lastUrl().searchParams.get('corpora')).toBe('allDrives');
  });

  it('lets a per-request corpora override the org default', async () => {
    mockDriveResponse([PERSONAL]);

    await executeDriveAction(
      'drive.search_files',
      { query: 'q', corpora: 'user' },
      makeCtx({ driveCorpora: 'allDrives' }),
    );
    expect(lastUrl().searchParams.get('corpora')).toBe('user');
  });

  it('list_files also honors the widened org corpus', async () => {
    mockDriveResponse([PERSONAL, SHARED_DRIVE]);

    await executeDriveAction('drive.list_files', {}, makeCtx({ driveCorpora: 'allDrives' }));
    expect(lastUrl().searchParams.get('corpora')).toBe('allDrives');
  });

  it('rejects the removed "drive" corpus value without calling the Drive API', async () => {
    mockDriveResponse([PERSONAL]);

    const res = await executeDriveAction(
      'drive.search_files',
      { query: 'q', corpora: 'drive' },
      makeCtx(),
    );
    expect(res.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
