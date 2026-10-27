export { readAppPageHint, renderAppPageHint, type AppPageHint } from "./app-page-hint.js";
export * from "./types.js";
export { toolScopeSchema } from "./tool-scope-schema.js";
export { modelCallUsage, type ReportedUsage } from "./model-call-usage.js";
export { parseResourceQuantity } from "@valet/shared";
export { readThreadPlan, THREAD_PLAN_KEY, type ThreadPlan, type ThreadPlanItem, type ThreadPlanStatus } from "@valet/shared";
export { subjectService } from "./events/subjects.js";
export { boundEventDigest, cutUtf8, stripNul } from "./wakeups/digest.js";
// pi-ai passthroughs, re-exported so downstream packages (e.g. @valet/eval)
// can type model handles and run side completions without their own pi-ai
// dependency edge (which pnpm may peer-fork into a second instance with its
// own provider registry — see CLAUDE.md, "Node & workspace traps").
export type { Model } from "@earendil-works/pi-ai/compat";
export { completeSimple } from "@earendil-works/pi-ai/compat";
export {
  NotFoundError,
  NoCredentialsError,
  StaleAttemptError,
  ConflictError,
  TimeoutError,
  ValidationError,
  PluginStoreConflictError,
  PendingCapError,
  WorkspaceProvisioningError,
  SandboxSupersededError,
  SandboxUnavailableError,
  SandboxEvictedError,
  SandboxGoneError,
  SandboxStartupError,
  type SandboxStartupKind,
  SANDBOX_STARTUP_KINDS,
  SandboxPreparationError,
  SandboxConnectionError,
  formatSandboxErrorCause,
} from "./errors.js";
export {
  REASONING_LEVELS,
  isReasoningLevel,
  parseReasoningLevel,
  resolveReasoningLevel,
  type ReasoningLevel,
} from "./reasoning.js";
export {
  parseMarkdownArtifact,
  renderTemplate,
  loadRoleFromMarkdown,
  loadSkillFromMarkdown,
  skillFileManifest,
  validateSkillFrontmatter,
  isLoadable,
  type FrontmatterValue,
  type ParsedArtifact,
  type SkillSpecField,
  type SkillSpecOptions,
  type SkillSpecViolation,
  type SkillSpecSeverity,
} from "./roles-skills/index.js";
export {
  deriveQueueState,
  decideReconciliation,
  resolveSubmissionText,
  completedSubmissionOutcome,
  resolvePartialSubmissionText,
  originFromEntries,
  validateSignalTagName,
  validateSignalAttributeKeys,
  renderSignalEnvelope,
  namespaceInternalDispatchId,
  countPendingForCap,
  SIGNAL_HOP_BUDGET,
  MAX_PENDING_PER_THREAD,
  SUBMISSION_TIMEOUT_MS,
  type ReconcileAction,
  type ReconcileContext,
} from "./submission.js";
export {
  serializePrincipal,
  parsePrincipal,
  assistantSessionId,
  parseAssistantSessionId,
} from "./principal.js";
export { extractStructuredOutput } from "./result-schema.js";
export { encodeToolOutput } from "./tool-output.js";
export { buildRepoInstructionsFragment } from "./repo-instructions.js";
export {
  capturePatch,
  patchBlobKey,
  MAX_PATCH_BYTES,
  type PatchCaptureContext,
} from "./patch-capture.js";
export {
  TRACEPARENT_METADATA_KEY,
  activeTraceparent,
  attrTruncate,
  engineTracer,
  detachedFromTrace,
  linkFromTraceparent,
  markSpanError,
  withSpan,
} from "./tracing.js";
export {
  recordCredentialRead,
  recordLeaseNodeSeconds,
  recordLeasesActive,
  recordLeasesOverDeadline,
  recordLeasesUnannotated,
  recordSandboxCapacityWait,
  recordSandboxCreated,
  recordSandboxDestroyed,
  recordSandboxExec,
  recordSandboxFlagged,
  recordSandboxProvision,
  recordSandboxWorkspaceGrow,
  recordScratchRefused,
  recordScratchRequested,
  recordSettlement,
  recordToolExecution,
  recordTurn,
  recordWakeupEnded,
  recordWakeupSignalLost,
  recordChildTerminalSignalAbandoned,
  recordChildResultRecovered,
  recordWakeupKillFailed,
  recordWakeupsActive,
  recordChildSettleOverDeadline,
  recordLeaseOrphanReleased,
  recordWakeupBadRow,
  recordEventWaiterBufferFull,
  recordEventWaiterMatch,
  recordEventDerive,
  recordEventMatchFailed,
  recordWakeupSweepFailed,
  recordWakeupSweepOk,
  recordJobLogsPruned,
  recordDockerJobOutputDropped,
  initSandboxMetrics,
  type SandboxDestroyReason,
  type SandboxFlagKind,
  type WorkspaceGrowOutcome,
  type EventDeriveResult,
} from "./metrics.js";
export { Engine } from "./engine.js";
export { Session, type ThreadInitialSettings } from "./session.js";
export { Thread, THREAD_BRANCHED_KEY, FORK_SEED_APPLIED_KEY, type ThreadEntryQuery } from "./thread.js";
export {
  BRANCH_NOTE_KEY,
  THREAD_EDIT_KEY,
  branchNoteText,
  pushedFrom,
  readBranchNote,
  readThreadEdit,
  summarizeBranchActions,
  type BranchNote,
  type BranchNoteAction,
  type BranchNoteKind,
  type BranchNoteRepoFiles,
  type EditPreview,
  type ForkSeedRecord,
  type ThreadEdit,
} from "./branch-note.js";
export {
  FILE_CHECKPOINT_KEY,
  WORKSPACE_FILES,
  applySeedBundle,
  changedPaths,
  checkpointRef,
  exportSeedBundle,
  findRepos,
  planFileUndo,
  planForkSeed,
  planPathCount,
  readTurnCheckpoint,
  repoDir,
  restorePaths,
  returnPlan,
  snapshotRepo,
  type ForkSeedRepo,
  type PathRestore,
  type RepoCheckpoint,
  type RepoRestore,
  type RepoRestoreResult,
  type TurnCheckpoint,
} from "./checkpoints.js";
export {
  InMemoryBlobStore,
  InMemoryEventStream,
  InMemoryCredentialStore,
  InMemorySessionStore,
} from "./providers/in-memory/index.js";
export { VirtualSandbox, VirtualSandboxProvider } from "./providers/sandbox/virtual.js";
export {
  SandboxAttachment,
  OBSERVE_TTL_MS,
  type AttachmentState,
  type AttachmentStatus,
} from "./sandbox/attachment.js";
export {
  PolicySandbox,
  SANDBOX_READY_TIMEOUT_MS,
  CONTAINER_DEATH_PATTERN,
  isSandboxTransportError,
  type PolicySandboxOptions,
} from "./sandbox/policy.js";
export { CappedOutputBuffer, omittedMarker } from "./sandbox/output-buffer.js";
// PgSessionStore lives in @valet/store-postgres.
// LocalSandbox / LocalSandboxProvider live in @valet/sandbox-local.
// DockerSandbox / DockerSandboxProvider live in @valet/sandbox-docker.
export {
  builtinTools,
  DEFAULT_WAKEUP_LIMITS,
  readTool,
  writeTool,
  editTool,
  bashTool,
  threadReadTool,
  threadReference,
  updatePlanTool,
  JOB_MODE_THRESHOLD_MS,
  runForegroundExec,
  JOB_POLL_INTERVAL_MS,
  BASH_DEFAULT_TIMEOUT_S,
} from "./builtin-tools/index.js";
export {
  pluginCatalogTools,
  buildPluginCatalog,
  actionRunsUngated,
  resolveUngatedAction,
  recordHostedActionInvocation,
  type HostedActionGrant,
  invokeAction,
  prepareActionArgs,
  approvalModeForAction,
  toolApprovalGateContext,
  type ToolApprovalGateContext,
  pinnedToolName,
  MAX_PINNED_ACTIONS,
  RESOLVE_TTL_MS,
  type ActionPlugin,
  type ApprovalMode,
  type PluginAction,
  type PluginActionContext,
  type PluginActionResult,
  type PluginCatalog,
  type PluginCatalogAvailabilityOptions,
  type PluginCatalogOptions,
  type ServiceAvailability,
  type ServiceAvailabilityState,
  type PinnedActionSpec,
  type PinRejectedHandler,
  type InvokeActionResult,
} from "./plugin-catalog.js";
export {
  validateValetPlugin,
  canStream,
  ChannelStreamError,
  ChannelLookupError,
  OAuthInterpretError,
  type ChannelStreamErrorKind,
  type ChannelLookupErrorKind,
  type StreamRef,
  type SuggestedPrompt,
  type ValetPlugin,
  type PluginGate,
  type CredentialDeclaration,
  type OAuthDeclaration,
  type OAuthIdentity,
  type TokenInterpretation,
  type IdentityLinkDeclaration,
  type TriggerDef,
  type TriggerRejection,
  type VerifiedEvent,
  type NormalizedEvent,
  type EventCatalogEntry,
  DerivePermissionError,
  type DeriveContext,
  type DerivedEventDef,
  type EventSubjects,
  type StatusResolver,
  type FilterOption,
  type FilterOptionContext,
  type FilterOptionResolver,
  type PluginValidationIssue,
  ChannelDeliveryRejectedError,
  type ChannelTransport,
  type ChannelTransportFactory,
  type TransportContext,
  type RawChannelUpdate,
  type InboundChannelEvent,
  type InboundChannelMedia,
  type ChannelSender,
  type ChannelSenderIdentity,
  type FetchedChannelMedia,
  type OutboundChannelMessage,
  type OutboundChannelAttachment,
  type SendRef,
  type GatePromptRef,
  type ChannelGatePrompt,
  type ChannelGateResolution,
} from "./valet-plugin.js";
export {
  type WorkflowTemplate,
  type WorkflowTemplateSchedule,
  type WorkflowTemplateEventTrigger,
  type WorkflowTemplateEventFilter,
} from "./workflow-template.js";
export {
  GateManager,
  DecisionGateWithdrawnError,
  DecisionGateExpiredError,
  isDecisionGateWithdrawn,
  isDecisionGateExpired,
  isUnattendedWorkflowRefusal,
  UNATTENDED_WORKFLOW_DECISION,
  GATE_EXPIRY_DEFAULT_MS,
  deterministicGateId,
  findStickyTerminalGate,
} from "./decision-gate.js";
export {
  BUILTIN_COMMAND_NAMES,
  type CommandSource,
  type CommandInfo,
  type RegistryDiagnostic,
  type CommandDef,
  type CommandContext,
  type ResolvedCommand,
} from "./commands/types.js";
export {
  buildCommandRegistry,
  type BuildRegistryInput,
  type CommandRegistry,
} from "./commands/registry.js";
export {
  dispatchCommand,
  type DispatchOutcome,
} from "./commands/dispatch.js";
export {
  executeBuiltin,
  type BuiltinResult,
} from "./commands/builtins.js";
export {
  estimateTokens,
  estimateEntryTokens,
  estimateTotalTokens,
  estimateSummaryEntryTokens,
  estimateContextTokens,
  estimateLiveContextTokens,
  storedToolResultText,
  stripAnalysisScratchpad,
  SummarizeOverflowError,
  usableTokens,
  tailBudget,
  inputSpillThreshold,
  walkTranscriptDag,
  selectSummaryCheckpointTail,
  turns,
  selectCutPoint,
  planPrune,
  applyPrune,
  extractFileContext,
  summarize,
  entriesToSummaryMessages,
  type CutPoint,
  type PruneOptions,
  type PruneResult,
  type SelectCutPointOptions,
  type SummarizeOptions,
  type SummarizeResult,
  type SummaryWindowOptions,
  type Turn,
} from "./compaction.js";
export {
  canDeliverMidTurn,
  entriesToAgentMessages,
  skillInvocationsInContext,
  buildSpilledInputMarker,
  formatTransientRetryMessage,
  parseProviderRetryHintMs,
  resolveModelId,
  type CompactionOutcome,
} from "./thread.js";
export { classifyCacheBreak, type CacheBreakCause, type CacheTurnSnapshot } from "./cache-telemetry.js";
export { formatFileAttachmentsNote } from "./file-attachment-formatter.js";
export {
  DOCX_DOCUMENT_MIME,
  isDocxDocumentMime,
  isDocxDocument,
  extractDownloadedDocx,
  type DocumentExtractor,
  MAX_PDF_DOCUMENT_BYTES,
  normalizeDocumentMime,
  isTextDocumentMime,
  isPdfDocument,
  readResponseBytes,
  discardResponseBody,
  readPdfCandidateResponse,
  readResponseText,
  extractDownloadedPdf,
} from "./document-text.js";
export { formatTranscriptText } from "./transcript-formatter.js";
export { nestedKubernetesDecision, NESTED_KUBERNETES_IDENTITY, NESTED_KUBERNETES_UNSUPPORTED } from "./sandbox/nested-kubernetes.js";

export { validatePluginHttpRoutes, MAX_PLUGIN_HTTP_BODY_BYTES, type PluginHttpRoute, type PluginHttpRequest, type PluginHttpCaller, type PluginIngressVerification } from "./plugin-http.js";

export { MAX_IMAGE_BYTES, IMAGE_FORMATS, imageDecoder, validateImage, imageAttachment, decodeImageBase64 } from "./image-output.js";

export { MODEL_RESPONSE_METADATA_KEY, modelResponseMetadata, readModelResponseMetadata } from "./model-response.js";
export { sniffImageMediaType, correctImageBlocks, type ImageMediaType } from "./image-media-type.js";
