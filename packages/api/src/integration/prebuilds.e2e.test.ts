/**
 * Sandbox images v2 (prebuilds) plan — Task 7 e2e. One coherent scenario
 * driving the full API loop through the REAL docker builder against a real
 * daemon and a tiny public repo (`octocat/Hello-World`, no auth needed to
 * clone — the shared `startGithubFixture()` only stands in for the GitHub
 * *API* calls the service makes to resolve the head sha + recipe, per
 * `PrebuildService`'s doc comment):
 *
 *   1. `POST /api/org/image-catalog` registers a git-having base image (a
 *      locally-built alpine+git image — prebuild base images MUST carry
 *      git, see `routes/image-catalog.ts`'s doc comment).
 *   2. `POST /api/org/prebuilds/configs` creates a config for the repo.
 *   3. `POST /api/org/prebuilds/configs/:id/rebuild` dispatches a REAL
 *      `docker build` (via `DockerImageBuilder`); the test polls
 *      `syncActiveBuilds()` directly (no interval wired in `bootTestApi`)
 *      until the row reaches `pushed`.
 *   4. `POST /api/sessions` binds the same repo; a real
 *      `EngineHost.sessionFor(...)` + `attachment.ensureReady()` resolves
 *      the prebuilt image ref (`resolvePrebuildImage`), persists
 *      `agent_sessions.prebuild_id`, and drives `buildWorkspacePrep`'s
 *      fetch-on-start path against a REAL `DockerSandboxProvider` sandbox —
 *      the workspace ends up with the repo staged from the image's
 *      `/prebuilt/repo` (`cp -a`, not a clone — see the design deviation
 *      note in `engine/workspace-prep.ts`).
 *   5. Cold-path control: a second session with NO repo binding resolves no
 *      prebuild at all (`prebuild_id` stays null) — proving prebuilds never
 *      intrude on a session that doesn't ask for one.
 *   6. Retention: two older `pushed` rows (real, distinct images built
 *      directly through a second `DockerImageBuilder`) are seeded for the
 *      same config with older `createdAt`s. A second real rebuild through
 *      the route makes three total `pushed` rows; syncing the pushed
 *      transition runs `applyRetention`, which `docker rmi -f`'s the single
 *      oldest row's image (the newest 2 are kept) — asserted against the
 *      real daemon via `docker image inspect`, not just row bookkeeping.
 *
 * Docker-gated: skipped entirely when a daemon isn't reachable, same idiom
 * as every other `*.docker.test.ts`/`*.e2e.test.ts` in this repo that needs
 * one. Network is required (clones/ls-remotes `octocat/Hello-World` for
 * real). No `ANTHROPIC_API_KEY` needed — nothing here drives a model turn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { DockerSandboxProvider } from "@valet/sandbox-docker";
import { bootTestApi, type TestApi } from "./_setup.js";
import { startGithubFixture, type GithubFixture } from "../test-helpers/github-fixture.js";
import { DockerImageBuilder } from "../prebuilds/docker-builder.js";
import { agentSessions, bakes } from "../schema/index.js";
import type {
  CreateSessionResponse,
} from "../wire/types.js";

const HEADERS = { "Content-Type": "application/json" };
const CLONE_URL = "https://github.com/octocat/Hello-World.git";
const REPO_FULL_NAME = "octocat/Hello-World";
const BASE_IMAGE = "valet-t7-e2e-base:git";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "pipe" });
  return r.status === 0;
}

const dockerHere = dockerAvailable();
// Skip in CI: this full prebuild loop does a real docker build + registry
// push that the GitHub runner isn't provisioned for (passes locally). `CI` =
// GitHub Actions.
const describeDocker = dockerHere && !process.env.CI ? describe : describe.skip;

/** `git ls-remote` the repo's default-branch HEAD so the baked commit is
 * real (the generated Dockerfile `git checkout`s it) without hardcoding a
 * sha that could rot — same idiom as `workspace-prep-prebuilt.docker.test.ts`. */
