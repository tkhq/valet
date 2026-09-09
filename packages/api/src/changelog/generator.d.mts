export const CHANGELOG_SCHEMA: "valet-changelog/v1";

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

export interface GeneratedCheckpoint {
  id: string;
  version: string;
  releasedAt: string;
  releasedSha: string;
  previousSha: string | null;
  releaseUrl?: string;
  entries: GeneratedEntry[];
}

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
}): GeneratedCheckpoint;
export function upsertCheckpoint(
  manifest: GeneratedManifest,
  checkpoint: GeneratedCheckpoint,
): GeneratedManifest;
export function backfillTags(options: {
  repo: string;
  manifest: GeneratedManifest;
  patterns: string[];
}): GeneratedManifest;
