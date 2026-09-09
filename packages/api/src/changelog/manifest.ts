import bundledManifest from "./manifest.json";
import bundledRelease from "./release.json";
import type {
  ChangelogCategory,
  ChangelogCheckpoint,
  ChangelogEntry,
  ChangelogManifest,
  GetChangelogResponse,
} from "../wire/types.js";

const CATEGORIES: ReadonlySet<string> = new Set(["feature", "improvement", "fix", "security"]);
const EMPTY_MANIFEST: ChangelogManifest = {
  schema: "valet-changelog/v2",
  generatedAt: new Date(0).toISOString(),
  checkpoints: [],
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entry(value: unknown): ChangelogEntry {
  const row = object(value);
  const sources = object(row?.sources);
  if (
    !row ||
    typeof row.title !== "string" ||
    typeof row.description !== "string" ||
    typeof row.category !== "string" ||
    !CATEGORIES.has(row.category) ||
    typeof row.followUp !== "boolean" ||
    !sources ||
    typeof sources.commitSha !== "string" ||
    (sources.pullRequest !== undefined && typeof sources.pullRequest !== "number")
  ) {
    throw new Error("Invalid changelog entry. Regenerate the release manifest.");
  }
  const links = row.links;
  if (
    links !== undefined &&
    (!Array.isArray(links) ||
      links.some((item) => {
        const link = object(item);
        return !link || typeof link.label !== "string" || typeof link.url !== "string";
      }))
  ) {
    throw new Error("Invalid changelog link. Regenerate the release manifest.");
  }
  return {
    title: row.title,
    description: row.description,
    category: row.category as ChangelogCategory,
    sources: {
      commitSha: sources.commitSha,
      ...(typeof sources.pullRequest === "number" ? { pullRequest: sources.pullRequest } : {}),
    },
    ...(Array.isArray(links)
      ? {
          links: links.map((item) => {
            const link = object(item);
            if (!link || typeof link.label !== "string" || typeof link.url !== "string") {
              throw new Error("Invalid changelog link. Regenerate the release manifest.");
            }
            return { label: link.label, url: link.url };
          }),
        }
      : {}),
    followUp: row.followUp,
  };
}

function checkpoint(value: unknown): ChangelogCheckpoint {
  const row = object(value);
  if (
    !row ||
    typeof row.id !== "string" ||
    (row.previousSha !== null && typeof row.previousSha !== "string") ||
    !Array.isArray(row.entries)
  ) {
    throw new Error("Invalid changelog checkpoint. Regenerate the release manifest.");
  }
  const entries = row.entries.map(entry);
  if (row.kind === "released") {
    if (
      typeof row.version !== "string" ||
      typeof row.releasedAt !== "string" ||
      typeof row.releasedSha !== "string" ||
      (row.releaseUrl !== undefined && typeof row.releaseUrl !== "string") ||
      row.id !== `${row.version}@${row.releasedSha}`
    ) {
      throw new Error("Invalid released changelog checkpoint. Regenerate the release manifest.");
    }
    return {
      kind: "released",
      id: row.id,
      version: row.version,
      releasedAt: row.releasedAt,
      releasedSha: row.releasedSha,
      previousSha: row.previousSha,
      ...(typeof row.releaseUrl === "string" ? { releaseUrl: row.releaseUrl } : {}),
      entries,
    };
  }
  if (
    row.kind !== "unreleased" ||
    typeof row.buildSha !== "string" ||
    typeof row.builtAt !== "string" ||
    (row.buildUrl !== undefined && typeof row.buildUrl !== "string") ||
    row.id !== `unreleased@${row.buildSha}`
  ) {
    throw new Error("Invalid unreleased changelog checkpoint. Regenerate the release manifest.");
  }
  return {
    kind: "unreleased",
    id: row.id,
    buildSha: row.buildSha,
    builtAt: row.builtAt,
    previousSha: row.previousSha,
    ...(typeof row.buildUrl === "string" ? { buildUrl: row.buildUrl } : {}),
    entries,
  };
}

export function parseChangelogManifest(value: unknown): ChangelogManifest {
  const row = object(value);
  if (
    !row ||
    row.schema !== "valet-changelog/v2" ||
    typeof row.generatedAt !== "string" ||
    !Array.isArray(row.checkpoints)
  ) {
    throw new Error("Invalid changelog manifest. Regenerate the release manifest.");
  }
  const checkpoints = row.checkpoints.map(checkpoint);
  const ids = new Set(checkpoints.map((item) => item.id));
  if (ids.size !== checkpoints.length) {
    throw new Error("Duplicate changelog checkpoint. Regenerate the release manifest.");
  }
  const unreleased = checkpoints.filter((item) => item.kind === "unreleased");
  if (unreleased.length > 1 || (unreleased.length === 1 && checkpoints[0].kind !== "unreleased")) {
    throw new Error("The unreleased changelog checkpoint must be unique and first.");
  }
  return { schema: "valet-changelog/v2", generatedAt: row.generatedAt, checkpoints };
}

function checkpointSha(checkpoint: ChangelogCheckpoint): string {
  return checkpoint.kind === "released" ? checkpoint.releasedSha : checkpoint.buildSha;
}

export function changelogResponse(
  manifest: ChangelogManifest,
  version = process.env.VALET_RELEASE_VERSION || bundledRelease.version,
  sha: string | null = process.env.VALET_RELEASE_SHA || bundledRelease.sha,
): GetChangelogResponse {
  const exact = sha ? manifest.checkpoints.find((item) => checkpointSha(item) === sha) : undefined;
  const latest = manifest.checkpoints[0];
  return {
    manifest,
    artifact: {
      version,
      sha,
      checkpointId: exact?.id ?? latest?.id ?? null,
      status: exact?.kind === "unreleased" ? "unreleased" : exact ? "exact" : latest ? "latest-known" : "empty",
    },
  };
}

export function safeChangelogResponse(
  value: unknown,
  version?: string,
  sha?: string | null,
  report: (message: string, error: unknown) => void = console.error,
): GetChangelogResponse {
  try {
    return changelogResponse(parseChangelogManifest(value), version, sha);
  } catch (error) {
    report("Bundled changelog is invalid. Regenerate the release manifest.", error);
    return changelogResponse(EMPTY_MANIFEST, version, sha);
  }
}

let bundledResponse: GetChangelogResponse | undefined;

export function bundledChangelogResponse(): GetChangelogResponse {
  bundledResponse ??= safeChangelogResponse(bundledManifest);
  return bundledResponse;
}
