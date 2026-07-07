import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentSession, ChannelBinding, ChannelTriggerMode, OrchestratorIdentity, Team, TeamMember, TeamRole } from '@valet/shared';
import { api } from './client';

export interface TeamOrchestratorInfo {
  exists: boolean;
  sessionId: string;
  identity: OrchestratorIdentity | null;
  session: AgentSession | null;
  needsRestart: boolean;
}

export interface DirectoryUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

export const teamKeys = {
  all: ['teams'] as const,
  lists: () => [...teamKeys.all, 'list'] as const,
  list: () => [...teamKeys.lists()] as const,
  details: () => [...teamKeys.all, 'detail'] as const,
  detail: (id: string) => [...teamKeys.details(), id] as const,
  members: (id: string) => [...teamKeys.all, 'members', id] as const,
  directory: () => [...teamKeys.all, 'directory'] as const,
  orchestrator: (id: string) => [...teamKeys.all, 'orchestrator', id] as const,
};

export interface TeamConnection {
  provider: string;
  credentialType: string;
  status: 'active' | 'broken';
  sourcedFromUserId?: string;
  sourcedFromName?: string;
  sourcedFromEmail?: string;
  updatedAt: string;
}

export function useTeamConnections(teamId: string) {
  return useQuery({
    queryKey: [...teamKeys.all, 'integrations', teamId] as const,
    queryFn: () => api.get<{ connections: TeamConnection[] }>(`/teams/${teamId}/integrations`),
    select: (data) => data.connections,
    enabled: !!teamId,
  });
}

export function useShareTeamConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, provider }: { teamId: string; provider: string }) =>
      api.post<{ connection: TeamConnection }>(`/teams/${teamId}/integrations`, { provider }),
    onSuccess: (_r, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: [...teamKeys.all, 'integrations', teamId] });
    },
  });
}

export function useUnshareTeamConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, provider }: { teamId: string; provider: string }) =>
      api.delete<{ success: boolean }>(`/teams/${teamId}/integrations/${encodeURIComponent(provider)}`),
    onSuccess: (_r, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: [...teamKeys.all, 'integrations', teamId] });
    },
  });
}

export function useTeamOrchestrator(teamId: string) {
  return useQuery({
    queryKey: teamKeys.orchestrator(teamId),
    queryFn: () => api.get<TeamOrchestratorInfo>(`/teams/${teamId}/orchestrator`),
    enabled: !!teamId,
    refetchInterval: (query) => (query.state.data?.needsRestart ? 5_000 : false),
  });
}

export interface TeamMemoryListing {
  path: string;
  size: number;
  updatedAt: string;
  pinned: boolean;
}

export interface TeamMemoryFile {
  path: string;
  content: string;
  title: string;
  updatedAt: string;
}

export function useTeamMemoryFiles(teamId: string) {
  return useQuery({
    queryKey: [...teamKeys.all, 'memory', teamId] as const,
    queryFn: () => api.get<{ files: TeamMemoryListing[] }>(`/teams/${teamId}/memory`),
    select: (data) => data.files,
    enabled: !!teamId,
  });
}

export function useTeamMemoryFile(teamId: string, path: string | null) {
  return useQuery({
    queryKey: [...teamKeys.all, 'memory', teamId, path] as const,
    queryFn: () => api.get<{ file: TeamMemoryFile | null }>(`/teams/${teamId}/memory?path=${encodeURIComponent(path ?? '')}`),
    select: (data) => data.file,
    enabled: !!teamId && !!path,
  });
}

export function useWriteTeamMemoryFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, path, content }: { teamId: string; path: string; content: string }) =>
      api.put<{ file: TeamMemoryFile }>(`/teams/${teamId}/memory`, { path, content }),
    onSuccess: (_r, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: [...teamKeys.all, 'memory', teamId] });
    },
  });
}

export function useDeleteTeamMemoryFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, path }: { teamId: string; path: string }) =>
      api.delete<{ deleted: number }>(`/teams/${teamId}/memory?path=${encodeURIComponent(path)}`),
    onSuccess: (_r, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: [...teamKeys.all, 'memory', teamId] });
    },
  });
}

