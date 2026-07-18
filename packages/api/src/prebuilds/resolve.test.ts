/**
 * `resolvePrebuildImage` matrix (sandbox images v2 plan, Task 4, spec
 * decisions 1/8). Pins each branch of "does this session boot from a prebuilt
 * image?" against a real PGlite app db and a fake provider whose `customImage`
 * capability is toggled per case. Everything that isn't the pushed/enabled/
 * capable/bound happy path resolves to `null` (stock cold start).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxCapabilities, SandboxProvider } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { freshTestPgDb, type TestPgDb } from "../test-helpers/pg-test-db.js";
import { prebuildConfigs, prebuilds } from "../schema/index.js";
import type { SessionMeta } from "../engine/host.js";
import type { RepoBinding } from "../wire/types.js";
import { resolvePrebuildImage } from "./resolve.js";

const ORG = "org1";
const NOW = 1_700_000_000_000;
const REPO = "acme/widgets";

function fakeProvider(customImage: boolean, backend = "fake"): SandboxProvider {
  const caps: SandboxCapabilities = {
    snapshot: "none",
    persistentWorkspace: true,
    tunnels: false,
    warmPool: false,
    hibernation: false,
    customImage,
  };
  return {
    backend,
    capabilities: () => caps,
    create: async () => {
      throw new Error("not used");
    },
    restore: async () => {
      throw new Error("not used");
    },
    destroy: async () => {},
    status: async (id) => ({ id, state: "released" }),
  };
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  const primary: RepoBinding = {
    host: "github",
    fullName: REPO,
    cloneUrl: "https://github.com/acme/widgets.git",
    auth: "auto",
  };
  return {
    userId: "u1",
    orgId: ORG,
    workspace: "/tmp/w",
    repos: [primary],
    ...overrides,
  };
}

async function seedConfig(db: AppDb, opts: { enabled?: boolean } = {}): Promise<string> {
  const id = "cfg1";
  await db.insert(prebuildConfigs).values({
    id,
    orgId: ORG,
    repoHost: "github",
    repoFullName: REPO,
    cloneUrl: "https://github.com/acme/widgets.git",
    schedule: "nightly",
    enabled: opts.enabled ?? true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

async function seedPrebuild(
  db: AppDb,
  configId: string,
  opts: {
    id: string;
    status: "queued" | "building" | "pushed" | "failed";
    imageRef: string;
    commitSha: string;
    createdAt: number;
    recipe?: unknown;
  },
): Promise<void> {
  await db.insert(prebuilds).values({
    id: opts.id,
    configId,
    commitSha: opts.commitSha,
    imageRef: opts.imageRef,
    status: opts.status,
    builderBackend: "docker",
    recipe: opts.recipe ?? { recipe: [], setup: [], image: undefined },
    error: null,
    logTail: null,
    startedAt: opts.createdAt,
    finishedAt: opts.createdAt,
    createdAt: opts.createdAt,
  });
}

describe("resolvePrebuildImage", () => {
  let harness: TestPgDb;
  let db: AppDb;

  beforeEach(async () => {
    harness = await freshTestPgDb();
    db = harness.appDb;
  });
  afterEach(async () => {
    await harness.cleanup();
  });

  it("pushed: resolves to the newest pushed image + records its id, sha, recipe", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, {
      id: "pb-old",
      status: "pushed",
      imageRef: "valet-prebuild/acme-widgets:old",
      commitSha: "oldsha",
      createdAt: NOW,
    });
    await seedPrebuild(db, cfg, {
      id: "pb-new",
      status: "pushed",
      imageRef: "valet-prebuild/acme-widgets:new",
      commitSha: "newsha",
      createdAt: NOW + 1000,
      recipe: { recipe: [{ id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" }], setup: [] },
    });

    const res = await resolvePrebuildImage(db, meta(), fakeProvider(true));
    expect(res).toEqual({
      imageRef: "valet-prebuild/acme-widgets:new",
      prebuildId: "pb-new",
      bakedSha: "newsha",
      recipe: [{ id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" }],
    });
  });

  it("none: enabled config but no prebuild rows → null", async () => {
    await seedConfig(db);
    expect(await resolvePrebuildImage(db, meta(), fakeProvider(true))).toBeNull();
  });

  it("failed-only: config with only a failed prebuild → null", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, {
      id: "pb-fail",
      status: "failed",
      imageRef: "valet-prebuild/acme-widgets:fail",
      commitSha: "x",
      createdAt: NOW,
    });
    expect(await resolvePrebuildImage(db, meta(), fakeProvider(true))).toBeNull();
  });

  it("queued/building are ignored — only pushed counts → null", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, {
      id: "pb-q",
      status: "queued",
      imageRef: "valet-prebuild/acme-widgets:q",
      commitSha: "x",
      createdAt: NOW,
    });
    await seedPrebuild(db, cfg, {
      id: "pb-b",
      status: "building",
      imageRef: "valet-prebuild/acme-widgets:b",
      commitSha: "y",
      createdAt: NOW + 1,
    });
    expect(await resolvePrebuildImage(db, meta(), fakeProvider(true))).toBeNull();
  });

  it("disabled-config: pushed prebuild but config disabled → null", async () => {
    const cfg = await seedConfig(db, { enabled: false });
    await seedPrebuild(db, cfg, {
      id: "pb-new",
      status: "pushed",
      imageRef: "valet-prebuild/acme-widgets:new",
      commitSha: "newsha",
      createdAt: NOW,
    });
    expect(await resolvePrebuildImage(db, meta(), fakeProvider(true))).toBeNull();
  });

  it("capability-false: provider without customImage ignores the pushed image → null", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, {
      id: "pb-new",
      status: "pushed",
      imageRef: "valet-prebuild/acme-widgets:new",
      commitSha: "newsha",
      createdAt: NOW,
    });
    expect(await resolvePrebuildImage(db, meta(), fakeProvider(false))).toBeNull();
  });

  it("unbound-session: no repo bindings → null", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, {
      id: "pb-new",
      status: "pushed",
      imageRef: "valet-prebuild/acme-widgets:new",
      commitSha: "newsha",
      createdAt: NOW,
    });
    expect(await resolvePrebuildImage(db, meta({ repos: undefined }), fakeProvider(true))).toBeNull();
  });

  it("no matching config for the primary binding → null", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, {
      id: "pb-new",
      status: "pushed",
      imageRef: "valet-prebuild/acme-widgets:new",
      commitSha: "newsha",
      createdAt: NOW,
    });
    const other = meta({
      repos: [{ host: "github", fullName: "acme/other", cloneUrl: "https://github.com/acme/other.git", auth: "auto" }],
    });
    expect(await resolvePrebuildImage(db, other, fakeProvider(true))).toBeNull();
  });

  it("no db → null (tests without an app db)", async () => {
    expect(await resolvePrebuildImage(undefined, meta(), fakeProvider(true))).toBeNull();
  });

  describe("kubernetes pull preflight (Fix 3: registry-down worse-than-cold)", () => {
    async function seedPushed(): Promise<void> {
      const cfg = await seedConfig(db);
      await seedPrebuild(db, cfg, {
        id: "pb-k8s",
        status: "pushed",
        imageRef: "localhost:30500/cfg1/acme-widgets:newsha",
        commitSha: "newsha",
        createdAt: NOW,
      });
    }

    it("registry up (HEAD 200): resolves the prebuilt ref, HEAD hits the PUSH host", async () => {
      await seedPushed();
      const heads: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        heads.push(`${init?.method} ${typeof input === "string" ? input : input.toString()}`);
        return new Response(null, { status: 200 });
      };
      const res = await resolvePrebuildImage(db, meta(), fakeProvider(true, "kubernetes"), {
        registryInsecure: true,
        registryPushHost: "valet-registry:5000",
        fetchImpl,
      });
      expect(res?.imageRef).toBe("localhost:30500/cfg1/acme-widgets:newsha");
      // Preflight swapped the node-facing pull host for the in-cluster push host.
      expect(heads).toEqual(["HEAD http://valet-registry:5000/v2/cfg1/acme-widgets/manifests/newsha"]);
    });

    it("registry down (HEAD rejects): resolves to null (cold start, not the prebuilt ref)", async () => {
      await seedPushed();
      const fetchImpl: typeof fetch = async () => {
        throw new Error("ECONNREFUSED");
      };
      const res = await resolvePrebuildImage(db, meta(), fakeProvider(true, "kubernetes"), {
        registryInsecure: true,
        registryPushHost: "valet-registry:5000",
        fetchImpl,
      });
      expect(res).toBeNull();
    });

    it("image pruned (HEAD 404): resolves to null (cold start)", async () => {
      await seedPushed();
      const fetchImpl: typeof fetch = async () => new Response(null, { status: 404 });
      const res = await resolvePrebuildImage(db, meta(), fakeProvider(true, "kubernetes"), {
        registryInsecure: true,
        fetchImpl,
      });
      expect(res).toBeNull();
    });

    it("docker backend: no preflight (daemon-local image), resolves without any fetch", async () => {
      const cfg = await seedConfig(db);
      await seedPrebuild(db, cfg, {
        id: "pb-docker",
        status: "pushed",
        imageRef: "valet-prebuild/cfg1/acme-widgets:newsha",
        commitSha: "newsha",
        createdAt: NOW,
      });
      let called = false;
      const fetchImpl: typeof fetch = async () => {
        called = true;
        return new Response(null, { status: 500 });
      };
      const res = await resolvePrebuildImage(db, meta(), fakeProvider(true, "docker"), {
        registryInsecure: true,
        fetchImpl,
      });
      expect(res?.imageRef).toBe("valet-prebuild/cfg1/acme-widgets:newsha");
      expect(called).toBe(false);
    });
  });

  it("secondary binding matching a config does NOT resolve — only the primary (position 0) counts", async () => {
    const cfg = await seedConfig(db);
    await seedPrebuild(db, cfg, {
      id: "pb-new",
      status: "pushed",
      imageRef: "valet-prebuild/acme-widgets:new",
      commitSha: "newsha",
      createdAt: NOW,
    });
    const m = meta({
      repos: [
        { host: "github", fullName: "acme/other", cloneUrl: "https://github.com/acme/other.git", auth: "auto" },
        { host: "github", fullName: REPO, cloneUrl: "https://github.com/acme/widgets.git", auth: "auto" },
      ],
    });
    expect(await resolvePrebuildImage(db, m, fakeProvider(true))).toBeNull();
  });
});
