#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const spec = readFileSync(new URL("docs/specs/2026-09-12-nested-kubernetes-design.md", root), "utf8");
const data = JSON.parse(readFileSync(new URL("docs/specs/nested-kubernetes-v1-vectors.json", root), "utf8"));
const fail = (message) => { throw new Error(message); };
const canonical = (value) => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;

const capability = ({ requested, provider }) => !requested
  ? "ignore"
  : provider === "v1" ? "allow" : "reject:unsupported_provider";

function mapCovers(rows) {
  if (!Array.isArray(rows)) return false;
  const intervals = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || row.some((n) => !Number.isSafeInteger(n))) return false;
    const [inner, outer, count] = row;
    if (inner < 0 || outer < 0 || count <= 0 || inner + count - 1 > 0xffffffff || outer + count - 1 > 0xffffffff) return false;
    intervals.push([inner, inner + count - 1]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let next = 0;
  for (const [start, end] of intervals) {
    if (start !== next) return false;
    next = end + 1;
  }
  return next > 65535;
}

const statusLine = ({ state, error }) => `${canonical({
  error, kubeconfig: "/home/dockerd/.local/state/valet/kubernetes/kubeconfig.yaml", schema: 1, state,
})}\n`;

function lifecycle({ state, operation, identity }) {
  if (operation === "status") return { next: state, action: "report", exit: state === "stopped" ? 3 : state === "ready" ? 0 : 4 };
  if (identity === "foreign-live") return { next: "error", action: "refuse", exit: 21 };
  if (operation === "start") {
    if (state === "ready" && identity === "valid") return { next: "ready", action: "recheck", exit: 0 };
    if (state === "starting" && identity === "valid") return { next: "starting", action: "wait", exit: 0 };
    return { next: "starting", action: state === "stopped" ? "launch" : "cleanup-launch", exit: 0 };
  }
  if (operation === "stop") {
    if (state === "stopped") return { next: "stopped", action: "none", exit: 0 };
    if (state === "error" && identity === "dead") return { next: "stopped", action: "cleanup", exit: 0 };
    return { next: "stopping", action: "terminate", exit: 0 };
  }
  if (operation === "import" && state === "ready" && identity === "valid") return { next: "ready", action: "import", exit: 0 };
  return { next: state, action: "refuse", exit: 4 };
}

const digest = createHash("sha256").update(canonical(data.artifacts)).digest("hex");
if (digest !== data.lockDigest) fail(`artifact lock digest mismatch: ${digest}`);
const artifactKeys = new Set(data.artifacts.map((a) => `${a.name}:${a.arch}`));
for (const name of ["k3s", "kubectl", "rootlesskit"]) for (const arch of ["amd64", "arm64"]) {
  if (!artifactKeys.has(`${name}:${arch}`)) fail(`missing artifact ${name}:${arch}`);
}
for (const artifact of data.artifacts) {
  if (!artifact.url.startsWith("https://") || !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail(`invalid artifact ${artifact.name}:${artifact.arch}`);
}
for (const vector of data.capabilityVectors) if (capability(vector.input) !== vector.expected) fail(`capability vector ${vector.id}`);
for (const vector of data.mapVectors) if (mapCovers(vector.input) !== vector.expected) fail(`map vector ${vector.id}`);
for (const vector of data.lifecycleVectors) if (canonical(lifecycle(vector.input)) !== canonical(vector.expected)) fail(`lifecycle vector ${vector.id}`);
for (const vector of data.statusVectors) if (statusLine(vector.input) !== vector.expected) fail(`status vector ${vector.id}`);

const required = new Set([...spec.matchAll(/\[K(\d{2})\]/g)].map((match) => `K${match[1]}`));
const covered = new Set(["capabilityVectors", "mapVectors", "lifecycleVectors", "statusVectors", "contractVectors"]
  .flatMap((group) => data[group]).flatMap((vector) => vector.covers));
for (const id of required) if (!covered.has(id)) fail(`uncovered requirement ${id}`);
for (const id of covered) if (!required.has(id)) fail(`vector references unknown requirement ${id}`);
console.log(`nested-kubernetes spec vectors passed: ${required.size} requirements, ${data.artifacts.length} artifacts`);
