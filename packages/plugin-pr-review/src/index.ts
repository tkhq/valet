export {
  anchorProblems,
  evidenceProblems,
  createLocalAgentRunner,
  createReviewerSpec,
  lineCount,
  reviewPullRequest,
  type LlmGatewayConfig,
  type LocalAgentRunnerOptions,
  type ReviewerSpec,
  type ReviewerSpecOptions,
  type ReviewPullRequestOptions,
} from "./review.js";
export {
  confidentEnough,
  gatherPipelineContext,
  mergeBase,
  mergeFindings,
  runReviewPipeline,
  type AgentRunner,
  type AgentRunResult,
  type AgentSpec,
  type FindingVerdict,
  type PipelineOptions,
  type PipelineResult,
} from "./pipeline.js";
export {
  buildVerifierPrompt,
  claimDiff,
  createVerifierSpec,
  decideFinding,
  quoteInFile,
  VERIFIER_SYSTEM_PROMPT,
  VerdictSchema,
  type FinalVerdict,
  type Verdict,
  type FindingTier,
  type VerifierPromptInput,
  type VerifierSpec,
} from "./verify.js";
export {
  reviewPullRequestIncrement,
  sameIssue,
  type IncrementalReviewOptions,
  type IncrementalReviewResult,
} from "./incremental.js";
export {
  fileReviewState,
  memoryReviewState,
  openFindings,
  type PullRequestReviewState,
  type ReviewRound,
  type ReviewStateStore,
  type TrackedFinding,
} from "./state.js";
export { commentableLines, mapLine, nearestCommentableLine, mapLineThroughHunks, parseHunks, type LineFate } from "./linemap.js";
export { cutPatch, diffPullRequest, type PullRequestDiff } from "./git.js";
export { consolidateFindings, sameCitation, type Consolidation } from "./consolidate.js";
export {
  applyDuplicateGroups,
  buildDedupePrompt,
  clusterExcerpt,
  createDedupeSpec,
  DEDUPE_SYSTEM_PROMPT,
  DEDUPE_WINDOW,
  duplicateCandidates,
  DuplicateGroupsSchema,
  type DedupePromptInput,
  type DedupeSpec,
  type DuplicateGroups,
} from "./dedupe.js";
export { gatherContext, type GatherInput, type PackMemory } from "./context/gather.js";
export { buildContextPack, definitionBody, definitionScore, type ContextPack, type PackManifest } from "./context/pack.js";
export { rankPatch, type DroppedFile, type RankedPatch } from "./context/rank.js";
export { fetchLines, fillContext, scanRepo, type Hit, type LineStore, type ScanResult } from "./context/scan.js";
export { gitFileAt, localRunner, type RepoRunner } from "./context/repo.js";
export { diffSymbols, parseDiff, type DiffSymbols } from "./context/symbols.js";
export { noteMatch, parseNote, type DomainNote } from "./context/notes.js";
export { directoryMemory } from "./context/memory-dir.js";
export { FOCUS_PROMPTS, REVIEW_FOCUSES, REVIEWER_SYSTEM_PROMPT, buildReviewPrompt, type ReviewFocus } from "./prompt.js";
export * from "./types.js";
export {
  acceptsEvent,
  createReviewHandler,
  excluded,
  changedPullFiles,
  flaggedCodeChanged,
  focusRole,
  MANUAL_REVIEW_EVENT,
  manualReviewOptions,
  POINTERS_COLLECTION,
  pullTarget,
  renderAlreadyReviewed,
  ReviewSettingsSchema,
  type FindingPointer,
  type ManualReviewOptions,
  type PullPointers,
  type ReviewSettings,
} from "./handler.js";
export { githubClient, GitHubError, type GitHubClient } from "./github.js";
export { isMentionEvent, MENTION_EVENTS, mentionCommand, reviewRequest, type CommentSurface, type ReviewRequest } from "./mention.js";
export { parseFindings, renderFinding, renderSummary, type PostedFinding } from "./render.js";
export { classifyOutcome, FINDINGS_COLLECTION, recordKey, type FindingOutcome, type FindingPlacement, type FindingRecord } from "./records.js";
export {
  acceptsDependencyEvent,
  changedDependencyFiles,
  createDependencyReviewHandler,
  DEPENDENCY_COLLECTION,
  DEPENDENCY_HANDLER,
  DependencySettingsSchema,
  withReachability,
  type DependencyPointer,
  type DependencyPullState,
  type DependencySettings,
} from "./deps/handler.js";
export { compareVersions, dependencyChanges, MAX_CHANGES, type ChangedFile, type PackageChange, type PackageLocation } from "./deps/diff.js";
export { dependencyFindings, lowerSeverity, type ChangeFacts, type DependencyFinding, type DependencyFindingKind } from "./deps/findings.js";
export { lookupAdvisories, toAdvisory, type Advisory, type OsvQuery, type OsvVuln } from "./deps/osv.js";
export {
  dependencyFile,
  normalizePypi,
  parseCargoToml,
  parseDependencyFile,
  parseGoMod,
  parseGoSum,
  parsePackageJson,
  parsePackageLock,
  parsePnpmLock,
  parsePyproject,
  parseRequirements,
  parseTomlPackages,
  parseYarnLock,
  type DependencyFile,
  type Ecosystem,
  type PackageEntry,
} from "./deps/parse.js";
export { buildReachabilityPrompt, REACHABILITY_ROLE, ReachabilitySchema, type ReachabilityVerdict } from "./deps/reachability.js";
export { packageFacts, REGISTRY_URLS, type PackageFacts, type RegistryUrls } from "./deps/registry.js";
export { editDistanceAtMostOne, licenseClass, sameLicense, typosquatOf } from "./deps/signals.js";
export { renderDependencySummary, renderResolvedComment, SUMMARY_MARKER as DEPENDENCY_SUMMARY_MARKER } from "./deps/render.js";
