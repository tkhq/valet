/**
 * Where the api reaches the Google Drive API. `GOOGLE_DRIVE_API_URL` points
 * it at a local stand-in (`scripts/dev/drive-fixture.ts`) so the folder
 * picker and the folder scope can be clicked through without a Google
 * account, the way `GITHUB_API_URL` does for GitHub. The plugin reads the
 * same variable (`plugin-google-workspace/src/actions/google-api.ts`).
 */
export function driveApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GOOGLE_DRIVE_API_URL;
  const base = raw && raw.trim().length > 0 ? raw.trim() : "https://www.googleapis.com/drive/v3";
  return base.replace(/\/+$/, "");
}
