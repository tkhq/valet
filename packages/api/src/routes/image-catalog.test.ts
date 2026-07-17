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
  name: string;
  ref: string;
  pullSecretName: string | null;
  kind: string;
  createdAt: number;
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
    expect(body.images[0].ref).toBe("ghcr.io/acme/base:latest");
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
    expect(body.image.kind).toBe("base");
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
