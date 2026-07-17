import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { SlackUserOAuthStatus, UserIdentityLink } from '@valet/shared';
export type { SlackUserOAuthStatus } from '@valet/shared';

// ─── Query Keys ─────────────────────────────────────────────────────────

export const slackKeys = {
  all: ['slack'] as const,
  adminInstall: () => [...slackKeys.all, 'admin-install'] as const,
  userStatus: () => [...slackKeys.all, 'user-status'] as const,
  workspaceUsers: () => [...slackKeys.all, 'workspace-users'] as const,
  userOAuthStatus: () => [...slackKeys.all, 'user-oauth-status'] as const,
};

// ─── Types ──────────────────────────────────────────────────────────────

export interface SlackInstallStatus {
  installed: boolean;
  teamId?: string;
  teamName?: string;
  botUserId?: string;
  appId?: string;
  hasSigningSecret?: boolean;
  installedBy?: string;
  createdAt?: string;
}

export interface SlackUserStatus {
  installed: boolean;
  teamName: string | null;
  linked: boolean;
  slackUserId: string | null;
  slackDisplayName: string | null;
}

export interface SlackWorkspaceUser {
  id: string;
  displayName: string;
  realName: string;
  avatar: string | null;
}

// ─── Admin Hooks ────────────────────────────────────────────────────────

export function useSlackInstallStatus() {
  return useQuery({
    queryKey: slackKeys.adminInstall(),
    queryFn: () => api.get<SlackInstallStatus>('/admin/slack'),
    staleTime: 60_000,
  });
}

export function useInstallSlack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { botToken: string; signingSecret?: string }) =>
      api.post<{ install: SlackInstallStatus }>('/admin/slack', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: slackKeys.all });
    },
  });
}

export function useUninstallSlack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.delete<{ success: boolean }>('/admin/slack'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: slackKeys.all });
    },
  });
}

// ─── User Hooks ─────────────────────────────────────────────────────────

export function useSlackUserStatus() {
  return useQuery({
    queryKey: slackKeys.userStatus(),
    queryFn: () => api.get<SlackUserStatus>('/me/slack'),
    staleTime: 30_000,
  });
}

export function useSlackWorkspaceUsers() {
  return useQuery({
    queryKey: slackKeys.workspaceUsers(),
    queryFn: () =>
      api.get<{ users: SlackWorkspaceUser[] }>('/me/slack/users'),
    select: (data) => data.users,
    staleTime: 120_000,
  });
}

export function useInitiateSlackLink() {
  return useMutation({
    mutationFn: (data: { slackUserId: string; slackDisplayName?: string }) =>
      api.post<{ slackUserId: string; expiresAt: string }>('/me/slack/link', data),
  });
}

export function useVerifySlackLink() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { code: string }) =>
      api.post<{ identityLink: UserIdentityLink }>('/me/slack/verify', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: slackKeys.userStatus() });
    },
  });
}

export function useUnlinkSlack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.delete<{ success: boolean }>('/me/slack/link'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: slackKeys.userStatus() });
    },
  });
}

// ─── Slack (personal) — per-user OAuth (xoxp) ───────────────────────────
//
// This is a SEPARATE integration from the org Slack bot above. It acts AS the
// user (search their messages, post as them, set their status, etc.). The bot
// integration is unchanged. See packages/plugin-slack-user. The status type
// lives in @valet/shared so the worker and client agree on the wire shape.

export function useSlackUserOAuthStatus() {
  return useQuery({
    queryKey: slackKeys.userOAuthStatus(),
    queryFn: () => api.get<SlackUserOAuthStatus>('/me/slack-user'),
    staleTime: 30_000,
  });
}

/**
 * Kick off the Slack (personal) OAuth flow. The server returns a Slack
 * authorize URL with a signed state token; we redirect the browser to it.
 * Slack then redirects back to the worker's `/auth/slack-user/callback`,
 * which exchanges the code and redirects here with
 * `/integrations?slack_user=claim&claim=…` — redeemed by useClaimSlackUser.
 */
export function useStartSlackUserOAuth() {
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<{ authorizeUrl: string }>('/me/slack-user/oauth/start', {});
      window.location.href = res.authorizeUrl;
      return res;
    },
  });
}

/**
 * Redeem the claim blob the OAuth callback handed back via the redirect.
 * The worker binds the Slack credential only if the blob was issued for the
 * authenticated user — this call is the final, authenticated step of the
 * connect flow.
 */
export function useClaimSlackUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (claim: string) =>
      api.post<{ linked: boolean; teamName: string | null }>('/me/slack-user/oauth/claim', { claim }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: slackKeys.userOAuthStatus() });
    },
  });
}

export function useDisconnectSlackUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ success: boolean }>('/me/slack-user/oauth'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: slackKeys.userOAuthStatus() });
    },
  });
}
