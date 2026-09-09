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
    typeof row.version !== "string" ||
    typeof row.releasedAt !== "string" ||
    typeof row.releasedSha !== "string" ||
    (row.previousSha !== null && typeof row.previousSha !== "string") ||
    (row.releaseUrl !== undefined && typeof row.releaseUrl !== "string") ||
    !Array.isArray(row.entries) ||
    row.entries.length === 0
  ) {
    throw new Error("Invalid changelog checkpoint. Regenerate the release manifest.");
  }
  if (row.id !== `${row.version}@${row.releasedSha}`) {
    throw new Error("Invalid changelog checkpoint id. Regenerate the release manifest.");
  }
  return {
    id: row.id,
    version: row.version,
    releasedAt: row.releasedAt,
    releasedSha: row.releasedSha,
    previousSha: row.previousSha,
    ...(typeof row.releaseUrl === "string" ? { releaseUrl: row.releaseUrl } : {}),
    entries: row.entries.map(entry),
  };
}

export function parseChangelogManifest(value: unknown): ChangelogManifest {
  const row = object(value);
  if (
    !row ||
    row.schema !== "valet-changelog/v1" ||
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
  return { schema: "valet-changelog/v1", generatedAt: row.generatedAt, checkpoints };
}

export const changelogManifest = parseChangelogManifest(bundledManifest);

export function changelogResponse(
  manifest: ChangelogManifest,
  version = process.env.VALET_RELEASE_VERSION || bundledRelease.version,
  sha = process.env.VALET_RELEASE_SHA || bundledRelease.sha,
): GetChangelogResponse {
  const exact = sha ? manifest.checkpoints.find((item) => item.releasedSha === sha) : undefined;
  const latest = manifest.checkpoints[0];
  return {
    manifest,
    artifact: {
      version,
      sha,
      checkpointId: exact?.id ?? latest?.id ?? null,
      status: exact ? "exact" : latest ? "latest-known" : "empty",
    },
  };
}
