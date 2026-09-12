#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const specText = readFileSync(new URL("docs/specs/2026-09-12-nested-kubernetes-design.md", root), "utf8");
const source = JSON.parse(readFileSync(new URL("docs/specs/nested-kubernetes-v1-vectors.json", root), "utf8"));
const clone = (value) => structuredClone(value);
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const equal = (a, b) => canonical(a) === canonical(b);
const fail = (message) => { throw new Error(message); };

function expandCover(cover) {
  const one = /^K(\d{2,3})$/.exec(cover);
  if (one) return [one[0]];
  const range = /^K(\d{2,3})-K(\d{2,3})$/.exec(cover);
  if (!range || Number(range[1]) > Number(range[2])) fail(`invalid cover ${cover}`);
  return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => `K${String(Number(range[1]) + i).padStart(2, "0")}`);
}

function capability({ requested, provider }) {
  if (typeof requested !== "boolean" || (provider !== false && provider !== "v1")) fail("invalid capability input type");
  return !requested ? "ignore" : provider === "v1" ? "allow" : "reject:unsupported_provider";
}

function mapCovers(rows) {
  if (!Array.isArray(rows)) return false;
  const inner = [], outer = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3 || row.some((n) => !Number.isSafeInteger(n))) return false;
    const [inside, outside, count] = row;
    if (inside < 0 || outside < 0 || count <= 0) return false;
    const innerEnd = inside + count - 1, outerEnd = outside + count - 1;
    if (innerEnd >= 0xffffffff || outerEnd >= 0xffffffff) return false;
    outer.push([outside, outerEnd]);
    if (inside <= 65535 && innerEnd >= 0) inner.push([inside, Math.min(innerEnd, 65535)]);
  }
  outer.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < outer.length; i++) if (outer[i][0] <= outer[i - 1][1]) return false;
  inner.sort((a, b) => a[0] - b[0]);
  let next = 0;
  for (const [start, end] of inner) {
    if (start !== next) return false;
    next = end + 1;
  }
  return next === 65536;
}

function lifecycle({ state, command, identity, active, owner, operationId, actualOperationId, cancelRequested }) {
  if (command === "commit-start") return operationId === actualOperationId && owner === "valid" && !cancelRequested && identity === "valid"
    ? { action: "commit-ready", exit: 0, next: "ready" }
    : { action: "abandon-result", exit: 4, next: state };
  if (command === "recover") {
    if (owner === "valid") return { action: "wait-owner", exit: 24, next: state };
    if (active === "start") return { action: identity === "valid" ? "adopt-start" : "clean-restart", exit: 0, next: "starting" };
    if (active === "stop") return { action: "resume-stop", exit: 0, next: "stopping" };
    if (active === "import") return { action: identity === "valid" ? "release-import" : "release-import-error", exit: 0, next: identity === "valid" ? "ready" : "error" };
  }
  if (identity === "foreign") return { action: "refuse-foreign", exit: 21, next: "error" };
  if (command === "start") {
    if (state === "stopping") return { action: "report-stopping", exit: 4, next: state };
    if (state === "ready" && identity === "valid" && active === null) return { action: "recheck", exit: 0, next: state };
    if (state === "starting" && active === "start") return { action: identity === "valid" ? "join-start" : "recover-start", exit: 0, next: state };
    return { action: "claim-start", exit: 0, next: "starting" };
  }
  if (command === "stop") {
    if (state === "stopped") return { action: "none", exit: 0, next: state };
    if (active === "start") return { action: "cancel-start", exit: 0, next: "stopping" };
    if (active === "import") return { action: "cancel-import", exit: 0, next: "stopping" };
    return { action: "claim-stop", exit: 0, next: "stopping" };
  }
  if (command === "import") return state === "ready" && identity === "valid" && active === null
    ? { action: "claim-import", exit: 0, next: state }
    : { action: "report-nonready", exit: 4, next: state };
  fail(`invalid lifecycle command ${command}`);
}

