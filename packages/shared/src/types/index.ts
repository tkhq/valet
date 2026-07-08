import type { MessagePart } from './message-parts.js';

// Integration types
export type IntegrationService =
  | 'github'
  | 'gmail'
  | 'google_calendar'
  | 'google_workspace'
  | 'notion'
  | 'linear'
  | 'hubspot'
  | 'ashby'
  | 'discord'
  | 'slack'
  | 'xero';

export interface Integration {
  id: string;
  userId: string;
  service: string;
  config: IntegrationConfig;
  status: 'active' | 'error' | 'pending' | 'disconnected';
  scope: 'user' | 'org';
  createdAt: Date;
  updatedAt: Date;
}

export interface IntegrationConfig {
  entities: string[];
  filters?: Record<string, unknown>;
}

// EventBus types
export type EventBusEventType =
  | 'session.update'
  | 'session.started'
  | 'session.completed'
  | 'session.errored'
  | 'sandbox.status'
  | 'question.asked'
  | 'question.answered'
  | 'notification'
  | 'action.approval_required'
  | 'action.approved'
  | 'action.denied'
  | 'thread.created'
  | 'thread.updated';

export interface EventBusEvent {
  type: EventBusEventType;
  sessionId?: string;
  userId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// Question types
export type QuestionStatus = 'pending' | 'answered' | 'expired';

export interface AgentQuestion {
  id: string;
  sessionId: string;
  text: string;
  options?: string[];
  status: QuestionStatus;
  answer?: string | boolean;
  createdAt: Date;
  answeredAt?: Date;
  expiresAt?: Date;
}

// Git state types
export type SessionSourceType = 'pr' | 'issue' | 'branch' | 'manual';
export type PRState = 'draft' | 'open' | 'closed' | 'merged';

export interface SessionGitState {
  id: string;
  sessionId: string;
  sourceType: SessionSourceType | null;
  sourcePrNumber: number | null;
  sourceIssueNumber: number | null;
  sourceRepoFullName: string | null;
  sourceRepoUrl: string | null;
  branch: string | null;
  ref: string | null;
  baseBranch: string | null;
  commitCount: number;
  prNumber: number | null;
  prTitle: string | null;
  prState: PRState | null;
  prUrl: string | null;
  prCreatedAt: string | null;
  prMergedAt: string | null;
  agentAuthored: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdoptionMetrics {
  totalPRsCreated: number;
  totalPRsMerged: number;
  mergeRate: number;
  totalCommits: number;
}

// Session files changed tracking
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface SessionFileChanged {
  id: string;
  sessionId: string;
  filePath: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
}

// Child session summary (for parent session sidebar)
export interface ChildSessionSummary {
  id: string;
  title?: string;
  status: SessionStatus;
  workspace: string;
  prNumber?: number;
  prState?: PRState;
  prUrl?: string;
  createdAt: string;
}

export interface ListChildSessionsResponse {
  children: ChildSessionSummary[];
  cursor?: string;
  hasMore: boolean;
  totalCount: number;
}

// Session types
export type SessionStatus =
  | 'initializing'
  | 'running'
  | 'idle'
  | 'waiting_runner'
  | 'recovering'
  | 'backoff'
  | 'hibernating'
  | 'hibernated'
  | 'restoring'
  | 'terminated'
  | 'archived'
  | 'error';

/** Session statuses that indicate the session is no longer active. */
export const TERMINAL_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  'terminated',
  'archived',
  'error',
]);

export type SessionPurpose = 'interactive' | 'orchestrator' | 'workflow';

// Lightweight participant info for list views
export interface SessionParticipantSummary {
  userId: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  role: SessionParticipantRole;
}

export interface AgentSession {
  id: string;
  userId: string;
  workspace: string;
  status: SessionStatus;
  purpose?: SessionPurpose;
  title?: string;
  parentSessionId?: string;
  parentThreadId?: string;
  containerId?: string;
  sandboxId?: string;
  tunnelUrls?: Record<string, string>;
  tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }>;
  gatewayUrl?: string;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: Date;
  lastActiveAt: Date;
  // Owner info (populated in list views)
  ownerName?: string;
  ownerEmail?: string;
  ownerAvatarUrl?: string;
  // Participant summary (populated in list views)
  participantCount?: number;
  participants?: SessionParticipantSummary[];
  // Persona info
  personaId?: string;
  personaName?: string;
  // Orchestrator flag
  isOrchestrator?: boolean;
  // Cumulative active seconds (excludes hibernation time)
  activeSeconds?: number;
  // Convenience flag for current user
  isOwner?: boolean;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  parts?: MessagePart[];
  authorId?: string;
  authorEmail?: string;
  authorName?: string;
  authorAvatarUrl?: string;
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  threadId?: string;
  createdAt: Date;
}

