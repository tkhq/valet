#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHANGELOG_SCHEMA,
  backfillTags,
  generateCheckpoint,
  upsertCheckpoint,
} from "../src/changelog/generator.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const repo = resolve(option("--repo") ?? ".");
const manifestPath = resolve(option("--manifest") ?? "packages/api/src/changelog/manifest.json");
const initial = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { schema: CHANGELOG_SCHEMA, generatedAt: new Date(0).toISOString(), checkpoints: [] };
const pattern = option("--backfill-tags");
let manifest = pattern ? backfillTags({ repo, manifest: initial, pattern }) : initial;

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
      previousSha: option("--previous-sha") ?? manifest.checkpoints[0]?.releasedSha ?? null,
      releasedAt: option("--released-at"),
      releaseUrl: option("--release-url"),
    }),
  );
}
if (!pattern && !version) {
  throw new Error("Set --backfill-tags or a release version and SHA.");
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const metadataPath = option("--metadata");
if (metadataPath && version && releaseSha) {
  const resolvedSha = execFileSync("git", ["-C", repo, "rev-parse", `${releaseSha}^{commit}`], {
    encoding: "utf8",
  }).trim();
  writeFileSync(resolve(metadataPath), `${JSON.stringify({ version, sha: resolvedSha }, null, 2)}\n`);
}
console.log(`Wrote ${manifest.checkpoints.length} checkpoint(s) to ${manifestPath}.`);
