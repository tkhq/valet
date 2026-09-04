import { describe, expect, it, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { AppDb } from "../../lib/drizzle.js";
import { freshTestPgDb } from "../../test-helpers/pg-test-db.js";
import { contentSources, orgMembers, orgs, users } from "../../schema/index.js";
import { createContentSource } from "../content-sources.js";
import { GitHubSkillRepoReader } from "../skill-repo-reader.js";
import type { SkillOwner } from "../skills.js";
import { ContentSyncService } from "./service.js";
import { parseContentPushPayload, contentSourceRefMatchesPush } from "./push.js";

const ORG = "org1";

function owner(userId: string): SkillOwner {
  return { userId, orgId: ORG };
}

function push(over: { repo?: string; ref?: string; defaultBranch?: string } = {}) {
  return {
    repoFullName: over.repo ?? "tkhq/skills",
    gitRef: over.ref ?? "refs/heads/main",
    defaultBranch: over.defaultBranch ?? "main",
  };
}

describe("parseContentPushPayload", () => {
  it("reads the repository and ref", () => {
    expect(
      parseContentPushPayload({
        ref: "refs/heads/main",
        repository: { full_name: "tkhq/skills", default_branch: "main" },
      }),
    ).toEqual({
      repoFullName: "tkhq/skills",
      gitRef: "refs/heads/main",
      defaultBranch: "main",
    });
  });

  it("defaults the branch name when GitHub omitted it", () => {
    expect(
      parseContentPushPayload({
        ref: "refs/heads/main",
        repository: { full_name: "tkhq/skills" },
      })?.defaultBranch,
    ).toBe("main");
  });

  it("returns null when the payload is not a push", () => {
    expect(parseContentPushPayload({ action: "created" })).toBeNull();
    expect(parseContentPushPayload({ ref: "refs/heads/main" })).toBeNull();
  });
});

describe("contentSourceRefMatchesPush", () => {
  it("matches an empty source ref to the default branch only", () => {
    expect(contentSourceRefMatchesPush("", push())).toBe(true);
    expect(contentSourceRefMatchesPush("", push({ ref: "refs/heads/dev" }))).toBe(false);
    expect(contentSourceRefMatchesPush("", push({ ref: "refs/tags/v1" }))).toBe(false);
  });

  it("matches a named branch or tag, short or fully qualified", () => {
    expect(contentSourceRefMatchesPush("dev", push({ ref: "refs/heads/dev" }))).toBe(true);
    expect(contentSourceRefMatchesPush("refs/heads/dev", push({ ref: "refs/heads/dev" }))).toBe(true);
    expect(contentSourceRefMatchesPush("v1", push({ ref: "refs/tags/v1" }))).toBe(true);
    expect(contentSourceRefMatchesPush("main", push({ ref: "refs/heads/dev" }))).toBe(false);
  });
});

describe("ContentSyncService.onPush", () => {
  let db: AppDb;

  beforeEach(async () => {
    const handle = await freshTestPgDb();
    db = handle.appDb;
    await db.insert(orgs).values({ id: ORG, name: "Org", createdAt: Date.now() });
    await db.insert(users).values({ id: "u1", email: "u1@x.test", name: "u1", role: "admin" });
    await db.insert(orgMembers).values({ orgId: ORG, userId: "u1", role: "admin" });
  });

  /** The service with no reader: `onPush` marks rows due and never syncs
   * inline, so nothing here reaches GitHub. */
  function service(): ContentSyncService {
    return new ContentSyncService({ db, reader: new GitHubSkillRepoReader({ apiUrl: "http://127.0.0.1:1" }) });
  }

  async function dueAt(id: string): Promise<number> {
    const [row] = await db.select().from(contentSources).where(eq(contentSources.id, id));
    return row.nextAttemptAt;
  }

  it("marks every matching source due, whoever owns it", async () => {
    const orgDev = await createContentSource(db, owner("u1"), {
      repo: "tkhq/skills",
      ref: "dev",
      ownerType: "org",
    });
    const personalDefault = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const otherRepo = await createContentSource(db, owner("u1"), {
      repo: "tkhq/other",
      ownerType: "org",
    });

    // A source is due at creation, so push them all into the future first.
    const later = Date.now() + 3_600_000;
    await db.update(contentSources).set({ nextAttemptAt: later });

    // The org source tracks `dev`; the personal one tracks the default
    // branch. A push to `dev` moves only the first.
    expect(await service().onPush(ORG, "tkhq/skills", "refs/heads/dev", "main")).toBe(1);
    expect(await dueAt(orgDev.id)).toBeLessThan(later);
    expect(await dueAt(personalDefault.id)).toBe(later);
    expect(await dueAt(otherRepo.id)).toBe(later);

    // A push to the default branch moves the personal one. This is the half
    // that used to be org-only.
    expect(await service().onPush(ORG, "tkhq/skills", "refs/heads/main", "main")).toBe(1);
    expect(await dueAt(personalDefault.id)).toBeLessThan(later);
  });

  it("marks nothing for another repository, another org, or a disabled source", async () => {
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const later = Date.now() + 3_600_000;
    await db.update(contentSources).set({ nextAttemptAt: later });

    expect(await service().onPush(ORG, "tkhq/elsewhere", "refs/heads/main", "main")).toBe(0);
    expect(await service().onPush("other-org", "tkhq/skills", "refs/heads/main", "main")).toBe(0);

    await db.update(contentSources).set({ enabled: false }).where(eq(contentSources.id, source.id));
    expect(await service().onPush(ORG, "tkhq/skills", "refs/heads/main", "main")).toBe(0);
    expect(await dueAt(source.id)).toBe(later);
  });

  // `recordFailure` puts a failing source on a backoff ladder. A repository
  // that pushes often would otherwise reset it on every push and retry a
  // broken source at push rate.
  it("leaves a source in error on its backoff", async () => {
    const source = await createContentSource(db, owner("u1"), { repo: "tkhq/skills" });
    const later = Date.now() + 3_600_000;
    await db.update(contentSources).set({ nextAttemptAt: later, status: "error" });

    expect(await service().onPush(ORG, "tkhq/skills", "refs/heads/main", "main")).toBe(0);
    expect(await dueAt(source.id)).toBe(later);
  });
});
