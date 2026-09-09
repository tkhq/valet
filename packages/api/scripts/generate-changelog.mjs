#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHANGELOG_SCHEMA,
  backfillTags,
  generateCheckpoint,
  generateUnreleasedCheckpoint,
  replaceUnreleasedCheckpoint,
  upsertCheckpoint,
} from "../src/changelog/generator.mjs";

function options(name) {
  return process.argv.flatMap((value, index) => (value === name ? [process.argv[index + 1]] : []));
}

function option(name) {
  return options(name)[0];
}

const repo = resolve(option("--repo") ?? ".");
const manifestPath = resolve(option("--manifest") ?? "packages/api/src/changelog/manifest.json");
const initial = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { schema: CHANGELOG_SCHEMA, generatedAt: new Date(0).toISOString(), checkpoints: [] };
const patterns = options("--backfill-tags");
let manifest = patterns.length ? backfillTags({ repo, manifest: initial, patterns }) : initial;

const version = option("--version");
const releaseSha = option("--release-sha");
if ((version && !releaseSha) || (!version && releaseSha)) {
  throw new Error("Set both --version and --release-sha.");
}
if (version && releaseSha) {
  manifest = upsertCheckpoint(
    manifest,
    generateCheckpoint({
      repo,
      version,
      releaseSha,
      previousSha:
        option("--previous-sha") ??
        manifest.checkpoints.find((checkpoint) => checkpoint.kind === "released")?.releasedSha ??
        null,
      releasedAt: option("--released-at"),
      releaseUrl: option("--release-url"),
    }),
  );
}
const unreleasedSha = option("--unreleased-sha");
if (unreleasedSha) {
  const previousSha =
    option("--previous-sha") ??
    manifest.checkpoints.find((checkpoint) => checkpoint.kind === "released")?.releasedSha ??
    null;
  manifest = replaceUnreleasedCheckpoint(
    manifest,
    generateUnreleasedCheckpoint({
      repo,
      buildSha: unreleasedSha,
      previousSha,
      builtAt: option("--built-at"),
      buildUrl: option("--build-url"),
    }),
  );
}
if (!patterns.length && !version && !unreleasedSha) {
  throw new Error("Set --backfill-tags, a release version and SHA, or --unreleased-sha.");
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const empty = manifest.checkpoints.filter((checkpoint) => checkpoint.entries.length === 0);
if (empty.length) {
  console.warn(`Warning: ${empty.length} changelog checkpoint(s) contain no user-facing changes.`);
}

const metadataPath = option("--metadata");
const artifactVersion = option("--artifact-version") ?? version;
const artifactSha = option("--artifact-sha") ?? releaseSha;
if (metadataPath && artifactVersion && artifactSha) {
  const resolvedSha = execFileSync("git", ["-C", repo, "rev-parse", `${artifactSha}^{commit}`], {
    encoding: "utf8",
  }).trim();
  writeFileSync(
    resolve(metadataPath),
    `${JSON.stringify({ version: artifactVersion, sha: resolvedSha }, null, 2)}\n`,
  );
}
console.log(`Wrote ${manifest.checkpoints.length} checkpoint(s) to ${manifestPath}.`);
