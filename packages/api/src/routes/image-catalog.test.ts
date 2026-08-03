/**
 * `/api/org/image-catalog` — org-admin CRUD. Same gating pattern as
 * `routes/llm-providers.test.ts`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";

const HEADERS = { "Content-Type": "application/json" };
const MEMBER_HEADERS = { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" };

interface ImageCatalogRowJson {
  id: string;
  orgId: string;
  kind: string;
  name: string;
  externalRef: string | null;
  pullSecretName: string | null;
  createdAt: number;
  updatedAt: number;
}

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/org/image-catalog", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/image-catalog`, { headers: MEMBER_HEADERS });
    expect(res.status).toBe(403);
  });

  it("lists only the caller's org rows", async () => {
    api = await bootTestApi();
    await fetch(`${api.baseUrl}/api/org/image-catalog`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Base", ref: "ghcr.io/acme/base:latest" }),
    });
    const res = await fetch(`${api.baseUrl}/api/org/image-catalog`, { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { images: ImageCatalogRowJson[] };
    expect(body.images).toHaveLength(1);
    expect(body.images[0].name).toBe("Base");
    expect(body.images[0].externalRef).toBe("ghcr.io/acme/base:latest");
  });
});

describe("POST /api/org/image-catalog", () => {
  it("403s for a non-admin org member", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/image-catalog`, {
      method: "POST",
      headers: MEMBER_HEADERS,
      body: JSON.stringify({ name: "Base", ref: "ghcr.io/acme/base:latest" }),
    });
    expect(res.status).toBe(403);
  });

  it("400s when ref is empty", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/image-catalog`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Base", ref: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s when name is missing", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/image-catalog`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ ref: "ghcr.io/acme/base:latest" }),
    });
    expect(res.status).toBe(400);
  });

  it("creates a row with an optional pullSecretName", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/image-catalog`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "K8s base", ref: "registry.internal/base:latest", pullSecretName: "regcred" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { image: ImageCatalogRowJson };
    expect(body.image.pullSecretName).toBe("regcred");
    expect(body.image.kind).toBe("external");
    expect(typeof body.image.id).toBe("string");
  });
});

describe("DELETE /api/org/image-catalog/:id", () => {
  it("404s for an id that doesn't belong to the caller's org", async () => {
    api = await bootTestApi();
    const res = await fetch(`${api.baseUrl}/api/org/image-catalog/nonexistent`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(res.status).toBe(404);
  });

  it("404s when id belongs to a repo-kind prebuild config, not an external image", async () => {
    api = await bootTestApi();
    // Create a repo-kind config via the prebuilds endpoint.
    const cfgRes = await fetch(`${api.baseUrl}/api/org/prebuilds/configs`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ repoFullName: "acme/widgets", cloneUrl: "https://github.com/acme/widgets.git" }),
    });
    expect(cfgRes.status).toBe(201);
    const { config } = (await cfgRes.json()) as { config: { id: string } };

    // Attempt to DELETE via the image-catalog endpoint — must 404, not delete the config.
    const delRes = await fetch(`${api.baseUrl}/api/org/image-catalog/${config.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(404);

    // Config must still exist.
    const listRes = await fetch(`${api.baseUrl}/api/org/prebuilds/configs`, { headers: HEADERS });
    const body = (await listRes.json()) as { configs: { id: string }[] };
    expect(body.configs.some((c) => c.id === config.id)).toBe(true);
  });

  it("deletes a row the caller's org owns", async () => {
    api = await bootTestApi();
    const createRes = await fetch(`${api.baseUrl}/api/org/image-catalog`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ name: "Base", ref: "ghcr.io/acme/base:latest" }),
    });
    const { image } = (await createRes.json()) as { image: ImageCatalogRowJson };

    const delRes = await fetch(`${api.baseUrl}/api/org/image-catalog/${image.id}`, {
      method: "DELETE",
      headers: HEADERS,
    });
    expect(delRes.status).toBe(200);

    const listRes = await fetch(`${api.baseUrl}/api/org/image-catalog`, { headers: HEADERS });
    const body = (await listRes.json()) as { images: ImageCatalogRowJson[] };
    expect(body.images).toHaveLength(0);
  });
});
