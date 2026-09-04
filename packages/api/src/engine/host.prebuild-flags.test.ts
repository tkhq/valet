/**
 * Unit coverage for `prebuildFlagsTarget` — the guard that decides whether
 * `resolveRepoPrebuildFlags` reads `.valet/prebuild.yaml` for a session
 * (TKAI-385).
 *
 * Regression: the guard once matched only host === "github.com", but
 * `session_repos.host` stores "github" (the schema default). Every bound
 * session silently resolved default flags, so a repo-declared
 * `workspaceStorage` never reached the workspace claim and the repo `docker`
 * flag never applied. The DB-backed cases pin the schema default through
 * `loadSessionMeta` into the guard, so the stored value and the guard cannot
 * drift apart again.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { agentSessions, sessionRepos } from "../schema/index.js";
import { loadSessionMeta } from "./session-meta.js";
import { prebuildFlagsTarget } from "./host.js";
import type { RepoBinding } from "../wire/types.js";

function binding(overrides: Partial<RepoBinding> = {}): RepoBinding & { targetDir: string } {
  return {
    fullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
    targetDir: "widgets",
    ...overrides,
  };
}

describe("prebuildFlagsTarget", () => {
  it('host "github" (the session_repos schema default) resolves — the TKAI-385 regression', () => {
    const target = prebuildFlagsTarget([binding({ host: "github" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it('host "github.com" (hand-built metas) also resolves', () => {
    const target = prebuildFlagsTarget([binding({ host: "github.com" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it("absent host defaults to GitHub", () => {
    const target = prebuildFlagsTarget([binding()]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "HEAD" });
  });

  it("a bound ref is passed through", () => {
    const target = prebuildFlagsTarget([binding({ host: "github", ref: "release-1.2" })]);
    expect(target).toEqual({ ok: true, owner: "acme", repo: "widgets", ref: "release-1.2" });
  });

  it("a non-GitHub host is skipped with the host named", () => {
    const target = prebuildFlagsTarget([binding({ host: "gitlab.example.com" })]);
    expect(target).toEqual({ ok: false, reason: "non-github-host", host: "gitlab.example.com" });
  });

  it("no repo bindings → no-repo", () => {
    expect(prebuildFlagsTarget(undefined)).toEqual({ ok: false, reason: "no-repo" });
    expect(prebuildFlagsTarget([])).toEqual({ ok: false, reason: "no-repo" });
  });

  it("a fullName without owner/name parts → bad-full-name", () => {
    const target = prebuildFlagsTarget([binding({ fullName: "widgets" })]);
    expect(target).toEqual({ ok: false, reason: "bad-full-name" });
  });
});

describe("prebuildFlagsTarget over loadSessionMeta (session_repos schema default)", () => {
  const ORG = "test-org";
  const USER = "test-user";
  const NOW = Date.now();
  let harness: TestPgDb;
  let db: AppDb;

  beforeEach(async () => {
    harness = await freshTestPgDb();
    db = harness.appDb;
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("a row that takes the host column DEFAULT resolves to a GitHub target", async () => {
    await db.insert(agentSessions).values({
      id: "s-flags",
      userId: USER,
      orgId: ORG,
      workspace: "/tmp/s-flags",
      status: "active",
      ownerType: "user",
      ownerId: USER,
      profile: "headless",
      createdAt: NOW,
      updatedAt: NOW,
    });
    // No `host` value: the row takes the column DEFAULT, exactly like rows
    // written by the bind flow. The guard must accept whatever that is.
    await db.insert(sessionRepos).values({
      sessionId: "s-flags",
      fullName: "tkhq/mono",
      cloneUrl: "https://github.com/tkhq/mono.git",
      ref: null,
      auth: "auto",
      position: 0,
      targetDir: "mono",
    });

    const meta = await loadSessionMeta(db, {
      id: "s-flags",
      userId: USER,
      orgId: ORG,
      workspace: "/tmp/s-flags",
    });
    const target = prebuildFlagsTarget(meta.repos);
    expect(target).toEqual({ ok: true, owner: "tkhq", repo: "mono", ref: "HEAD" });
  });
});
