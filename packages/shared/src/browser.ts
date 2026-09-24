/** Transport-neutral browser protocol. Model code never selects the authenticated identity. */
export const BROWSER_PROTOCOL_VERSION = '1.0' as const;
export const BROWSER_LIMITS = Object.freeze({
  tabs: 8,
  operationsPerCell: 64,
  replProcesses: 4,
  cellMs: 30_000,
  maxCellMs: 120_000,
  codeChars: 100_000,
  snapshotChars: 24_000,
  events: 128,
  eventBytes: 256_000,
  fileBytes: 100 * 1024 * 1024,
  sessionBytes: 500 * 1024 * 1024,
  logEntries: 200,
});
export type BrowserErrorCode =
  | 'BROWSER_UNAVAILABLE'
  | 'PROTOCOL_MISMATCH'
  | 'UNSUPPORTED_CAPABILITY'
  | 'RUNTIME_CHANGED'
  | 'CELL_LOST'
  | 'STALE_REFERENCE'
  | 'AMBIGUOUS_LOCATOR'
  | 'CONTROL_HELD'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE'
  | 'ORIGIN_DENIED'
  | 'ACTION_TIMEOUT'
  | 'QUOTA_EXCEEDED'
  | 'OUTCOME_UNKNOWN'
  | 'INVALID_REQUEST'
  | 'IDENTITY_MISMATCH'
  | 'INVOCATION_CONFLICT'
  | 'CANCELLED';
export interface BrowserError {
  code: BrowserErrorCode;
  message: string;
  correctiveAction: string;
  effect: 'none' | 'possible';
}
export interface BrowserIdentity {
  protocolVersion: '1.0';
  sessionId: string;
  threadId: string;
  actorId: string;
  ownerId: string;
  audience?: 'agent' | 'viewer' | 'lifecycle';
}
export type BrowserOperationClass =
  | 'observation'
  | 'navigation'
  | 'mutation'
  | 'upload'
  | 'page_tool'
  | 'export'
  | 'history'
  | 'diagnostic';
export type BrowserCellStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lost';
export type BrowserOperationStatus =
  | 'prepared'
  | 'awaiting_approval'
  | 'in_flight'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcome_unknown';
export interface BrowserCapability {
  available: boolean;
  reason?: string;
}
export interface BrowserTabInfo {
  id: string;
  runtimeId: string;
  documentId: string;
  url: string;
  title: string;
  ownerThreadId: string | null;
  actorId: string;
  mark: 'temporary' | 'handoff' | 'deliverable' | 'user';
}
export interface BrowserElementRef {
  id: string;
  runtimeId: string;
  tabId: string;
  documentId: string;
  snapshotId: string;
  frameId: string;
}
export interface BrowserViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
  scrollX: number;
  scrollY: number;
}
export interface BrowserObservation {
  snapshotId: string;
  runtimeId: string;
  tabId: string;
  documentId: string;
  capturedAt: number;
  url: string;
  title: string;
  source: 'playwright-aria' | 'rendered-dom';
  text: string;
  refs: BrowserElementRef[];
  viewport: BrowserViewport;
  truncated: boolean;
  limitations: string[];
  baseSnapshotId?: string;
}
export interface BrowserArtifact {
  id: string;
  sessionId: string;
  runtimeId: string;
  tabId?: string;
  documentId?: string;
  snapshotId?: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  filename: string;
  createdAt: number;
  url?: string;
  width?: number;
  height?: number;
  viewport?: BrowserViewport;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}
export interface BrowserExportDescriptor extends BrowserArtifact {
  path: string;
  transferId: string;
}
export interface BrowserInlineFrame {
  mimeType: 'image/jpeg';
  data: string;
  bytes: number;
  sha256: string;
  tabId: string;
  documentId: string;
  viewport: { width: number; height: number };
}
export interface BrowserPolicyRequest {
  operationId: string;
  cellId: string;
  invocationId: string;
  runtimeId: string;
  hash: string;
  actorId: string;
  ownerId: string;
  threadId: string;
  sessionId: string;
  method: string;
  operationClass: BrowserOperationClass;
  origin: string;
  tabId?: string;
  documentId?: string;
  target: string;
  policyVersion: string;
  expiresAt: number;
}
export interface BrowserOperationReceipt {
  operationId: string;
  cellId: string;
  method: string;
  hash: string;
  status: BrowserOperationStatus;
  result?: unknown;
  resultTruncated?: boolean;
  error?: BrowserError;
}
export interface BrowserCellReceipt {
  cellId: string;
  invocationId: string;
  runtimeId: string;
  threadId: string;
  status: BrowserCellStatus;
  operations: BrowserOperationReceipt[];
  error?: BrowserError;
}
export type BrowserEventPayload =
  | { type: 'text'; text: string }
  | { type: 'artifact'; artifact: BrowserArtifact }
  | { type: 'approval'; request: BrowserPolicyRequest }
  | { type: 'operation'; receipt: BrowserOperationReceipt }
  | { type: 'cell'; cell: BrowserCellReceipt }
  | { type: 'tabs'; tabs: BrowserTabInfo[] }
  | { type: 'control'; lease: BrowserControlLease | null }
  | {
      type: 'dialog';
      tabId: string;
      dialogId: string;
      kind: string;
      message: string;
    };
