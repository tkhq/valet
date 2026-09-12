import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxProvider } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { imageSources, bakes } from "../schema/index.js";
import { RecordingSandboxProvider } from "../test-helpers/recording-sandbox.js";

const BASE_IMAGE = "registry.local/base:older";
const REPO_IMAGE = "registry.local/repo:older";
const meta = {
  userId: "local-user", orgId: "local-org", workspace: "",
  repos: [{ host: "github", fullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git", targetDir: "widgets" }],
};

function kubernetesProvider(): SandboxProvider {
  const provider = new RecordingSandboxProvider();
  return {
    backend: "kubernetes",
    capabilities: () => ({ ...provider.capabilities(), isolated: true }),
    create: (opts) => provider.create(opts),
    restore: (id) => provider.restore(id),
    destroy: (id) => provider.destroy(id),
    status: (id) => provider.status(id),
  };
}

describe("EngineHost registry admission image resolution", () => {
  let api: TestApi | undefined;
  afterEach(async () => { await api?.cleanup(); api = undefined; });

  async function seedImages(testApi: TestApi): Promise<void> {
    const now = Date.now();
    for (const kind of ["base", "repo"] as const) {
      await testApi.providers.db.insert(imageSources).values({
        id: kind, orgId: "local-org", kind, name: kind, profile: "full", enabled: true,
        repoHost: kind === "repo" ? "github" : null,
        repoFullName: kind === "repo" ? "acme/widgets" : null,
        createdAt: now, updatedAt: now,
      });
      await testApi.providers.db.insert(bakes).values({
        id: `${kind}-bake`, sourceId: kind, identityHash: "",
        commitSha: kind === "repo" ? "abc123" : null,
        imageRef: kind === "repo" ? REPO_IMAGE : BASE_IMAGE,
        status: "pushed", builderBackend: "kubernetes", createdAt: now,
      });
    }
  }

  it("selects the repository bake before base and stock images", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    api = await bootTestApi({
      sandboxProvider: kubernetesProvider(), defaultImage: "stock:existing",
      prebuildPreflight: { registryInsecure: true, fetchImpl },
    });
    await seedImages(api);
    expect(await api.providers.engineHost.resolveChildStartupImage(meta)).toBe(REPO_IMAGE);
    expect(fetchImpl).toHaveBeenCalledWith("http://registry.local/v2/repo/manifests/older", expect.objectContaining({ method: "HEAD" }));
    expect(fetchImpl).toHaveBeenCalledWith("http://registry.local/v2/base/manifests/older", expect.objectContaining({ method: "HEAD" }));
  });

  it.each(["stock:existing", undefined])("rejects unpullable bakes with stock image %s", async (defaultImage) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    api = await bootTestApi({
      sandboxProvider: kubernetesProvider(), defaultImage,
      prebuildPreflight: { registryInsecure: true, fetchImpl },
    });
    await seedImages(api);
    expect(await api.providers.engineHost.resolveChildStartupImage(meta)).toBe(defaultImage ?? null);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
