import type { EventSubscriptionWire, GetReposResponse } from "@valet/api/wire";
import type { OwnerFilter } from "~/api/client";
import { coversRepository, isReviewLine, lineRepos } from "./review-lines";

export interface ReviewRepository {
  name: string;
  installed: boolean;
  line: EventSubscriptionWire | undefined;
}

export function belongsToWorkspace(line: EventSubscriptionWire, owner: OwnerFilter | undefined): boolean {
  return owner !== undefined && line.ownerType === owner.ownerType && line.ownerId === owner.ownerId;
}

/** App access makes a repository visible. Review settings determine whether it is on. */
export function repositoryInventory(repos: GetReposResponse["repos"], subscriptions: EventSubscriptionWire[], owner: OwnerFilter | undefined) {
  const lines = subscriptions.filter(isReviewLine);
  const names = new Map<string, { name: string; installed: boolean }>();
  for (const repo of repos) {
    if (repo.installed) names.set(repo.fullName.toLowerCase(), { name: repo.fullName, installed: true });
  }
  for (const line of lines) {
    for (const name of lineRepos(line) ?? []) {
      if (coversRepository(line, name) && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), { name, installed: false });
    }
  }
  const repositories: ReviewRepository[] = [...names.values()].map((repo) => {
    const covering = lines.filter((line) => coversRepository(line, repo.name));
    const line = covering.find((candidate) => belongsToWorkspace(candidate, owner))
      ?? covering.find((candidate) => candidate.enabled)
      ?? covering[0];
    return { ...repo, line };
  });
  repositories.sort((left, right) => Number(right.line !== undefined) - Number(left.line !== undefined)
    || Number(right.line?.enabled ?? false) - Number(left.line?.enabled ?? false)
    || Number(right.line !== undefined && belongsToWorkspace(right.line, owner)) - Number(left.line !== undefined && belongsToWorkspace(left.line, owner))
    || left.name.localeCompare(right.name));
  // A broad rule can exist before GitHub lists any repository it covers.
  const rules = lines.filter((line) => !repositories.some((repo) => coversRepository(line, repo.name)));
  return { repositories, rules };
}
