import type {
  ChangelogCategory,
  ChangelogCheckpoint,
  ChangelogEntry,
} from "@valet/api/wire";

export const CHANGELOG_CATEGORIES = ["feature", "improvement", "fix", "security"] as const;
export const CHANGELOG_PAGE_SIZE = 5;

export type ChangelogCategoryFilter = ChangelogCategory | "all";
export type ChangelogSort = "newest" | "oldest";

export interface ChangelogEntryGroup {
  category: ChangelogCategory;
  entries: ChangelogEntry[];
}

function checkpointTime(checkpoint: ChangelogCheckpoint): number {
  return Date.parse(checkpoint.kind === "unreleased" ? checkpoint.builtAt : checkpoint.releasedAt);
}

function entryMatches(entry: ChangelogEntry, query: string): boolean {
  const pullRequest = entry.sources.pullRequest ? `pr #${entry.sources.pullRequest}` : "";
  return [entry.title, entry.description, entry.category, entry.sources.commitSha, pullRequest]
    .join(" ")
    .toLocaleLowerCase()
    .includes(query);
}

export function groupChangelogEntries(entries: ChangelogEntry[]): ChangelogEntryGroup[] {
  return CHANGELOG_CATEGORIES.flatMap((category) => {
    const categoryEntries = entries.filter((entry) => entry.category === category);
    return categoryEntries.length > 0 ? [{ category, entries: categoryEntries }] : [];
  });
}

export function filterAndSortCheckpoints(
  checkpoints: ChangelogCheckpoint[],
  category: ChangelogCategoryFilter,
  rawQuery: string,
  sort: ChangelogSort,
): ChangelogCheckpoint[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  const filtering = category !== "all" || query.length > 0;
  const filtered = checkpoints.flatMap((checkpoint) => {
    const entries = checkpoint.entries.filter((entry) =>
      (category === "all" || entry.category === category) && (query.length === 0 || entryMatches(entry, query)),
    );
    if (filtering && entries.length === 0) return [];
    return [{ ...checkpoint, entries }];
  });

  return filtered
    .map((checkpoint, index) => ({ checkpoint, index }))
    .sort((left, right) => {
      const difference = checkpointTime(right.checkpoint) - checkpointTime(left.checkpoint);
      return (sort === "newest" ? difference : -difference) || left.index - right.index;
    })
    .map(({ checkpoint }) => checkpoint);
}

export function pageCount(itemCount: number, pageSize = CHANGELOG_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(itemCount / pageSize));
}

export function clampPage(page: number, totalPages: number): number {
  return Math.min(Math.max(1, page), totalPages);
}

export function paginateCheckpoints(
  checkpoints: ChangelogCheckpoint[],
  page: number,
  pageSize = CHANGELOG_PAGE_SIZE,
): ChangelogCheckpoint[] {
  const start = (clampPage(page, pageCount(checkpoints.length, pageSize)) - 1) * pageSize;
  return checkpoints.slice(start, start + pageSize);
}
