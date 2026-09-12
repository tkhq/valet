import { readFileSync, writeFileSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NESTED_KUBERNETES_IDENTITY } from "../src/index.js";
import {
  archiveKind,
  capabilityKernel,
  K3S_ARGV,
  K3S_ENV,
  lifecycleKernel,
  mapKernel,
  statusKernel,
  readImportResult,
  validateArchive,
} from "../../../docker/valet-kubernetes.mjs";

interface Vector<TInput, TExpected> { id: string; mode?: string; input: TInput; expected: TExpected; covers?: string[] }
interface Vectors {
  capabilityVectors: Vector<{ requested: boolean; provider: false | "v1" }, string>[];
  mapVectors: Vector<number[][], boolean>[];
  lifecycleVectors: Vector<Record<string, unknown>, Record<string, unknown>>[];
  statusVectors: Vector<Record<string, unknown>, { exit: number; persistedAfter: string; stdout: string }>[];
  acceptanceVectors: { id: string; mode: string; step: string; check: string; expected: string; covers: string[] }[];
  lockDigest: string;
  artifacts: { arch: string; name: string; version: string; url: string; sha256: string }[];
  k3sArgv: string[];
  k3sEnv: Record<string, string>;
}
const vectors = JSON.parse(readFileSync("../../docs/specs/nested-kubernetes-v1-vectors.json", "utf8")) as Vectors;

describe("nested Kubernetes normative vectors", () => {
  it.each(vectors.capabilityVectors)("executes $id", ({ input, expected }) => {
    expect(capabilityKernel(input.requested, input.provider)).toBe(expected);
  });
  it.each(vectors.mapVectors)("executes $id", ({ input, expected }) => {
    expect(mapKernel(input)).toBe(expected);
  });
  it.each(vectors.lifecycleVectors)("executes $id", ({ input, expected }) => {
    expect(lifecycleKernel(input)).toEqual(expected);
  });
  it.each(vectors.statusVectors)("executes $id", ({ input, expected }) => {
    expect(statusKernel(input)).toEqual(expected);
  });

  it("binds the production capability identity to the normative lock", () => {
    expect(NESTED_KUBERNETES_IDENTITY).toBe(`nested-kubernetes:v1:${vectors.lockDigest}`);
  });

  it("uses the normative process contract", () => {
    expect(K3S_ARGV).toEqual(vectors.k3sArgv);
    expect(K3S_ENV).toEqual(vectors.k3sEnv);
  });

  it("requires unique, non-vacuous safety kernel vectors", () => {
    const groups = [vectors.capabilityVectors, vectors.mapVectors, vectors.lifecycleVectors, vectors.statusVectors, vectors.acceptanceVectors];
    const all = groups.flat();
    expect(new Set(all.map(({ id }) => id)).size).toBe(all.length);
    for (const vector of all) {
      expect(vector.id.length).toBeGreaterThan(0);
      expect(vector.covers?.length).toBeGreaterThan(0);
      expect(vector.expected).not.toBeUndefined();
    }
    const design = readFileSync("../../docs/specs/2026-09-12-nested-kubernetes-design.md", "utf8");
    const required = new Set([...design.matchAll(/\[K(\d+)\]/g)].map((match) => Number(match[1])));
    const covered = new Set<number>();
    for (const vector of all) for (const range of vector.covers ?? []) {
      for (const part of range.split(",")) {
        const match = /^K(\d+)(?:-K?(\d+))?$/.exec(part.trim());
        expect(match, `unknown coverage token: ${part}`).not.toBeNull();
        if (!match) continue;
        const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
        expect(last).toBeGreaterThanOrEqual(first);
        for (let clause = first; clause <= last; clause += 1) covered.add(clause);
      }
    }
    expect([...covered].filter((clause) => !required.has(clause))).toEqual([]);
    expect([...required].filter((clause) => !covered.has(clause))).toEqual([]);

    const lifecycleById = new Map(vectors.lifecycleVectors.map((vector) => [vector.id, vector]));
    for (const id of ["life-live-owner-no-theft", "life-start-commit-after-stop"]) {
      expect(lifecycleById.get(id)?.mode).toBe("kernel");
    }
    expect(lifecycleById.get("life-live-owner-no-theft")?.covers).toContain("K136");
    expect(lifecycleById.get("life-start-commit-after-stop")?.covers).toContain("K138-K139");
  });

  it("installs every locked artifact with its URL and checksum", () => {
    const dockerfile = readFileSync("../../docker/Dockerfile.sandbox-k8s", "utf8");
    for (const artifact of vectors.artifacts) {
      expect(dockerfile).toContain(artifact.url);
      expect(dockerfile).toContain(artifact.sha256);
      expect(dockerfile).toContain(artifact.version);
    }
    expect(dockerfile).not.toMatch(/curl[^\n]*rootlesskit/i);
  });
});

function tarHeader(name: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  for (const [offset, value, width] of [[100, "0000644\0", 8], [108, "0000000\0", 8], [116, "0000000\0", 8], [124, "00000000000\0", 12], [136, "00000000000\0", 12]] as const) header.write(value, offset, width, "ascii");
  header.fill(0x20, 148, 156); header.write("0", 156, 1, "ascii"); header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

describe("archive validation", () => {
  it("inspects a many-entry archive without buffering its full listing", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-tar-"));
    const archive = join(dir, "many.tar");
    const headers = Array.from({ length: 12_000 }, (_, index) => tarHeader(`entry-${String(index).padStart(5, "0")}-${"x".repeat(70)}`));
    writeFileSync(archive, Buffer.concat([...headers, tarHeader("manifest.json"), Buffer.alloc(1024)]));
    expect(archiveKind(archive)).toEqual({ kind: "docker" });
  });

  it("rejects traversal even when an archive also has a valid marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-unsafe-tar-"));
    const archive = join(dir, "unsafe.tar");
    writeFileSync(archive, Buffer.concat([tarHeader("../escape"), tarHeader("manifest.json"), Buffer.alloc(1024)]));
    expect(archiveKind(archive)).toEqual({ error: "Use a safe OCI-layout or Docker-save tar archive." });
  });

  it("governs missing and invalid import result files", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-result-"));
    const result = join(dir, "result");
    expect(readImportResult(result)).toEqual({ error: "The image import did not record a result. Check free workspace storage and server.log, then retry." });
    writeFileSync(result, "\n");
    expect(readImportResult(result)).toEqual({ error: "The image import result is invalid. Check server.log, then retry." });
    writeFileSync(result, "not-a-code\n");
    expect(readImportResult(result)).toEqual({ error: "The image import result is invalid. Check server.log, then retry." });
    writeFileSync(result, "0\n");
    expect(readImportResult(result)).toEqual({ code: 0 });
  });

  it("accepts a regular absolute archive and rejects links", () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-kubernetes-"));
    const archive = join(dir, "image.tar");
    const link = join(dir, "link.tar");
    writeFileSync(archive, "archive");
    symlinkSync(archive, link);
    expect(validateArchive(archive, 100)).toBeNull();
    expect(validateArchive(link, 100)).toContain("regular archive");
    expect(validateArchive("relative.tar", 100)).toContain("absolute");
    expect(validateArchive(archive, 1)).toContain("Free workspace storage");
  });
});