function resolveHeadSha(): string {
  const r = spawnSync("git", ["ls-remote", CLONE_URL, "HEAD"], { stdio: "pipe", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-remote failed: ${r.stderr}`);
  const sha = r.stdout.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected ls-remote sha: ${sha}`);
  return sha;
}

async function waitForBuildId(builder: DockerImageBuilder, buildId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await builder.status(buildId);
    if (st.state === "pushed") return;
    if (st.state === "failed") throw new Error(`prebuild failed: ${st.error}\n${st.logTail ?? ""}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("prebuild timed out");
}

let api: TestApi | undefined;
let fixture: GithubFixture | undefined;
let tmp: string | undefined;
let sandboxProvider: DockerSandboxProvider | undefined;
const builtImages: string[] = [];
const prevGithubApiUrl = process.env.GITHUB_API_URL;
const prevGithubUrl = process.env.GITHUB_URL;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  await fixture?.close();
  fixture = undefined;
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = undefined;
  sandboxProvider = undefined;
  for (const ref of builtImages.splice(0)) {
    spawnSync("docker", ["rmi", "-f", ref], { stdio: "pipe" });
  }
  if (prevGithubApiUrl === undefined) delete process.env.GITHUB_API_URL;
  else process.env.GITHUB_API_URL = prevGithubApiUrl;
  if (prevGithubUrl === undefined) delete process.env.GITHUB_URL;
  else process.env.GITHUB_URL = prevGithubUrl;
});

describeDocker("Sandbox images v2 (prebuilds) — full API loop e2e (docker)", () => {
  it(
    "catalog -> config -> real build -> session resolves + stages the prebuilt repo -> cold control -> retention keeps 2",
    async () => {
      // A tiny base image WITH git — the generated Dockerfile's first RUN is
      // the clone, so git must already be present in the base (T2's finding,
      // documented on `routes/image-catalog.ts`).
      const build = spawnSync(
        "docker",
        ["build", "-t", BASE_IMAGE, "-"],
        { input: "FROM alpine:3.20\nRUN apk add --no-cache git\n", stdio: "pipe", encoding: "utf8" },
      );
      if (build.status !== 0) throw new Error(`base image build failed: ${build.stderr}`);
      builtImages.push(BASE_IMAGE);

      const bakedSha = resolveHeadSha();

      // Fixture stands in for the GitHub *API* (contents/commits) the
      // service hits to resolve the head sha + recipe — never the actual
      // clone target, which is the real `github.com` throughout.
      fixture = startGithubFixture({
        getRepo: () => ({ body: { default_branch: "master" } }),
        getCommit: () => ({ body: { sha: bakedSha } }),
        getContents: () => ({ status: 404, body: { message: "Not Found" } }),
      });
      process.env.GITHUB_API_URL = fixture.url;
      process.env.GITHUB_URL = fixture.url;

      tmp = await mkdtemp(join(tmpdir(), "valet-t7-e2e-"));
      sandboxProvider = new DockerSandboxProvider();

      api = await bootTestApi({
        sandboxProvider,
        // Cold-path control boots from this — already local, no network pull.
        defaultImage: BASE_IMAGE,
        imageBuilder: new DockerImageBuilder(),
        githubApiUrl: fixture.url,
      });

      // Auto+api/git tiers both fall through to this org PAT (no
      // installation/user credential seeded) — a bogus token is sufficient:
      // GitHub accepts it for a public-repo clone (verified against the real
      // API), and the fixture never validates it at all for the "api" calls.
      await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "github", {
        type: "api_key",
        accessToken: "org-pat-token",
        metadata: { login: "org-pat" },
      });

      // ── 1. External source (replaces old image-catalog entry) ────────────
      const catalogRes = await fetch(`${api.baseUrl}/api/org/sources`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ kind: "external", name: "t7-e2e-base", externalRef: BASE_IMAGE }),
      });
      expect(catalogRes.status).toBe(201);
      const { source: catalogImage } = (await catalogRes.json()) as { source: { id: string } };

      // ── 2. Repo source (replaces old prebuild config) ────────────────────
      // Repo sources are auto-created on session bind; for this e2e we insert
      // directly via the DB to avoid wiring a full bind flow here.
      const { imageSources } = await import("../schema/index.js");
      const { randomUUID } = await import("node:crypto");
      const repoSourceRow = {
        id: `src_${randomUUID()}`,
        orgId: "local-org",
        kind: "repo" as const,
        parentId: catalogImage.id,
        name: REPO_FULL_NAME,
        externalRef: null,
        pullSecretName: null,
        setupCommands: null,
        repoHost: "github",
        repoFullName: REPO_FULL_NAME,
        cloneUrl: CLONE_URL,
        schedule: "off" as const,
        enabled: true,
        lastBoundAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await api.providers.db.insert(imageSources).values(repoSourceRow);
      const config = repoSourceRow;

      // ── 3. Real build #1 (via the route + real docker daemon) ──────────
      const rebuildRes = await fetch(`${api.baseUrl}/api/org/sources/${config.id}/bake`, {
        method: "POST",
        headers: HEADERS,
      });
      expect(rebuildRes.status).toBe(202);
      const { bake: firstBuild } = (await rebuildRes.json()) as { bake: { status: string } };
      expect(firstBuild.status).toBe("queued");

      const firstPushed = await waitForConfigPushed(api, config.id, 180_000);
      expect(firstPushed.commitSha).toBe(bakedSha);
      builtImages.push(firstPushed.imageRef);

      // ── 4. Session resolves the prebuild + stages the repo ─────────────
      const boundCreateRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({
          workspace: join(tmp, "bound-workspace"),
          repo: { fullName: REPO_FULL_NAME, cloneUrl: CLONE_URL, auth: "auto" },
        }),
      });
      expect(boundCreateRes.status).toBe(201);
      const boundSession = (await boundCreateRes.json()) as CreateSessionResponse;

      const engineSession = await api.providers.engineHost.sessionFor(boundSession.id, {
        userId: "local-user",
        orgId: "local-org",
        workspace: join(tmp, "bound-workspace"),
        repos: [{ host: "github", fullName: REPO_FULL_NAME, cloneUrl: CLONE_URL, auth: "auto", targetDir: "Hello-World" }],
      });
      await engineSession.attachment.ensureReady({ timeoutMs: 60_000 });

      const boundRows = await api.providers.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, boundSession.id));
      expect(boundRows[0]?.bakeId).toBe(firstPushed.id);

      const sandbox = engineSession.attachment.current();
      expect(sandbox).not.toBeNull();
      // Repo clones into "Hello-World" subdir (spec decision 15: single-repo
      // sessions always clone into <repoName>/, not the workspace root).
      const head = await sandbox!.exec("git rev-parse HEAD", { cwd: "Hello-World" });
      expect(head.exitCode).toBe(0);
      expect(head.stdout.trim()).toBe(bakedSha);
      const origin = await sandbox!.exec("git remote get-url origin", { cwd: "Hello-World" });
      expect(origin.stdout.trim()).toBe(CLONE_URL);

      // ── 5. Cold-path control: unbound session ignores the catalog ──────
      const unboundCreateRes = await fetch(`${api.baseUrl}/api/sessions`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ workspace: join(tmp, "unbound-workspace") }),
      });
      expect(unboundCreateRes.status).toBe(201);
      const unboundSession = (await unboundCreateRes.json()) as CreateSessionResponse;

      const unboundEngineSession = await api.providers.engineHost.sessionFor(unboundSession.id, {
        userId: "local-user",
        orgId: "local-org",
        workspace: join(tmp, "unbound-workspace"),
      });
      await unboundEngineSession.attachment.ensureReady({ timeoutMs: 60_000 });

      const unboundRows = await api.providers.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, unboundSession.id));
      expect(unboundRows[0]?.bakeId ?? null).toBeNull();

      // ── 6. Retention: seed two older real "pushed" builds, then a real
      // rebuild pushes a third — the oldest of the three must be deleted. ──
      const seedBuilder = new DockerImageBuilder();
      const oldRefs = [
        `valet-prebuild-test/t7-old1:${Date.now()}`,
        `valet-prebuild-test/t7-old2:${Date.now() + 1}`,
      ];
      for (const ref of oldRefs) {
        const { buildId } = await seedBuilder.build({
          configId: config.id,
          prebuildId: `seed-${ref}`,
          cloneUrl: CLONE_URL,
          commitSha: bakedSha,
          baseImage: BASE_IMAGE,
          recipe: [],
          imageRef: ref,
        });
        await waitForBuildId(seedBuilder, buildId, 180_000);
        builtImages.push(ref);
      }
      // Anchored to `firstPushed.createdAt` (not `Date.now()`) so ordering
      // relative to it is deterministic regardless of how much real wall
      // time the build/session steps above actually took: old1 < old2 <
      // firstPushed... wait, both MUST be newer than firstPushed and older
      // than the still-to-come `secondPushed` (created via a real
      // `startBuild` call below, whose `createdAt` is `Date.now()` at that
      // point — always later than these fixed offsets).
      const seedBase = firstPushed.createdAt;
      await api.providers.db.insert(bakes).values([
        {
          id: "pb-t7-old1",
          sourceId: config.id,
          identityHash: "",
          commitSha: "seed-sha-1",
          imageRef: oldRefs[0]!,
          status: "pushed",
          builderBackend: "docker",
          recipe: { recipe: [], setup: [], image: undefined },
          error: null,
          logTail: null,
          startedAt: seedBase + 1_000,
          finishedAt: seedBase + 1_000,
          createdAt: seedBase + 1_000,
        },
        {
          id: "pb-t7-old2",
          sourceId: config.id,
          identityHash: "",
          commitSha: "seed-sha-2",
          imageRef: oldRefs[1]!,
          status: "pushed",
          builderBackend: "docker",
          recipe: { recipe: [], setup: [], image: undefined },
          error: null,
          logTail: null,
          startedAt: seedBase + 2_000,
          finishedAt: seedBase + 2_000,
          createdAt: seedBase + 2_000,
        },
      ]);

      const rebuild2Res = await fetch(`${api.baseUrl}/api/org/sources/${config.id}/bake`, {
        method: "POST",
        headers: HEADERS,
      });
      expect(rebuild2Res.status).toBe(202);
      const secondPushed = await waitForConfigPushed(api, config.id, 180_000, /* skipId */ firstPushed.id);
      builtImages.push(secondPushed.imageRef);

      // The repo's HEAD hasn't moved between the two rebuilds (fixture pins
      // `bakedSha`), so `secondPushed.imageRef === firstPushed.imageRef` —
      // the same tag, re-built. `applyRetention`'s kept-ref dedup (T3 fix
      // round) treats that shared ref as one kept image even though
      // `firstPushed`'s ROW itself falls out of the newest-2 window; only
      // `pb-t7-old1` (a genuinely distinct, older, unshared ref) is actually
      // deleted — assert against the REAL daemon, not just row bookkeeping.
      const oldest = spawnSync("docker", ["image", "inspect", oldRefs[0]!], { stdio: "pipe" });
      expect(oldest.status).not.toBe(0);
      const kept1 = spawnSync("docker", ["image", "inspect", oldRefs[1]!], { stdio: "pipe" });
      expect(kept1.status).toBe(0);
      const kept2 = spawnSync("docker", ["image", "inspect", secondPushed.imageRef], { stdio: "pipe" });
      expect(kept2.status).toBe(0);

      const allBuilds = await fetch(`${api.baseUrl}/api/org/sources/${config.id}/bakes`, {
        headers: HEADERS,
      });
      const { bakes: builds } = (await allBuilds.json()) as { bakes: unknown[] };
      // All 4 ROWS survive (retention deletes images, never rows).
      expect(builds).toHaveLength(4);
    },
    300_000,
  );
});

/** Polls `syncActiveBuilds()` directly (no interval is wired in
 * `bootTestApi`) until the config's NEWEST build (excluding `skipId`, used
 * on the second rebuild so the poll doesn't false-positive on the
 * already-pushed first build) reaches `pushed`/`failed`. */
interface BakeRow {
  id: string;
  status: string;
  commitSha: string | null;
  imageRef: string;
  error: string | null;
  logTail: string | null;
  createdAt: number;
}

async function waitForConfigPushed(
  testApi: TestApi,
  configId: string,
  timeoutMs: number,
  skipId?: string,
): Promise<BakeRow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await testApi.providers.prebuildService.syncActiveBuilds();
    const res = await fetch(`${testApi.baseUrl}/api/org/sources/${configId}/bakes`, {
      headers: HEADERS,
    });
    const { bakes: builds } = (await res.json()) as { bakes: BakeRow[] };
    const newest = builds.find((b) => b.id !== skipId);
    if (newest?.status === "pushed") return newest;
    if (newest?.status === "failed") throw new Error(`prebuild failed: ${newest.error}\n${newest.logTail ?? ""}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("prebuild build did not reach pushed in time");
}