function status({ persisted, identity, readiness, errorReason }) {
  const path = "/home/dockerd/.local/state/valet/kubernetes/kubeconfig.yaml";
  let state = persisted, error = persisted === "error" ? errorReason : null, exit = 4;
  if (persisted === "stopped") exit = 3;
  else if (persisted === "ready" && identity !== "valid") { state = "error"; error = "identity_invalid"; }
  else if (persisted === "ready" && readiness === "ready") exit = 0;
  else if (persisted === "ready") { state = "error"; error = "readiness_failed"; }
  return { exit, persistedAfter: persisted, stdout: `${canonical({ error, kubeconfig: path, schema: 1, state })}\n` };
}

function validate(spec, data) {
  if (data.schema !== 2 || data.status !== "proposed-unimplemented") fail("invalid vector header");
  const normative = spec.split("\n").filter((line) => /\b(?:MUST|MAY|SHOULD)(?: NOT)?\b/.test(line));
  for (const line of normative) {
    if ((line.match(/\b(?:MUST|MAY|SHOULD)(?: NOT)?\b/g) ?? []).length !== 1) fail(`normative line needs one clause: ${line}`);
    if ((line.match(/\[K\d{2,3}\]/g) ?? []).length !== 1) fail(`normative line needs one tag: ${line}`);
  }
  const tags = [...spec.matchAll(/\[K(\d{2,3})\]/g)].map((match) => `K${match[1]}`);
  if (new Set(tags).size !== tags.length) fail("duplicate requirement tag");
  const numbers = tags.map((tag) => Number(tag.slice(1))).sort((a, b) => a - b);
  if (numbers.some((number, i) => number !== i + 1)) fail("requirement tags have a gap");

  const digest = createHash("sha256").update(canonical(data.artifacts)).digest("hex");
  if (digest !== data.lockDigest) fail(`artifact lock digest mismatch: ${digest}`);
  const artifactIds = new Set();
  for (const artifact of data.artifacts) {
    const id = `${artifact.name}:${artifact.arch}`;
    if (artifactIds.has(id)) fail(`duplicate artifact ${id}`);
    artifactIds.add(id);
    if (!artifact.url.startsWith("https://") || !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail(`invalid artifact ${id}`);
  }
  for (const name of ["k3s", "kubectl"]) for (const arch of ["amd64", "arm64"]) if (!artifactIds.has(`${name}:${arch}`)) fail(`missing artifact ${name}:${arch}`);
  const kubeconfig = "/home/dockerd/.local/state/valet/kubernetes/kubeconfig.yaml";
  const dataDir = "/home/dockerd/.local/state/valet/kubernetes/data";
  const expectedArgv = ["/usr/local/bin/k3s", "server", "--rootless", "--prefer-bundled-bin", "--snapshotter=native", "--data-dir", dataDir, "--write-kubeconfig", kubeconfig, "--write-kubeconfig-mode", "600", "--disable", "traefik", "--disable", "servicelb", "--disable", "metrics-server"];
  if (!equal(data.k3sArgv, expectedArgv)) fail("invalid k3sArgv");
  const expectedEnv = { HOME: "/home/dockerd", USER: "dockerd", PATH: "/usr/local/bin:/usr/bin:/bin", XDG_RUNTIME_DIR: "/home/dockerd/.local/state/valet/kubernetes/run", XDG_CONFIG_HOME: "/home/dockerd/.local/state/valet/kubernetes/config", K3S_DATA_DIR: dataDir, K3S_ROOTLESS_CIDR: "10.41.0.0/16", K3S_ROOTLESS_MTU: "65520", K3S_ROOTLESS_ENABLE_IPV6: "false", K3S_ROOTLESS_PORT_DRIVER: "builtin", K3S_ROOTLESS_DISABLE_HOST_LOOPBACK: "true" };
  if (!equal(data.k3sEnv, expectedEnv)) fail("invalid k3sEnv");
  if (!equal(data.sandboxEnv, { KUBECONFIG: kubeconfig, VALET_SANDBOX_KUBERNETES: "1" })) fail("invalid sandboxEnv");
  if (!equal(data.errorReasons, ["startup_failed", "startup_timeout", "stop_failed", "import_owner_lost"])) fail("invalid errorReasons");
  if (!Number.isSafeInteger(data.minimumFreeBytes) || data.minimumFreeBytes <= 0) fail("invalid minimumFreeBytes");
  if (!equal(data.imageTools?.slirp4netns, { package: "slirp4netns=1.2.0-1", path: "/usr/bin/slirp4netns", provenance: "Debian bookworm main" })) fail("invalid slirp4netns contract");
  for (const vector of data.statusVectors) if (!vector.expected.stdout.includes(`\"kubeconfig\":\"${kubeconfig}\"`)) fail(`status kubeconfig drift ${vector.id}`);

  const groups = ["capabilityVectors", "mapVectors", "lifecycleVectors", "statusVectors", "acceptanceVectors"];
  const vectors = groups.flatMap((group) => {
    if (!Array.isArray(data[group]) || data[group].length === 0) fail(`missing vector group ${group}`);
    return data[group].map((vector) => ({ ...vector, group }));
  });
  const ids = new Set(), covered = new Set();
  for (const vector of vectors) {
    if (typeof vector.id !== "string" || ids.has(vector.id)) fail(`duplicate or missing vector id ${vector.id}`);
    ids.add(vector.id);
    if (!Array.isArray(vector.covers) || vector.covers.length === 0) fail(`vacuous covers for ${vector.id}`);
    for (const cover of vector.covers) for (const id of expandCover(cover)) covered.add(id);
    if (vector.group === "acceptanceVectors") {
      if (vector.mode !== "acceptance" || !/^A(?:[1-9]|1[0-5])$/.test(vector.step) || typeof vector.check !== "string" || vector.check.length < 8 || typeof vector.expected !== "string" || vector.expected.length < 8) fail(`vacuous acceptance vector ${vector.id}`);
    } else if (vector.mode !== "kernel" || vector.input === undefined || vector.expected === undefined) fail(`vacuous kernel vector ${vector.id}`);
  }
  for (const tag of tags) if (!covered.has(tag)) fail(`uncovered requirement ${tag}`);
  for (const tag of covered) if (!tags.includes(tag)) fail(`unknown covered requirement ${tag}`);

  for (const vector of data.capabilityVectors) if (!equal(capability(vector.input), vector.expected)) fail(`capability vector ${vector.id}`);
  for (const vector of data.mapVectors) if (!equal(mapCovers(vector.input), vector.expected)) fail(`map vector ${vector.id}`);
  for (const vector of data.lifecycleVectors) if (!equal(lifecycle(vector.input), vector.expected)) fail(`lifecycle vector ${vector.id}`);
  for (const vector of data.statusVectors) if (!equal(status(vector.input), vector.expected)) fail(`status vector ${vector.id}`);
  return { requirements: tags.length, vectors: vectors.length };
}

const result = validate(specText, source);
const mutations = [
  ["duplicate requirement", `${specText}\n[K01]`, clone(source)],
  ["second untagged MUST", specText.replace("[K01]", "It MUST also pass twice. [K01]"), clone(source)],
  ["missing cover", specText, (() => { const d = clone(source); d.acceptanceVectors[0].covers = ["K08-K17", "K22"]; return d; })()],
  ["unknown cover", specText, (() => { const d = clone(source); d.acceptanceVectors[0].covers.push("K999"); return d; })()],
  ["duplicate vector id", specText, (() => { const d = clone(source); d.mapVectors[0].id = d.capabilityVectors[0].id; return d; })()],
  ["vacuous acceptance", specText, (() => { const d = clone(source); d.acceptanceVectors[0].check = ""; return d; })()],
  ["string false", specText, (() => { const d = clone(source); d.capabilityVectors[0].input.provider = "false"; return d; })()],
];
for (const [name, spec, data] of mutations) {
  let rejected = false;
  try { validate(spec, data); } catch { rejected = true; }
  if (!rejected) fail(`mutation was accepted: ${name}`);
}
console.log(`nested-kubernetes vectors passed: ${result.requirements} requirements, ${result.vectors} vectors, ${mutations.length} mutation probes`);