// Thread types
export type ThreadStatus = 'active' | 'archived';

export interface SessionThread {
  id: string;
  sessionId: string;
  opencodeSessionId?: string;
  originType?: string;
  originChannelType?: string;
  originChannelId?: string;
  originTriggerId?: string;
  originTriggerType?: string;
  title?: string;
  summaryAdditions: number;
  summaryDeletions: number;
  summaryFiles: number;
  status: ThreadStatus;
  messageCount: number;
  firstMessagePreview?: string;
  channelType?: string;
  channelId?: string;
  createdAt: Date;
  lastActiveAt: Date;
}

export interface ListThreadsResponse {
  threads: SessionThread[];
  cursor?: string;
  hasMore: boolean;
  page?: number;
  pageSize?: number;
  totalCount?: number;
  totalPages?: number;
}

// Diff types
export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  diff?: string;
}

// Auth types
export type AuthProvider = 'github' | 'google';

// User & Organization types
export type UserRole = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  githubId?: string;
  githubUsername?: string;
  gitName?: string;
  gitEmail?: string;
  onboardingCompleted?: boolean;
  idleTimeoutSeconds?: number;
  sandboxCpuCores?: number;
  sandboxMemoryMib?: number;
  modelPreferences?: string[];
  uiQueueMode?: QueueMode;
  timezone?: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

// Session participant types (multiplayer)
export type SessionParticipantRole = 'owner' | 'collaborator' | 'viewer';

export interface SessionParticipant {
  id: string;
  sessionId: string;
  userId: string;
  role: SessionParticipantRole;
  addedBy?: string;
  createdAt: Date;
  // Joined from users table:
  userName?: string;
  userEmail?: string;
  userAvatarUrl?: string;
}

export interface SessionShareLink {
  id: string;
  sessionId: string;
  token: string;
  role: SessionParticipantRole;
  createdBy: string | null;
  expiresAt?: Date;
  maxUses?: number;
  useCount: number;
  active: boolean;
  createdAt: Date;
}

export type SessionVisibility = 'private' | 'org_visible' | 'org_joinable';

export interface OrgSettings {
  id: string;
  name: string;
  allowedEmailDomain?: string;
  allowedEmails?: string;
  domainGatingEnabled: boolean;
  emailAllowlistEnabled: boolean;
  defaultSessionVisibility: SessionVisibility;
  modelPreferences?: string[];
  enabledLoginProviders?: string[];
  driveLabelsGuardEnabled: boolean;
  driveRequiredLabelIds: string[];
  driveLabelsFailMode: 'deny' | 'allow';
  driveCorpora: 'user' | 'domain' | 'allDrives';
  createdAt: Date;
  updatedAt: Date;
}

