import { describe, expect, it } from "vitest";
import { DockerImageBuilder } from "../prebuilds/docker-builder.js";
import { parseImageBuilderBackend, resolveImageBuilder } from "./image-builder.js";

describe("parseImageBuilderBackend", () => {
  it("returns undefined for unset/empty", () => {
    expect(parseImageBuilderBackend(undefined)).toBeUndefined();
    expect(parseImageBuilderBackend("")).toBeUndefined();
  });

  it("accepts the known backends", () => {
    expect(parseImageBuilderBackend("docker")).toBe("docker");
    expect(parseImageBuilderBackend("kubernetes")).toBe("kubernetes");
    expect(parseImageBuilderBackend("none")).toBe("none");
  });

  it("throws on an unrecognized value", () => {
    expect(() => parseImageBuilderBackend("bogus")).toThrow(/Invalid VALET_IMAGE_BUILDER/);
  });
});

describe("resolveImageBuilder", () => {
  it("defaults to docker when VALET_SANDBOX_BACKEND is docker (or unset)", () => {
    expect(resolveImageBuilder({})).toBeInstanceOf(DockerImageBuilder);
    expect(resolveImageBuilder({ VALET_SANDBOX_BACKEND: "docker" })).toBeInstanceOf(DockerImageBuilder);
  });

  it("defaults to null (kubernetes stub) when VALET_SANDBOX_BACKEND is kubernetes", () => {
    expect(resolveImageBuilder({ VALET_SANDBOX_BACKEND: "kubernetes" })).toBeNull();
  });

  it("defaults to null when VALET_SANDBOX_BACKEND is local", () => {
    expect(resolveImageBuilder({ VALET_SANDBOX_BACKEND: "local" })).toBeNull();
  });

  it("VALET_IMAGE_BUILDER=none overrides a docker sandbox backend to null", () => {
    const result = resolveImageBuilder({ VALET_SANDBOX_BACKEND: "docker", VALET_IMAGE_BUILDER: "none" });
    expect(result).toBeNull();
  });

  it("VALET_IMAGE_BUILDER=docker overrides a local sandbox backend to a docker builder", () => {
    const result = resolveImageBuilder({ VALET_SANDBOX_BACKEND: "local", VALET_IMAGE_BUILDER: "docker" });
    expect(result).toBeInstanceOf(DockerImageBuilder);
  });

  it("returned builder's backend property matches", () => {
    const builder = resolveImageBuilder({});
    expect(builder?.backend).toBe("docker");
  });
});
