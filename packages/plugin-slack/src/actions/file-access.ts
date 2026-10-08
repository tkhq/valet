import type { Credential, PluginActionContext } from '@valet/engine';
import { slackGet } from './api.js';
import { checkPrivateChannelAccess } from './channel-access.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never send a Slack token to arbitrary hosts or through redirects. */
export function slackFileUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'files.slack.com' &&
      !url.port && !url.username && !url.password ? url : undefined;
  } catch { return undefined; }
}

/** Resolve the file with the run's credential, then verify a channel that shares it. */
export async function authorizeSlackFile(
  args: { file_id?: string; url?: string },
  credential: Credential,
  ctx: PluginActionContext,
): Promise<{ url: URL; name: string } | { error: string }> {
  const suppliedUrl = args.url ? slackFileUrl(args.url) : undefined;
  if (args.url && !suppliedUrl) return { error: 'Use a file ID or an HTTPS files.slack.com URL from Slack message data.' };
  const fileId = args.file_id ?? suppliedUrl?.pathname.match(/\/files-(?:pri|tmb)\/[^/]+-(F[A-Z0-9]+)\//)?.[1];
  if (!fileId || !/^F[A-Z0-9]+$/.test(fileId)) return { error: 'Pass file_id from the message files array. Read the Slack message again to get it.' };
  const response = await slackGet('files.info', credential.accessToken, { file: fileId });
  const body: unknown = await response.json();
  if (!response.ok || !record(body) || body.ok !== true) {
    const reason = record(body) && typeof body.error === 'string' ? body.error : String(response.status);
    return { error: `Slack could not inspect this file (${reason}). ${reason === 'missing_scope'
      ? 'Ask an administrator to reinstall the Slack app with files:read.'
      : 'Check the file ID and connected Slack account, then retry.'}` };
  }
  const file = body.file;
  if (!record(file) || file.id !== fileId) return { error: 'Slack returned incomplete file metadata. Read the source message again, then retry.' };
  if (file.is_external === true) return { error: 'This file is hosted outside Slack. Use its connected provider tools to read it.' };
  const rawUrl = typeof file.url_private_download === 'string' ? file.url_private_download : file.url_private;
  const url = typeof rawUrl === 'string' ? slackFileUrl(rawUrl) : undefined;
  if (!url) return { error: 'Slack did not return a supported download URL. Read the source message again, then retry.' };
  const channels = new Set<string>();
  for (const key of ['channels', 'groups', 'ims']) {
    const ids = file[key];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') channels.add(id);
  }
  if (record(file.shares)) {
    for (const scope of ['public', 'private']) {
      const shares = file.shares[scope];
      if (record(shares)) for (const [id, entries] of Object.entries(shares)) {
        if (Array.isArray(entries) && entries.length) channels.add(id);
      }
    }
  }
  const ownerId = credential.metadata?.owner_slack_user_id;
  const errors = new Set<string>();
  for (const channel of channels) {
    const access = await checkPrivateChannelAccess(credential.accessToken, channel,
      typeof ownerId === 'string' ? ownerId : undefined,
      { ownerType: ctx.owner?.type, directIsPrivate: true });
    if (access.allowed) return { url, name: typeof file.name === 'string' ? file.name : url.pathname.split('/').pop() || 'file' };
    if (access.error) errors.add(access.error);
  }
  if (errors.size) return { error: `Slack file access could not be verified. ${[...errors].slice(0, 3).join(' ')} Check the connected account, then retry.` };
  return { error: 'No authorized channel share could be verified for this file. Share it in a channel this run can read, then retry.' };
}
