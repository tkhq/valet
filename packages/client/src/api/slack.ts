import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { UserIdentityLink } from '@valet/shared';

// ─── Query Keys ─────────────────────────────────────────────────────────

export const slackKeys = {
  all: ['slack'] as const,
  adminInstall: () => [...slackKeys.all, 'admin-install'] as const,
  userStatus: () => [...slackKeys.all, 'user-status'] as const,
  workspaceUsers: () => [...slackKeys.all, 'workspace-users'] as const,
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

/** Shape returned by both `/me/slack/link` and `/me/slack/link/quick` when
 * the code was DMed. The `dmMessageText` echoes the exact bot DM so the card
 * can show the user what to look for in Slack. */
export interface InitiateSlackLinkResult {
  slackUserId: string;
  slackDisplayName?: string;
  expiresAt: string;
  dmMessageText: string;
}

/** `202` variant of the quick endpoint: the caller's email did not resolve
 * to a workspace member. Not an error — the client falls back to the manual
 * user typeahead. */
export interface QuickSlackLinkFallback {
  reason: 'email_not_in_workspace';
}

export function useInitiateSlackLink() {
  return useMutation({
    mutationFn: (data: { slackUserId: string; slackDisplayName?: string }) =>
      api.post<InitiateSlackLinkResult>('/me/slack/link', data),
  });
}

/** One-click "DM me on Slack" — no body, resolves the caller by email. */
export function useQuickSlackLink() {
  return useMutation({
    mutationFn: () =>
      api.post<InitiateSlackLinkResult | QuickSlackLinkFallback>('/me/slack/link/quick', {}),
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