export interface OrgApiKey {
  id: string;
  provider: string;
  isSet: boolean;
  models?: Array<{ id: string; name?: string }>;
  showAllModels: boolean;
  setBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserCredential {
  id: string;
  provider: string;
  isSet: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Invite {
  id: string;
  code: string;
  email?: string;
  role: UserRole;
  invitedBy: string | null;
  acceptedAt?: Date;
  acceptedBy?: string;
  expiresAt: Date;
  createdAt: Date;
}

// Dashboard types
export interface DashboardHeroStats {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  uniqueRepos: number;
  totalToolCalls: number;
  totalSessionDurationSeconds: number;
  avgSessionDurationSeconds: number;
  estimatedLinesChanged: number;
  sessionHours: number;
}

export interface DashboardDelta {
  sessions: number;
  messages: number;
}

export interface DashboardDayActivity {
  date: string;
  sessions: number;
  messages: number;
}

export interface DashboardTopRepo {
  workspace: string;
  sessionCount: number;
  messageCount: number;
}

export interface DashboardRecentSession {
  id: string;
  workspace: string;
  status: SessionStatus;
  messageCount: number;
  toolCallCount: number;
  durationSeconds: number;
  createdAt: string;
  lastActiveAt: string;
  errorMessage?: string;
}

export interface DashboardActiveSession {
  id: string;
  workspace: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt: string;
}

export interface DashboardStatsResponse {
  hero: DashboardHeroStats;
  userHero: DashboardHeroStats;
  delta: DashboardDelta;
  activity: DashboardDayActivity[];
  topRepos: DashboardTopRepo[];
  recentSessions: DashboardRecentSession[];
  activeSessions: DashboardActiveSession[];
  period: number;
}

// API Request/Response types
export interface CreateSessionRequest {
  workspace: string;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  title?: string;
  parentSessionId?: string;
  config?: {
    memory?: string;
    timeout?: number;
  };
  sourceType?: SessionSourceType;
  sourcePrNumber?: number;
  sourceIssueNumber?: number;
  sourceRepoFullName?: string;
  initialPrompt?: string;
  initialModel?: string;
  personaId?: string;
}

export interface CreateSessionResponse {
  session: AgentSession;
  websocketUrl: string;
  tunnelUrls?: Record<string, string>;
}

export interface SendMessageRequest {
  content: string;
  attachments?: Attachment[];
}

export interface Attachment {
  type: 'file' | 'url';
  name: string;
  data: string;
  mimeType?: string;
}

export type SessionOwnershipFilter = 'all' | 'mine' | 'shared';

export interface ListSessionsResponse {
  sessions: AgentSession[];
  cursor?: string;
  hasMore: boolean;
}

export interface ConfigureIntegrationRequest {
  service: string;
  credentials: Record<string, string>;
  config: IntegrationConfig;
}

export type CustomMcpConnectorAuthType = 'none' | 'oauth' | 'api_key' | 'bearer';
export type CustomMcpConnectorCredentialScope = 'org' | 'user';
export type CustomMcpConnectorApiKeyPlacement = 'header' | 'query';

export type CustomMcpConnectorTokenEndpointAuthMethod =
  | 'none'
  | 'client_secret_basic'
  | 'client_secret_post';

export interface CustomMcpConnector {
  id: string;
  orgId: string;
  serviceSlug: string;
  displayName: string;
  serverUrl: string;
  authType: CustomMcpConnectorAuthType;
  credentialScope: CustomMcpConnectorCredentialScope;
  oauthClientId: string | null;
  oauthTokenEndpointAuthMethod: CustomMcpConnectorTokenEndpointAuthMethod;
  oauthScopes: string | null;
  oauthAuthorizationEndpoint: string | null;
  oauthTokenEndpoint: string | null;
  apiKeyPlacement: CustomMcpConnectorApiKeyPlacement;
  apiKeyHeaderName: string | null;
  apiKeyPrefix: string | null;
  apiKeyQueryParam: string | null;
  status: 'active' | 'disabled' | 'error';
  toolCount?: number;
  lastDiscoveredAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  hasClientSecret: boolean;
  hasApiKey: boolean;
  hasAdditionalHeaders: boolean;
}

export interface CreateCustomMcpConnectorRequest {
  displayName: string;
  serverUrl: string;
  authType: CustomMcpConnectorAuthType;
  credentialScope?: CustomMcpConnectorCredentialScope;
  oauthClientId?: string | null;
  oauthClientSecret?: string;
  oauthTokenEndpointAuthMethod?: CustomMcpConnectorTokenEndpointAuthMethod | 'auto';
  oauthScopes?: string | null;
  oauthAuthorizationEndpoint?: string | null;
  oauthTokenEndpoint?: string | null;
  apiKey?: string;
  apiKeyPlacement?: CustomMcpConnectorApiKeyPlacement;
  apiKeyHeaderName?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyQueryParam?: string | null;
  additionalHeaders?: Record<string, string>;
  status?: 'active' | 'disabled';
}

export interface UpdateCustomMcpConnectorRequest {
  displayName?: string;
  serverUrl?: string;
  authType?: CustomMcpConnectorAuthType;
  credentialScope?: CustomMcpConnectorCredentialScope;
  oauthClientId?: string | null;
  oauthClientSecret?: string;
  clearClientSecret?: boolean;
  oauthTokenEndpointAuthMethod?: CustomMcpConnectorTokenEndpointAuthMethod | 'auto';
  oauthScopes?: string | null;
  oauthAuthorizationEndpoint?: string | null;
  oauthTokenEndpoint?: string | null;
  apiKey?: string;
  apiKeyPlacement?: CustomMcpConnectorApiKeyPlacement;
  apiKeyHeaderName?: string | null;
  apiKeyPrefix?: string | null;
  apiKeyQueryParam?: string | null;
  additionalHeaders?: Record<string, string>;
  clearAdditionalHeaders?: boolean;
  status?: 'active' | 'disabled' | 'error';
}

// Custom LLM provider types
export interface CustomProviderModel {
  id: string;
  name?: string;
  contextLimit?: number;
  outputLimit?: number;
}

export interface CustomProvider {
  id: string;
  providerId: string;
  displayName: string;
  baseUrl: string;
  hasKey: boolean;
  models: CustomProviderModel[];
  showAllModels: boolean;
  setBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// Webhook types
export interface WebhookPayload {
  service: IntegrationService;
  event: string;
  data: unknown;
  timestamp: Date;
}

// GitHub-specific types
export namespace GitHub {
  export interface Repository {
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    description: string | null;
    url: string;
    defaultBranch: string;
  }

  export interface Issue {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    labels: string[];
    assignees: string[];
    createdAt: Date;
    updatedAt: Date;
  }

  export interface PullRequest {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed' | 'merged';
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    createdAt: Date;
    updatedAt: Date;
    mergedAt: Date | null;
  }

  export interface SyncConfig {
    repositories?: string[];
    syncIssues: boolean;
    syncPullRequests: boolean;
    syncCommits: boolean;
  }
}

// Gmail-specific types
export namespace Gmail {
  export interface Email {
    id: string;
    threadId: string;
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    bodyHtml?: string;
    snippet: string;
    labels: string[];
    date: Date;
    attachments: Attachment[];
    isUnread: boolean;
    isStarred: boolean;
  }

  export interface Attachment {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
  }

  export interface SendEmailOptions {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
    bodyHtml?: string;
    replyTo?: string;
    threadId?: string;
    attachments?: Array<{
      filename: string;
      mimeType: string;
      data: string;
    }>;
  }

  export interface Label {
    id: string;
    name: string;
    type: 'system' | 'user';
  }

  export interface SyncConfig {
    syncMessages: boolean;
    syncLabels: boolean;
    labelFilter?: string[];
  }
}

// Google Calendar-specific types
export namespace GoogleCalendar {
  export interface Calendar {
    id: string;
    summary: string;
    description?: string;
    timeZone: string;
    primary?: boolean;
    accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  }

  export interface Event {
    id: string;
    calendarId: string;
    title: string;
    description?: string;
    location?: string;
    start: Date;
    end: Date;
    isAllDay: boolean;
    timeZone?: string;
    attendees: Attendee[];
    organizer?: { email: string; name?: string };
    meetingLink?: string;
    recurrence?: string[];
    status: 'confirmed' | 'tentative' | 'cancelled';
    htmlLink: string;
  }

  export interface Attendee {
    email: string;
    name?: string;
    status: 'needsAction' | 'declined' | 'tentative' | 'accepted';
    isOrganizer: boolean;
  }

  export interface CreateEventOptions {
    calendarId?: string;
    title: string;
    description?: string;
    location?: string;
    start: Date | string;
    end: Date | string;
    isAllDay?: boolean;
    timeZone?: string;
    attendees?: Array<{ email: string; optional?: boolean }>;
    sendUpdates?: 'all' | 'externalOnly' | 'none';
  }

  export interface FreeBusySlot {
    start: Date;
    end: Date;
  }

  export interface SyncConfig {
    syncCalendars: boolean;
    syncEvents: boolean;
    calendarIds?: string[];
  }
}

// Org repository types
export interface OrgRepository {
  id: string;
  orgId: string;
  provider: string;
  owner: string;
  name: string;
  fullName: string;
  description?: string;
  defaultBranch: string;
  language?: string;
  topics?: string[];
  enabled: boolean;
  personaId?: string;
  personaName?: string;
  createdAt: string;
  updatedAt: string;
}

// Agent persona types
export type PersonaVisibility = 'private' | 'shared';

export interface AgentPersona {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  icon?: string;
  defaultModel?: string;
  visibility: PersonaVisibility;
  isDefault: boolean;
  createdBy: string | null;
  creatorName?: string;
  files?: AgentPersonaFile[];
  fileCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPersonaFile {
  id: string;
  personaId: string;
  filename: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// Orchestrator types
export type OrchestratorType = 'personal' | 'org';

export interface OrchestratorIdentity {
  id: string;
  userId?: string;
  orgId: string;
  type: OrchestratorType;
  name: string;
  handle: string;
  avatar?: string;
  customInstructions?: string;
  personaId?: string;
  createdAt: string;
  updatedAt: string;
}

// Memory file system types
export interface MemoryFile {
  id: string;
  userId: string;
  orgId: string;
  path: string;
  content: string;
  title: string;
  type: string;
  description: string;
  tags: string[];
  resource: string;
  extras: Record<string, string>;
  sensitivity: 'private' | 'shareable';
  origin: '' | 'user-stated' | 'inferred' | 'imported';
  sourceSessionId: string;
  expires: string | null;
  relevance: number;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
}

export interface MemoryFileListing {
  path: string;
  size: number;
  updatedAt: string;
  pinned: boolean;
  type: string;
  description: string;
  tags: string[];
  resource: string;
  sensitivity: 'private' | 'shareable';
  expires: string | null;
}

export interface MemoryLink {
  fromPath: string;
  toPath: string;
  context: string;
}

/** One ring of link neighbors returned by `GET /me/memory/links`. */
export interface MemoryLinkNeighbor {
  path: string;
  title: string;
  type: string;
  description: string;
  context?: string;
  phantom: boolean;
  relation: 'out' | 'in' | 'session';
}

export interface MemoryGraphNode {
  id: string;
  kind: 'concept' | 'resource' | 'phantom' | 'session' | 'tag';
  path?: string;
  title?: string;
  type?: string;
  topDir?: string;
  label?: string;
}

export interface MemoryGraphEdge {
  from: string;
  to: string;
  kind: 'link' | 'session' | 'resource' | 'containment';
  context?: string;
}

export interface MemoryGraph {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
}

export type PatchOperation =
  | { op: 'append'; content: string }
  | { op: 'prepend'; content: string }
  | { op: 'replace'; old: string; new: string }
  | { op: 'replace_all'; old: string; new: string }
  | { op: 'insert_after'; anchor: string; content: string }
  | { op: 'delete_section'; heading: string };

export interface PatchResult {
  content: string;
  version: number;
  applied: number;
  skipped: string[];
  warnings: string[];
}

export interface MemoryFileSearchResult {
  path: string; snippet: string; relevance: number;
  title: string; type: string; description: string; tags: string[];
  resource: string; inboundLinks: number; expired: boolean;
}

export interface MemorySearchOptions { pathPrefix?: string; resource?: string; includeExpired?: boolean; limit?: number }

/** One entry in an OKF export manifest: the rendered document plus sync state. */
export interface MemoryExportEntry {
  /** Full rendered OKF document (frontmatter projection + body). */
  content: string;
  /** SHA-256 hex of `content` — the sync change-detection primitive. */
  hash: string;
  /**
   * Instance-local state that never appears in frontmatter (the manifest
   * sidecar). Omitted for shareable exports and for generated index files.
   */
  valetState?: { pinned: boolean; relevance: number; version: number; sourceSessionId: string };
}

/**
 * Portable OKF bundle of a user's orchestrator memory. Produced by
 * `GET /api/me/memory/export` and consumed by `POST /api/me/memory/import`.
 * Deterministic: export → import (trusted) → export yields an identical manifest.
 */
export interface MemoryExportManifest {
  okfVersion: '0.1';
  include: 'all' | 'shareable';
  /** path → entry, keys sorted; includes generated `index.md` per directory. */
  files: Record<string, MemoryExportEntry>;
  /** Shareable files whose bodies link to private paths (residual leak flags). */
  leakFlags: string[];
}

/** Outcome of a mem_move operation. */
export interface MemoryMoveResult {
  from: string;
  to: string;
  pinnedBefore: boolean;
  pinnedAfter: boolean;
  /** The file's current type (carried through the move unchanged). */
  type: string;
  /** Directory-default type for the destination (hints at reclassify when it differs from type). */
  typeDefaultForDest: string;
  referencersUpdated: number;
  /** Paths of referencing files that lost the RMW version-guard race and were skipped. */
  referencersSkipped: string[];
}

/** Outcome of importing a memory bundle. */
export interface MemoryImportResult {
  imported: number;
  skipped: { path: string; reason: string }[];
  /**
   * Non-pinned files removed by the 200-file memory cap after the import.
   * Normally 0 — only non-zero when an import pushes the account's non-pinned
   * file count past the cap (e.g. merging into an already-large account).
   */
  pruned: number;
  /** normalized original path → final stored path, for every remap (lib/, log.md, depth). */
  renamed: Record<string, string>;
  /** Unknown `valet.*` sub-keys dropped by the disposition policy (deduped). */
  droppedValetKeys: string[];
  /** `okf_version` read from the bundle's root index, when present. */
  okfVersion: string | null;
}

export interface OrchestratorInfo {
  sessionId: string;
  identity: OrchestratorIdentity | null;
  session: AgentSession | null;
  exists: boolean;
}

// ─── Phase C: Messaging + Coordination Types ─────────────────────────────

// Mailbox types (cross-session/cross-user persistent messaging)
export type MailboxMessageType = 'message' | 'notification' | 'question' | 'escalation' | 'approval';

export interface MailboxMessage {
  id: string;
  fromSessionId?: string;
  fromUserId?: string;
  toSessionId?: string;
  toUserId?: string;
  messageType: MailboxMessageType;
  content: string;
  contextSessionId?: string;
  contextTaskId?: string;
  replyToId?: string;
  read: boolean;
  createdAt: string;
  updatedAt: string;
  // Joined display names (populated in queries)
  fromSessionTitle?: string;
  fromUserName?: string;
  fromUserEmail?: string;
  toSessionTitle?: string;
  toUserName?: string;
  // Thread summary fields (populated in inbox list query only)
  replyCount?: number;
  lastActivityAt?: string;
}

// Session task types (orchestrator-scoped task board)
export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface SessionTask {
  id: string;
  orchestratorSessionId: string;
  sessionId?: string;
  title: string;
  description?: string;
  status: SessionTaskStatus;
  result?: string;
  parentTaskId?: string;
  blockedBy?: string[];
  createdAt: string;
  updatedAt: string;
  // Joined display info
  sessionTitle?: string;
}

// User notification preferences
export interface UserNotificationPreference {
  id: string;
  userId: string;
  messageType: MailboxMessageType;
  // Event-specific key within messageType, '*' means "all events in this type".
  eventType: string;
  webEnabled: boolean;
  slackEnabled: boolean;
  emailEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Phase D: Channel System Types ──────────────────────────────────────

export type ChannelType = 'web' | 'slack' | 'github' | 'api' | 'telegram';
export type QueueMode = 'followup' | 'collect' | 'steer';

export interface ChannelMessage {
  channelType: ChannelType;
  channelId: string;
  scopeKey: string;
  userId?: string;
  externalUserId?: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface UserIdentityLink {
  id: string;
  userId: string;
  provider: string;
  externalId: string;
  externalName?: string;
  teamId?: string;
  createdAt: string;
}

export interface ChannelBinding {
  id: string;
  sessionId: string;
  channelType: ChannelType;
  channelId: string;
  scopeKey: string;
  userId?: string;
  orgId: string;
  queueMode: QueueMode;
  collectDebounceMs: number;
  slackChannelId?: string;
  slackThreadTs?: string;
  githubRepoFullName?: string;
  githubPrNumber?: number;
  createdAt: string;
}

// ─── Telegram Config Types ───────────────────────────────────────────────────

export interface UserTelegramConfig {
  id: string;
  userId: string;
  botUsername: string;
  botInfo: string;
  webhookActive: boolean;
  ownerTelegramUserId?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Slash Command Registry ──────────────────────────────────────────────────

export type SlashCommandHandler = 'local' | 'websocket' | 'api' | 'opencode';
export type SlashCommandChannel = 'ui' | 'telegram' | 'slack';
export type SlashCommandCategory = 'Agent' | 'Session' | 'OpenCode';

export interface SlashCommand {
  name: string;
  description: string;
  handler: SlashCommandHandler;
  availableIn: SlashCommandChannel[];
  args?: string;
  category: SlashCommandCategory;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'List available commands', handler: 'local', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'model', description: 'Switch AI model', handler: 'local', availableIn: ['ui'], args: '[query]', category: 'Session' },
  { name: 'diff', description: 'Show git changes since session start', handler: 'websocket', availableIn: ['ui'], category: 'Agent' },
  { name: 'review', description: 'Code review of changed files', handler: 'websocket', availableIn: ['ui'], category: 'Agent' },
  { name: 'stop', description: 'Abort current agent work', handler: 'websocket', availableIn: ['ui', 'telegram', 'slack'], category: 'Agent' },
  { name: 'clear', description: 'Clear prompt queue', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'status', description: 'Show session status + children', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'refresh', description: 'Restart orchestrator session', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'sessions', description: 'List child sessions with status', handler: 'api', availableIn: ['ui', 'telegram', 'slack'], category: 'Session' },
  { name: 'undo', description: 'Undo last agent change', handler: 'opencode', availableIn: ['ui'], category: 'OpenCode' },
  { name: 'redo', description: 'Redo last undo', handler: 'opencode', availableIn: ['ui'], category: 'OpenCode' },
  { name: 'compact', description: 'Compact/summarize conversation', handler: 'opencode', availableIn: ['ui'], category: 'OpenCode' },
  { name: 'new-session', description: 'Start fresh AI context (keeps history)', handler: 'websocket', availableIn: ['ui'], category: 'Session' },
];

// Model discovery types
export interface ProviderModelEntry { id: string; name: string }
export interface ProviderModels { provider: string; models: ProviderModelEntry[] }
export type AvailableModels = ProviderModels[];

// ─── Action Policy Types ────────────────────────────────────────────────────

export type ActionMode = 'allow' | 'require_approval' | 'deny';
export type ActionInvocationStatus = 'pending' | 'approved' | 'denied' | 'executed' | 'failed' | 'expired';
export type ActionRiskLevel = 'low' | 'medium' | 'high' | 'critical';
// Registry-backed IntegrationPackage.service id, e.g. "gmail" or "linear".
export type ActionServiceId = string;
export type ActionPolicyLifetime = 'persistent' | 'session' | 'timed';
export type ActionPolicySource = 'settings' | 'approval_prompt';
export type EffectivePolicySource = 'system_default' | 'org_policy' | 'user_override' | 'session_override';
export type ActionPolicyScope = 'action' | 'service' | 'risk_level' | 'none';

export interface ActionPolicy {
  id: string;
  service?: ActionServiceId;
  actionId?: string;
  riskLevel?: ActionRiskLevel;
  mode: ActionMode;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParamMatcher {
  path: string;
  op: 'eq' | 'neq' | 'regex' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'not_exists';
  value?: unknown;
}

export interface ActionPolicyOverride {
  id: string;
  userId: string;
  service?: ActionServiceId | null;
  actionId?: string | null;
  riskLevel?: ActionRiskLevel | null;
  mode: ActionMode;
  /** Context conditional — defaults to 'any'. */
  appliesIn: 'any' | 'workflow' | 'session';
  /** Param matchers; all must evaluate true for the policy to fire. */
  paramMatchers: ParamMatcher[];
  lifetime: ActionPolicyLifetime;
  sessionId?: string | null;
  expiresAt?: string | null;
  source: ActionPolicySource;
  sourceInvocationId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisabledAction {
  id: string;
  service: ActionServiceId;
  actionId?: string | null;
  disabledBy: string | null;
  createdAt: string;
}

export interface ActionInvocation {
  id: string;
  sessionId: string;
  userId: string;
  service: ActionServiceId;
  actionId: string;
  riskLevel: ActionRiskLevel;
  resolvedMode: ActionMode;
  status: ActionInvocationStatus;
  params?: string;
  result?: string;
  error?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  executedAt?: string;
  expiresAt?: string;
  policyId?: string;
  orgPolicyId?: string | null;
  baseMode?: ActionMode | null;
  baseSource?: 'org_policy' | 'system_default' | null;
  userOverrideId?: string | null;
  policySource?: EffectivePolicySource | null;
  policyLifetime?: ActionPolicyLifetime | null;
  policyScope?: ActionPolicyScope | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Usage & Cost Types ──────────────────────────────────────────────────────

export interface UsageStatsResponse {
  hero: {
    totalCost: number | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalSessions: number;
    totalUsers: number;
    sandboxCost: number;
    sandboxActiveSeconds: number;
  };
  costByDay: Array<{
    date: string;
    cost: number | null;
    inputTokens: number;
    outputTokens: number;
    sandboxCost: number;
    sandboxActiveSeconds: number;
  }>;
  byUser: Array<{
    userId: string;
    email: string;
    name?: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    sessionCount: number;
    sandboxCost: number;
    sandboxActiveSeconds: number;
  }>;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    callCount: number;
    percentage: number;
  }>;
  /** Per-user, per-model usage — lets the UI drill into who is using which models. */
  byUserModel: Array<{
    userId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    callCount: number;
  }>;
  /** Usage grouped by session origin: interactive (user sessions) vs automated
   *  (workflow: scheduled triggers / webhooks / manual runs) vs orchestrator. */
  byPurpose: Array<{
    purpose: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    callCount: number;
    percentage: number;
  }>;
  /** Per-automation drill-down for the "automated" (workflow) origin: which specific
   *  workflow produced the usage and how it fired (schedule / webhook / manual). */
  byWorkflow: Array<{
    workflowId: string | null;
    workflowName: string;
    triggerType: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    callCount: number;
  }>;
  period: number;
}

// ─── Analytics Performance Types ─────────────────────────────────────────────

export interface AnalyticsPerformanceResponse {
  hero: {
    turnLatencyP50: number | null;
    turnLatencyP95: number | null;
    queueWaitP50: number | null;
    sandboxWakeP50: number | null;
    errorRate: number;
    turnCount: number;
    errorCount: number;
    tokensPerSecP50: number | null;
  };
  trend: Array<{
    date: string;
    p50: number | null;
    p95: number | null;
    count: number;
  }>;
  stages: Array<{
    eventType: string;
    count: number;
    p50: number | null;
    p95: number | null;
  }>;
  slowPaths: Array<{
    dimension: string;
    value: string;
    count: number;
    p50: number | null;
    p95: number | null;
  }>;
  period: number;
}

export interface AnalyticsEventsResponse {
  events: Array<{
    id: string;
    eventType: string;
    sessionId: string;
    sessionTitle: string | null;
    userId: string | null;
    userEmail: string | null;
    userName: string | null;
    turnId: string | null;
    durationMs: number | null;
    channel: string | null;
    model: string | null;
    toolName: string | null;
    errorCode: string | null;
    summary: string | null;
    properties: Record<string, unknown> | null;
    createdAt: string;
  }>;
  total: number;
  period: number;
}

/**
 * One window of outcome/value metrics for the admin "Value" tab. The route
 * returns the trailing window plus the equal-length window before it so the
 * client can render deltas. All rates are 0–1 fractions; null means the
 * denominator was empty for the window.
 */
export interface ValueMetricsWindow {
  // Cost per resolved task
  totalCost: number | null;
  resolvedWorkflowRuns: number;
  resolvedSessions: number;
  resolvedTasks: number;
  costPerResolvedTask: number | null;
  // Accepted output (proxy: explicit approval decisions)
  approvalsAccepted: number;
  approvalsDenied: number;
  approvalsExpired: number;
  acceptedOutputRate: number | null;
  // Session errors (recomputed live from current session status; the
  // agent-mailbox escalation signal was retired with the mailbox)
  erroredSessions: number;
  endedSessions: number;
  failedWorkflowRuns: number;
  terminalWorkflowRuns: number;
  sessionErrorRate: number | null;
  // Cycle time (proxy: absolute time-to-resolution, no pre-Valet baseline)
  medianSessionMinutes: number | null;
  medianWorkflowMinutes: number | null;
  // Review burden (proxy: agent-authored PR outcomes)
  prsOpened: number;
  prsMerged: number;
  prsClosedUnmerged: number;
  prsStillOpen: number;
  prMergeRate: number | null;
  medianHoursToMerge: number | null;
  // Model-routing efficiency. Unknown-tier tokens are excluded from the
  // share so unclassified model names cannot inflate it.
  unknownTokens: number;
  nonFrontierTokenShare: number | null;
  sessionsWithModelUsage: number;
  frontierFreeSessionShare: number | null;
  // What ended sessions were started from (session_git_state.source_type;
  // 'none' = no git context)
  sessionSources: Array<{
    sourceType: string;
    sessions: number;
  }>;
}

export interface AnalyticsValueResponse {
  current: ValueMetricsWindow;
  previous: ValueMetricsWindow;
  period: number;
}

// Plugin types
export interface OrgPlugin {
  id: string;
  orgId: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  actionType?: string;
  authRequired: boolean;
  source: string;
  capabilities: string[];
  status: string;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
}

export interface OrgPluginArtifact {
  id: string;
  pluginId: string;
  type: 'skill' | 'persona' | 'tool';
  filename: string;
  content: string;
  sortOrder: number;
}

export interface OrgPluginSettings {
  allowRepoContent: boolean;
}

export interface PluginContentPayload {
  personas: Array<{ filename: string; content: string; sortOrder: number }>;
  skills: Array<{ filename: string; content: string }>;
  tools: Array<{ filename: string; content: string }>;
  allowRepoContent: boolean;
}

// --- Skills ---

export type SkillSource = 'builtin' | 'plugin' | 'managed';
export type SkillVisibility = 'private' | 'shared';

export interface Skill {
  id: string;
  orgId: string;
  ownerId: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerAvatarUrl?: string | null;
  source: SkillSource;
  name: string;
  slug: string;
  description: string | null;
  content: string;
  visibility: SkillVisibility;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  source: SkillSource;
  visibility: SkillVisibility;
  ownerId: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerAvatarUrl?: string | null;
  updatedAt: string;
}

export interface PersonaSkillAttachment {
  id: string;
  personaId: string;
  skillId: string;
  sortOrder: number;
  createdAt: string;
}

export interface PersonaToolConfig {
  id: string;
  personaId: string;
  service: string;
  actionId: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface PersonaToolWhitelist {
  services: string[];
  excludedActions: Array<{ service: string; actionId: string }>;
}