export type BrowserEvent = BrowserEventPayload & {
  cursor: number;
  timestamp: number;
  cellId?: string;
};
export interface BrowserControlLease {
  id: string;
  runtimeId: string;
  actorId: string;
  state: 'active' | 'paused';
  privateMode: boolean;
  expiresAt: number;
}
export interface BrowserRuntimeStatus {
  state:
    | 'installed'
    | 'starting'
    | 'ready'
    | 'sleeping'
    | 'crashed'
    | 'incompatible'
    | 'disabled';
  runtimeId: string;
  protocolVersion: '1.0';
  capabilities: Record<string, BrowserCapability>;
  tabs: BrowserTabInfo[];
  control: BrowserControlLease | null;
  selectedTabId?: string;
  restorableTabs?: BrowserTabInfo[];
  dialogs?: {
    tabId: string;
    dialogId: string;
    kind: string;
    message: string;
  }[];
  downloads?: BrowserArtifact[];
  correctiveAction?: string;
}
export type BrowserRequest = BrowserIdentity &
  (
    | {
        command: 'submit';
        invocationId: string;
        code: string;
        title: string;
        timeoutMs?: number;
        policyVersion?: string;
      }
    | {
        command: 'events';
        invocationId: string;
        after?: number;
        waitMs?: number;
      }
    | { command: 'status'; invocationId?: string }
    | { command: 'describe'; topic?: string }
    | {
        command: 'resolve';
        invocationId: string;
        operationId: string;
        hash: string;
        runtimeId: string;
        decision: 'allow' | 'deny';
        policyVersion: string;
        expiresAt: number;
      }
    | { command: 'cancel'; invocationId: string }
    | { command: 'reset'; reason?: string }
    | { command: 'export'; artifactId: string }
    | { command: 'ack'; transferId: string }
    | {
        command: 'control';
        action: 'take' | 'release' | 'pause' | 'resume';
        leaseId?: string;
        privateMode?: boolean;
      }
    | {
        command: 'input';
        leaseId?: string;
        runtimeId: string;
        tabId: string;
        documentId: string;
        input: BrowserHumanInput;
      }
    | { command: 'evidence'; tabId: string; runtimeId: string }
    | { command: 'frame'; tabId: string; runtimeId: string; inline?: boolean }
    | {
        command: 'tab';
        action: 'new' | 'close' | 'select';
        leaseId?: string;
        runtimeId: string;
        tabId?: string;
        url?: string;
      }
    | { command: 'revoke' }
    | { command: 'audit' }
    | { command: 'turn_end' }
    | { command: 'suspend' }
  );
export type BrowserHumanInput =
  | {
      type: 'click';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
    }
  | { type: 'move'; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; phase?: 'down' | 'up' | 'press' }
  | {
      type: 'pointer';
      phase: 'down' | 'up' | 'move';
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right';
    }
  | { type: 'back' | 'forward' | 'reload' }
  | { type: 'navigate'; url: string }
  | { type: 'dialog'; dialogId: string; accept: boolean; text?: string };
export interface BrowserResponse {
  protocolVersion: '1.0';
  runtimeId: string;
  ok: boolean;
  events: BrowserEvent[];
  cursor: number;
  gap: boolean;
  cell?: BrowserCellReceipt;
  status?: BrowserRuntimeStatus;
  artifact?: BrowserExportDescriptor;
  frame?: BrowserInlineFrame;
  description?: string;
  audit?: BrowserAuditEntry[];
  auditTotal?: number;
  auditTruncated?: boolean;
  error?: BrowserError;
}
/** Serializable locator queries. Frames and explicit disambiguation remain part of the query. */
export interface BrowserLocator {
  tabId: string;
  runtimeId: string;
  steps: BrowserLocatorStep[];
}
export type BrowserLocatorStep =
  | {
      kind:
        | 'role'
        | 'label'
        | 'placeholder'
        | 'text'
        | 'testId'
        | 'css'
        | 'frame';
      value: string;
      name?: string;
      exact?: boolean;
    }
  | { kind: 'first' | 'last' }
  | { kind: 'nth'; index: number }
  | { kind: 'filter'; hasText?: string; hasNotText?: string; visible?: boolean }
  | { kind: 'and' | 'or'; locator: BrowserLocator };
export interface BrowserRpc {
  id: string;
  cellId: string;
  method: string;
  params: Record<string, unknown>;
}

export interface BrowserAuditEntry {
  invocationId: string;
  cellId: string;
  operationId: string;
  sessionId: string;
  threadId: string;
  actorId: string;
  runtimeId: string;
  method: string;
  hash: string;
  status: BrowserOperationStatus;
}