export function useTeamChannels(teamId: string) {
  return useQuery({
    queryKey: [...teamKeys.all, 'channels', teamId] as const,
    queryFn: () => api.get<{ bindings: ChannelBinding[] }>(`/teams/${teamId}/channels`),
    select: (data) => data.bindings,
    enabled: !!teamId,
  });
}

export function useCreateTeamChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, ...data }: { teamId: string; slackChannelId: string; triggerMode?: ChannelTriggerMode }) =>
      api.post<{ binding: ChannelBinding }>(`/teams/${teamId}/channels`, data),
    onSuccess: (_r, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: [...teamKeys.all, 'channels', teamId] });
    },
  });
}

export function useUpdateTeamChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, bindingId, triggerMode }: { teamId: string; bindingId: string; triggerMode: ChannelTriggerMode }) =>
      api.patch<{ success: boolean }>(`/teams/${teamId}/channels/${bindingId}`, { triggerMode }),
    onSuccess: (_r, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: [...teamKeys.all, 'channels', teamId] });
    },
  });
}

export function useDeleteTeamChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, bindingId }: { teamId: string; bindingId: string }) =>
      api.delete<{ success: boolean }>(`/teams/${teamId}/channels/${bindingId}`),
    onSuccess: (_r, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: [...teamKeys.all, 'channels', teamId] });
    },
  });
}

export function useCreateTeamOrchestrator() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, ...data }: { teamId: string; name: string; handle: string; customInstructions?: string }) =>
      api.post<{ sessionId: string }>(`/teams/${teamId}/orchestrator`, data),
    onSuccess: (_response, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.orchestrator(teamId) });
    },
  });
}

export function useRestartTeamOrchestrator() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId }: { teamId: string }) =>
      api.post<{ sessionId: string }>(`/teams/${teamId}/orchestrator/restart`),
    onSuccess: (_response, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.orchestrator(teamId) });
    },
  });
}

export function useTeams() {
  return useQuery({
    queryKey: teamKeys.list(),
    queryFn: () => api.get<{ teams: Team[] }>('/teams'),
    select: (data) => data.teams,
  });
}

export function useTeam(teamId: string) {
  return useQuery({
    queryKey: teamKeys.detail(teamId),
    queryFn: () => api.get<{ team: Team }>(`/teams/${teamId}`),
    select: (data) => data.team,
    enabled: !!teamId,
  });
}

export function useTeamMembers(teamId: string) {
  return useQuery({
    queryKey: teamKeys.members(teamId),
    queryFn: () => api.get<{ members: TeamMember[] }>(`/teams/${teamId}/members`),
    select: (data) => data.members,
    enabled: !!teamId,
  });
}

export function useTeamDirectory() {
  return useQuery({
    queryKey: teamKeys.directory(),
    queryFn: () => api.get<{ users: DirectoryUser[] }>('/teams/directory'),
    select: (data) => data.users,
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      api.post<{ team: Team }>('/teams', data),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
      queryClient.setQueryData(teamKeys.detail(response.team.id), response);
    },
  });
}

export function useUpdateTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, ...data }: { teamId: string; name?: string; description?: string; avatar?: string }) =>
      api.patch<{ team: Team }>(`/teams/${teamId}`, data),
    onSuccess: (_response, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(teamId) });
    },
  });
}

export function useDeleteTeam() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (teamId: string) => api.delete<{ success: boolean }>(`/teams/${teamId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamKeys.all });
    },
  });
}

export function useAddTeamMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, ...data }: { teamId: string; userId?: string; email?: string; role?: TeamRole }) =>
      api.post<{ member: TeamMember }>(`/teams/${teamId}/members`, data),
    onSuccess: (_response, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) });
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(teamId) });
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}

export function useUpdateTeamMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, userId, role }: { teamId: string; userId: string; role: TeamRole }) =>
      api.patch<{ success: boolean }>(`/teams/${teamId}/members/${userId}`, { role }),
    onSuccess: (_response, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) });
    },
  });
}

export function useRemoveTeamMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.delete<{ success: boolean }>(`/teams/${teamId}/members/${userId}`),
    onSuccess: (_response, { teamId }) => {
      queryClient.invalidateQueries({ queryKey: teamKeys.members(teamId) });
      queryClient.invalidateQueries({ queryKey: teamKeys.detail(teamId) });
      queryClient.invalidateQueries({ queryKey: teamKeys.lists() });
    },
  });
}
