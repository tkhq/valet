import { formatPrincipal, type Principal } from './principal.js';

export function webManualScopeKey(owner: Principal, sessionId: string): string {
  return `${formatPrincipal(owner)}:manual:${sessionId}`;
}

export function slackScopeKey(owner: Principal, teamId: string, channelId: string, threadTs: string): string {
  return `${formatPrincipal(owner)}:slack:${teamId}:${channelId}:${threadTs}`;
}

export function githubPrScopeKey(owner: Principal, repoFullName: string, prNumber: number): string {
  return `${formatPrincipal(owner)}:github:${repoFullName}:pr:${prNumber}`;
}

export function apiScopeKey(owner: Principal, idempotencyKey: string): string {
  return `${formatPrincipal(owner)}:api:${idempotencyKey}`;
}

export function channelScopeKey(owner: Principal, channelType: string, channelId: string): string {
  return `${formatPrincipal(owner)}:${channelType}:${channelId}`;
}

export function telegramScopeKey(owner: Principal, chatId: string): string {
  return channelScopeKey(owner, 'telegram', chatId);
}
