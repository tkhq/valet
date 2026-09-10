export const CHANGELOG_SCHEMA: "valet-changelog/v2";

export interface GeneratedChange {
  commitSha: string;
  authoredAt: string;
  subject: string;
  body: string;
  files: string[];
}

export interface GeneratedEntry {
  title: string;
  description: string;
  category: "feature" | "improvement" | "fix" | "security";
  sources: { commitSha: string; pullRequest?: number };
  links?: Array<{ label: string; url: string }>;
  followUp: boolean;
}

export interface GeneratedReleasedCheckpoint {
  kind: "released";
  id: string;
  version: string;
  releasedAt: string;
  releasedSha: string;
  previousSha: string | null;
  releaseUrl?: string;
  entries: GeneratedEntry[];
}

export interface GeneratedUnreleasedCheckpoint {
  kind: "unreleased";
  id: string;
  buildSha: string;
  builtAt: string;
  previousSha: string | null;
  buildUrl?: string;
  entries: GeneratedEntry[];
}

export type GeneratedCheckpoint = GeneratedReleasedCheckpoint | GeneratedUnreleasedCheckpoint;

export interface GeneratedManifest {
  schema: typeof CHANGELOG_SCHEMA;
  generatedAt: string;
  checkpoints: GeneratedCheckpoint[];
}

export function classifyCommit(subject: string): GeneratedEntry["category"];
export function shouldIncludeCommit(change: Pick<GeneratedChange, "subject" | "body" | "files">): boolean;
export function entryFromCommit(change: GeneratedChange): GeneratedEntry;
export function generateCheckpoint(options: {
  repo: string;
  version: string;
  releaseSha: string;
  previousSha?: string | null;
  releasedAt: string;
  releaseUrl?: string;
}): GeneratedReleasedCheckpoint;
export function generateUnreleasedCheckpoint(options: {
  repo: string;
  buildSha: string;
  previousSha?: string | null;
  builtAt: string;
  buildUrl?: string;
}): GeneratedUnreleasedCheckpoint;
export function upsertCheckpoint(
  manifest: GeneratedManifest,
  checkpoint: GeneratedReleasedCheckpoint,
): GeneratedManifest;
export function replaceUnreleasedCheckpoint(
  manifest: GeneratedManifest,
  checkpoint: GeneratedUnreleasedCheckpoint,
): GeneratedManifest;
export function backfillTags(options: {
  repo: string;
  manifest: GeneratedManifest;
  patterns: string[];
  targetRef?: string;
}): GeneratedManifest;
