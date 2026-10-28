import { describe, expect, it } from "vitest";
import { MIN_IMAGE_CONTRACT } from "@valet/sandbox-kubernetes";
import { compatible, readImageContractLabel, CONTRACT_LABEL } from "./image-contract.js";

const REF = "localhost:30500/src-abc/acme-widgets:deadbeef-0123456789ab";

function registry(responses: Record<string, { status?: number; body?: unknown; contentType?: string }>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    const match = Object.entries(responses).find(([suffix]) => path.endsWith(suffix));
    if (!match) return new Response("not found", { status: 404 });
    const { status = 200, body, contentType = "application/json" } = match[1];
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const deps = (fetchImpl: typeof fetch) => ({
  fetchImpl,
  spawnFn: (() => { throw new Error("spawn not expected on kubernetes"); }) as never,
  registryInsecure: true,
  registryPushHost: "registry.valet.svc:5000",
});

const MANIFEST = { schemaVersion: 2, config: { digest: "sha256:cfg", size: 10 }, layers: [] };

describe("compatible", () => {
  it.each([
    [{ contractVersion: MIN_IMAGE_CONTRACT, contractSource: "label" }, true],
    [{ contractVersion: MIN_IMAGE_CONTRACT + 1, contractSource: "label" }, true],
    [{ contractVersion: MIN_IMAGE_CONTRACT - 1, contractSource: "label" }, false],
    [{ contractVersion: 0, contractSource: "missing" }, false],
    [{ contractVersion: null, contractSource: "missing" }, false],
    [{ contractVersion: null, contractSource: null }, false],
    [{ contractVersion: null, contractSource: "override" }, true],
    [{ contractVersion: 0, contractSource: "override" }, true],
    [null, false],
    [undefined, false],
  ])("%j → %s", (bake, expected) => {
    expect(compatible(bake as never)).toBe(expected);
  });
});

describe("readImageContractLabel (kubernetes)", () => {
  it("reads the label from the config blob behind the manifest, via the push host", async () => {
    const { fetchImpl, calls } = registry({
      "/manifests/deadbeef-0123456789ab": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { [CONTRACT_LABEL]: "3" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: 3 });
    expect(calls[0]).toBe("http://registry.valet.svc:5000/v2/src-abc/acme-widgets/manifests/deadbeef-0123456789ab");
    expect(calls[1]).toBe("http://registry.valet.svc:5000/v2/src-abc/acme-widgets/blobs/sha256:cfg");
  });

  it("follows an OCI image index to its first manifest", async () => {
    const { fetchImpl } = registry({
      "/manifests/deadbeef-0123456789ab": {
        body: { schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: "sha256:m1", platform: { os: "linux", architecture: "amd64" } }] },
      },
      "/manifests/sha256:m1": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { [CONTRACT_LABEL]: "3" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: 3 });
  });

  it("an image without the label is ok with a null version", async () => {
    const { fetchImpl } = registry({
      "/manifests/deadbeef-0123456789ab": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { other: "x" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: null });
  });

  it("a non-integer label value reads as null", async () => {
    const { fetchImpl } = registry({
      "/manifests/deadbeef-0123456789ab": { body: MANIFEST },
      "/blobs/sha256:cfg": { body: { config: { Labels: { [CONTRACT_LABEL]: "three" } } } },
    });
    expect(await readImageContractLabel("kubernetes", REF, deps(fetchImpl))).toEqual({ ok: true, version: null });
  });

  it("a missing manifest is a failed read, not a null label", async () => {
    const { fetchImpl } = registry({});
    const read = await readImageContractLabel("kubernetes", REF, deps(fetchImpl));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/404/);
  });

  it("a network error is a failed read and never throws", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const read = await readImageContractLabel("kubernetes", REF, deps(fetchImpl));
    expect(read).toEqual({ ok: false, error: expect.stringContaining("ECONNREFUSED") });
  });

  it("an unknown backend is a failed read", async () => {
    const { fetchImpl } = registry({});
    expect((await readImageContractLabel("local", REF, deps(fetchImpl))).ok).toBe(false);
  });
});
