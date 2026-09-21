/**
 * Base URLs for the Google APIs this plugin calls.
 *
 * Drive can be pointed at a local stand-in through `GOOGLE_DRIVE_API_URL`,
 * so the folder scope and the folder picker can be exercised end to end
 * without a Google account (`scripts/dev/drive-fixture.ts`; the api reads
 * the same variable for the picker). Docs and Sheets stay on Google: neither
 * is part of the scope. Read once at load, the way the api reads
 * `GITHUB_API_URL`.
 */
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

function fromEnv(name: string, fallback: string): string {
  const raw = env[name];
  const value = raw && raw.trim().length > 0 ? raw.trim() : fallback;
  // A trailing slash would double up against the paths the actions append.
  return value.replace(/\/+$/, '');
}

export const DRIVE_API = fromEnv('GOOGLE_DRIVE_API_URL', 'https://www.googleapis.com/drive/v3');
export const DOCS_API = 'https://docs.googleapis.com/v1';
export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
