# Image Pipeline Health, PR 1 (stop the bleeding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock sessions on the `tkhq/sdk` image today and make the delete-and-recreate race impossible, without any schema change.

**Architecture:** Ten independent fixes across three packages. The scheduler's GitHub reader learns the blobs API for files over 1 MB. The kubernetes provider stops hardcoding tini, waits for its own cleanup to finish, waits for orphaned same-name resources before creating, treats the controller's ownership condition as retry-shaped, and reports the crashed container's last words. The engine attachment backs off after a terminal startup error while still failing callers fast, and counts terminal failures by kind. The stock Dockerfile gains the contract label that PR 2 will read.

**Tech Stack:** TypeScript, vitest, `@kubernetes/client-node` types, Hono fixture server, OpenTelemetry metrics API, Dockerfile.

**Spec:** `docs/plans/2026-10-26-image-pipeline-health-design.md`, section 14 item 1, drawing on sections 6.3 (blobs fallback), 8 (hardening), 9 (`startup_failed`), and 5.2 (label).

## Global Constraints

- No schema change in this PR (spec 14.1).
- Metric cardinality stays bounded: no source names, session ids, or free text as labels (spec 3, 9).
- `packages/sandbox-kubernetes` gets no OpenTelemetry dependency; counters live in `packages/engine/src/metrics.ts` (spec 8.7).
- The label is exactly `LABEL io.valet.sandbox.contract="3"` (spec 5.2).
- Backoff window is `min(120_000, 15_000 * 2 ** (attempts - 1))` milliseconds (spec 8.1).
- Cleanup and orphan waits are bounded at 30 seconds (spec 8.2, 8.3).
- Terminal startup failure kinds are exactly `crash_loop`, `image_pull`, `unschedulable`, `pod_failed`, `ownership`, `other` (spec 8.7).
- Every commit is signed. Branch: `conner/image-pipeline-health-pr1` off `origin/dev-v2`.
- Run tests per package with `pnpm --filter <pkg> test -- <file>`; package names are `@valet/api`, `@valet/engine`, `@valet/sandbox-kubernetes`.

## Deliberate refinements of the spec

Two places where implementing revealed a better shape; the spec's intent is kept.

1. Spec 8.4 says the ownership timeout throws a plain `Error` so the CR is kept. A plain `Error` neither fast-fails waiters nor arms the new backoff, so the attachment would recreate immediately and loop on 60-second readiness timeouts. Instead, `waitReady` throws a `SandboxStartupError` with `kind: "ownership"`, and the failed-create cleanup in `create()` skips CR deletion for that kind. Result: CR kept (as the spec wants), waiters fail fast, backoff arms, and the counter sees `ownership` (spec 8.7) with no new error class.
2. Spec 8.5 says read the previous container log for the last line. Kubernetes already does this when the container's `terminationMessagePolicy` is `FallbackToLogsOnError`: the kubelet copies the tail of the log into `lastState.terminated.message`. Setting that policy on the sandbox container and reading `lastState.terminated` needs no log client and no timeout.

## Review Focus

Inputs the spec implies but no task's tests exercise, most likely to bite first. Each line's test is added to the owning task below.

1. A GitHub contents response with `encoding: "none"` but no `sha` field: the reader must throw the existing "not a base64 file" error, never call the blobs API with `undefined`. Owner: Task 1.
2. `replace()` called while inside the backoff window: must bypass the window and provision. Owner: Task 8.
3. `destroy()` called while inside the backoff window: must not leave a stale memo that blocks a later attachment reuse. Owner: Task 8.
4. The failed-create cleanup when `pvcApi` is not configured (docker-backed or older deployments): must still wait on the pod and return, not throw. Owner: Task 9.
5. Pre-create orphan wait when the CR already exists (adopt path): must not wait at all, or every resume would stall 30 seconds. Owner: Task 9.

---

### Task 1: Blobs fallback in the GitHub file reader

**Files:**
- Modify: `packages/api/src/test-helpers/github-fixture.ts` (handler type near line 75, defaults near line 167, routes near line 387)
- Modify: `packages/api/src/bakes/source-service.ts:378-412` (`readGithubFile`)
- Test: `packages/api/src/bakes/source-service.test.ts`

**Interfaces:**
- Consumes: `fetchGithubJson(deps, token, path, signal)`, `GitHubApiError(status, path, detail)`, `isRecord`.
- Produces: `readGithubFile` unchanged signature, now returning the decoded body for files GitHub serves with `encoding: "none"`.

- [ ] **Step 1: Add a `getBlob` handler to the fixture**

In `packages/api/src/test-helpers/github-fixture.ts`, next to `getContents` in the handler interface:

```ts
  /** `GET /repos/:owner/:repo/git/blobs/:sha` — what the reader falls back
   * to when the contents endpoint answers `encoding: "none"` (files over
   * 1 MB). */
  getBlob?: (owner: string, repo: string, sha: string) => GithubFixtureResponse;
```

In the defaults object:

```ts
  getBlob: () => ({ status: 404, body: { message: "Not Found" } }),
```

Next to the `git/trees` route:

```ts
  app.get("/repos/:owner/:repo/git/blobs/:sha", (c) => {
    const owner = c.req.param("owner");
    const repo = c.req.param("repo");
    const sha = c.req.param("sha");
    record(c, { owner, repo, sha });
    const { status, body } = handlers.getBlob(owner, repo, sha);
    return c.json(body as object, status ?? 200);
  });
```

- [ ] **Step 2: Write the failing tests**

In `packages/api/src/bakes/source-service.test.ts`, inside the `describe` that owns `contentsFor` and `startGithubFixture` (the one with `lockfilePresent`), add a module-level flag next to `lockfilePresent`:

```ts
  // When true, serve pnpm-lock.yaml the way GitHub serves files over 1 MB:
  // `encoding: "none"`, empty content, a blob sha to follow.
  let lockfileOversized = false;
  let oversizedSha = "blob-sha-1";
  let oversizedHasSha = true;
```

Extend `contentsFor`:

```ts
    if (lockfileOversized && path === "pnpm-lock.yaml") {
      return { body: { type: "file", encoding: "none", content: "", size: 1_985_703, ...(oversizedHasSha ? { sha: oversizedSha } : {}) } };
    }
```

Extend the `startGithubFixture` call in `beforeEach`:

```ts
      getBlob: (_owner, _repo, sha) =>
        sha === oversizedSha
          ? { body: { sha, encoding: "base64", content: b64("lockfileVersion: '9.0'\n") } }
          : { status: 404, body: { message: "Not Found" } },
```

Reset the flags in `beforeEach` alongside `lockfilePresent = false`:

```ts
    lockfileOversized = false;
    oversizedHasSha = true;
```

Add the tests after `pushCurrentBake`:

```ts
  describe("readGithubFile oversized lockfiles", () => {
    it("falls back to the blobs API when the contents endpoint answers encoding none, and the scheduler bakes", async () => {
      lockfileOversized = true;
      const srcId = await seedRepoSource(db, { repoFullName: "acme/big-lock" });
      await service.runSchedulerPass();
      expect(builder.buildIds).toHaveLength(1);
      const paths = fixture.calls.map((c) => c.path);
      expect(paths.some((p) => p.includes("/git/blobs/blob-sha-1"))).toBe(true);
    });

    it("still rejects a non-base64 contents response that is not encoding none", async () => {
      fixture.close();
      fixture = startGithubFixture({
        getCommit: () => ({ body: { sha: currentSha } }),
        getContents: (_o, _r, path) =>
          path === "pnpm-lock.yaml"
            ? { body: { type: "file", encoding: "utf-7", content: "???", sha: "x" } }
            : contentsFor(path),
      });
      service = makeService();
      await seedRepoSource(db, { repoFullName: "acme/odd-encoding" });
      await service.runSchedulerPass();
      expect(builder.buildIds).toHaveLength(0);
    });

    it("throws the not-a-base64-file error when encoding none arrives without a sha (never calls blobs with undefined)", async () => {
      lockfileOversized = true;
      oversizedHasSha = false;
      await seedRepoSource(db, { repoFullName: "acme/no-sha" });
      await service.runSchedulerPass();
      expect(builder.buildIds).toHaveLength(0);
      const paths = fixture.calls.map((c) => c.path);
      expect(paths.some((p) => p.includes("/git/blobs/"))).toBe(false);
    });
  });
```

`fixture.calls` is `GithubFixtureCall[]` (`github-fixture.ts:19`), each with `method`, `path`, `params`, `query`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @valet/api test -- src/bakes/source-service.test.ts -t "oversized lockfiles"`
Expected: the first test FAILS (`buildIds` length 0: the scheduler logs `source ... failed` with "response was not a base64 file"). The other two may pass already; that is fine, they pin behavior.

- [ ] **Step 4: Implement the fallback**

Replace the validation block in `readGithubFile` (`source-service.ts:395-401`) with:

```ts
  if (!isRecord(payload) || (payload.type !== undefined && payload.type !== "file")) {
    throw new GitHubApiError(200, apiPath, "response was not a base64 file");
  }
  let content = payload.content;
  let encoding = payload.encoding;
  if (encoding === "none" && typeof payload.sha === "string" && payload.sha.length > 0) {
    // Files over 1 MB: the contents endpoint omits the body. The blobs
    // endpoint serves the same object base64-encoded.
    const blobPath = `/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(payload.sha)}`;
    const blob = await fetchGithubJson(deps, token, blobPath, signal);
    if (!isRecord(blob) || typeof blob.content !== "string" || blob.encoding !== "base64") {
      throw new GitHubApiError(200, blobPath, "blob response was not base64");
    }
    content = blob.content;
    encoding = blob.encoding;
  }
  if (typeof content !== "string" || encoding !== "base64") {
    throw new GitHubApiError(200, apiPath, "response was not a base64 file");
  }
  const compact = content.replace(/\s/g, "");
```

Leave the canonical-base64 checks below unchanged; they now operate on `compact` from either source.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @valet/api test -- src/bakes/source-service.test.ts`
Expected: PASS, including the whole file (the fixture change must not break existing contents tests).

- [ ] **Step 6: Commit**

```bash
git add packages/api/src/test-helpers/github-fixture.ts packages/api/src/bakes/source-service.ts packages/api/src/bakes/source-service.test.ts
git commit -S -m "fix(bakes): read lockfiles over 1 MB through the GitHub blobs API

The contents endpoint answers encoding none with an empty body for files
over 1 MB, which readGithubFile rejected. tkhq/sdk's pnpm-lock.yaml is
1.98 MB, so its source failed every scheduler pass and never rebaked."
```

---

### Task 2: Guarded tini in the browser-enabled headless command

**Files:**
- Modify: `packages/sandbox-kubernetes/src/manifest.ts:519`
- Test: `packages/sandbox-kubernetes/test/manifest.test.ts`

**Interfaces:**
- Produces: the browser-enabled, non-companion, non-full container command becomes the guarded `sh -c` form identical to the docker path at `manifest.ts:586`.

- [ ] **Step 1: Write the failing test**

In `packages/sandbox-kubernetes/test/manifest.test.ts`, inside the top-level `describe` that owns `baseConfig`, add:

```ts
  describe("browser-enabled headless command", () => {
    it("guards tini so an image without /usr/bin/tini still starts", () => {
      const manifest = buildSandboxManifest(baseConfig, "sess-browser", {
        profile: "headless",
        sessionId: "session-browser",
        browser: { enabled: true, viewer: true },
      });
      const container = manifest.spec.podTemplate.spec.containers.find((c) => c.name === SANDBOX_CONTAINER_NAME);
      // The first four entries are the valet-home-start wrapper; slice them
      // off the way the scratch tests do.
      expect(container?.command?.slice(4)).toEqual([
        "sh",
        "-c",
        "[ -f /start-headless.sh ] && { [ -x /usr/bin/tini ] && exec /usr/bin/tini -g -- /bin/bash /start-headless.sh || exec /bin/bash /start-headless.sh; } || exec tail -f /dev/null",
      ]);
    });
  });
```

`baseConfig` has no `browserSeccompProfile`; that is fine, `manifest.ts:492` defaults it to `valet/browser.json`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/manifest.test.ts -t "guards tini"`
Expected: FAIL, received `["/usr/bin/tini", "-g", "--", "/bin/bash", "/start-headless.sh"]`.

- [ ] **Step 3: Implement**

At `manifest.ts:519` replace:

```ts
    if (!companion && !isFullProfile) container.command = ["/usr/bin/tini", "-g", "--", "/bin/bash", "/start-headless.sh"];
```

with:

```ts
    if (!companion && !isFullProfile) {
      container.command = [
        "sh",
        "-c",
        "[ -f /start-headless.sh ] && { [ -x /usr/bin/tini ] && exec /usr/bin/tini -g -- /bin/bash /start-headless.sh || exec /bin/bash /start-headless.sh; } || exec tail -f /dev/null",
      ];
    }
```

The companion container command at line 498 stays as is; it runs on the stock browser image, which has tini.

- [ ] **Step 4: Run the package tests**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/manifest.test.ts test/browser-runtime-state.test.ts`
Expected: PASS. If a browser test asserted the old hardcoded array for the sandbox container (not the companion), update it to the guarded form.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-kubernetes/src/manifest.ts packages/sandbox-kubernetes/test/manifest.test.ts
git commit -S -m "fix(sandbox-kubernetes): guard tini in the browser-enabled headless command

Images baked before tini entered the base crashed with exec: /usr/bin/tini
not found. Use the same guarded form the docker path already uses."
```

---

### Task 3: Contract label on the stock sandbox image

**Files:**
- Modify: `docker/Dockerfile.sandbox-k8s` (final stage begins at line 137, `FROM office-runtime`)

**Interfaces:**
- Produces: the OCI label `io.valet.sandbox.contract=3` on every image built from this Dockerfile and, through `FROM` inheritance, on every base and repo bake built from it. PR 2 reads it.

- [ ] **Step 1: Add the label**

Immediately after line 137 (`FROM office-runtime`), add:

```dockerfile
# Image runtime contract (docs/plans/2026-10-26-image-pipeline-health-design.md,
# section 5). Bump together with SANDBOX_IMAGE_CONTRACT in
# packages/sandbox-kubernetes/src/manifest.ts whenever the pod spec starts
# depending on something new in this image. Inherited by every bake that
# FROMs this image.
LABEL io.valet.sandbox.contract="3"
```

- [ ] **Step 2: Verify the label is on the final stage only**

Run: `grep -n '^FROM\|^LABEL' docker/Dockerfile.sandbox-k8s`
Expected: exactly one `LABEL io.valet.sandbox.contract="3"` line, and it appears after `137:FROM office-runtime`.

- [ ] **Step 3: Verify the Dockerfile still parses (no daemon needed)**

Run: `docker buildx build --check -f docker/Dockerfile.sandbox-k8s . 2>&1 | tail -5`
Expected: no errors. If `buildx --check` is unavailable locally, skip; CI's docker-publish workflow builds this file.

- [ ] **Step 4: Commit**

```bash
git add docker/Dockerfile.sandbox-k8s
git commit -S -m "build(sandbox): label the stock image with its runtime contract"
```

---

### Task 4: Startup failure kind and counter in the engine

**Files:**
- Modify: `packages/engine/src/errors.ts:209-220` (`SandboxStartupError`)
- Modify: `packages/engine/src/metrics.ts` (Instruments interface near line 60, instrument creation near line 151, record functions near line 377)
- Modify: `packages/engine/src/sandbox/attachment.ts:1276-1279` (`recordStartFailure`)
- Test: `packages/engine/test/metrics.test.ts`, `packages/engine/test/sandbox-attachment.test.ts`

**Interfaces:**
- Produces: `type SandboxStartupKind = "crash_loop" | "image_pull" | "unschedulable" | "pod_failed" | "ownership" | "other"`, exported from `packages/engine/src/errors.ts` and re-exported from `packages/engine/src/index.ts`; `SandboxStartupError.kind: SandboxStartupKind` (defaults to `"other"`); `recordSandboxStartupFailure(kind: SandboxStartupKind): void` exported from `metrics.ts`. Task 5 constructs errors with a kind; Task 8 reads `kind`.

- [ ] **Step 1: Write the failing metrics test**

In `packages/engine/test/metrics.test.ts`, add `recordSandboxStartupFailure` to the import list from `../src/metrics.js`, and add:

```ts
  it("counts terminal sandbox startup failures by bounded kind", () => {
    recordSandboxStartupFailure("crash_loop");
    recordSandboxStartupFailure("ownership");
    expect(metricState.points).toContainEqual({ name: "valet.sandbox.startup_failed", value: 1, attributes: { kind: "crash_loop" } });
    expect(metricState.points).toContainEqual({ name: "valet.sandbox.startup_failed", value: 1, attributes: { kind: "ownership" } });
    expect(metricState.descriptions.get("valet.sandbox.startup_failed")).toMatch(/terminal/i);
  });
```

- [ ] **Step 2: Write the failing attachment test**

In `packages/engine/test/sandbox-attachment.test.ts`, add `vi.mock` is already available via the `vi` import. Add near the top, after the imports:

```ts
const startupFailures: string[] = [];
vi.mock("../src/metrics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/metrics.js")>();
  return { ...actual, recordSandboxStartupFailure: (kind: string) => { startupFailures.push(kind); } };
});
```

and a test:

```ts
  it("records a terminal startup failure by kind when create() rejects with SandboxStartupError", async () => {
    startupFailures.length = 0;
    const provider = new FakeProvider();
    const attachment = new SandboxAttachment(provider, {});
    const d = provider.nextDeferred();
    const ready = attachment.ensureReady({ timeoutMs: 1000 });
    d.reject(new SandboxStartupError("sess-1", "image pull failed (ImagePullBackOff): x", "image_pull"));
    await expect(ready).rejects.toBeInstanceOf(SandboxStartupError);
    expect(startupFailures).toEqual(["image_pull"]);
  });
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `pnpm --filter @valet/engine test -- test/metrics.test.ts test/sandbox-attachment.test.ts -t "startup failure"`
Expected: FAIL. The metrics test cannot import `recordSandboxStartupFailure`; the attachment test fails on the three-argument constructor type.

- [ ] **Step 4: Implement the error kind**

In `packages/engine/src/errors.ts`, above `SandboxStartupError`:

```ts
/** Bounded classification of a terminal startup failure, for the
 * `valet.sandbox.startup_failed` counter. Free text stays in `reason`. */
export type SandboxStartupKind = "crash_loop" | "image_pull" | "unschedulable" | "pod_failed" | "ownership" | "other";
```

Change the class:

```ts
export class SandboxStartupError extends Error {
  readonly code = "sandbox_startup_failed";
  constructor(
    public readonly sandboxId: string,
    public readonly reason: string,
    public readonly kind: SandboxStartupKind = "other",
  ) {
    super(`sandbox failed to start: ${reason}`);
    this.name = "SandboxStartupError";
  }
}
```

Export `SandboxStartupKind` from `packages/engine/src/index.ts` next to `SandboxStartupError`.

- [ ] **Step 5: Implement the counter**

In `packages/engine/src/metrics.ts`:

Instruments interface, after `sandboxFlagged: Counter;`:

```ts
  sandboxStartupFailed: Counter;
```

Instrument creation, after the `sandboxFlagged` block:

```ts
    sandboxStartupFailed: meter.createCounter("valet.sandbox.startup_failed", {
      description:
        "Terminal sandbox startup failures by bounded kind (crash_loop/image_pull/unschedulable/pod_failed/ownership/other). A failure here reached the attachment as a SandboxStartupError; retries are counted again.",
    }),
```

Record function, after `recordSandboxWorkspaceGrow`:

```ts
import type { SandboxStartupKind } from "./errors.js";

/** A terminal startup failure. Called once per SandboxStartupError the
 * attachment observes, so a crash-loop that is retried three times counts
 * three. */
export function recordSandboxStartupFailure(kind: SandboxStartupKind): void {
  inst().sandboxStartupFailed.add(1, { kind });
}
```

Put the import with the other imports at the top of the file.

- [ ] **Step 6: Record from the attachment**

In `packages/engine/src/sandbox/attachment.ts`, import `recordSandboxStartupFailure` from `../metrics.js` (check how the file already imports metrics; follow that path), and change `recordStartFailure`:

```ts
  private recordStartFailure(err: unknown, epoch: number, phase: "create" | "resume"): void {
    this.lastStartError = formatSandboxErrorCause(err);
    if (err instanceof SandboxStartupError) recordSandboxStartupFailure(err.kind);
    console.error("SandboxAttachment: sandbox start failed", { phase, epoch, ...formatSandboxErrorLog(err) });
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @valet/engine test -- test/metrics.test.ts test/sandbox-attachment.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/errors.ts packages/engine/src/index.ts packages/engine/src/metrics.ts packages/engine/src/sandbox/attachment.ts packages/engine/test/metrics.test.ts packages/engine/test/sandbox-attachment.test.ts
git commit -S -m "feat(engine): count terminal sandbox startup failures by kind"
```

---

### Task 5: Provider classifies the kind of every startup failure

**Files:**
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts` (next to `classifyPodFailure`, line 1414)
- Modify: `packages/sandbox-kubernetes/src/provider.ts:1606` (`waitReady` throw) and `pendingTerminalError` (line 1659)
- Test: `packages/sandbox-kubernetes/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `SandboxStartupError(sandboxId, reason, kind)` from Task 4.
- Produces: `export function startupKindOf(reason: string): SandboxStartupKind` in `lifecycle.ts`, exported from the package index.

- [ ] **Step 1: Write the failing test**

In `packages/sandbox-kubernetes/test/lifecycle.test.ts`, import `startupKindOf` from `../src/index.js` and add:

```ts
describe("startupKindOf", () => {
  it.each([
    ["container crash-looping (CrashLoopBackOff)", "crash_loop"],
    ["container crash-looping (CrashLoopBackOff): exit 127: valet-home-start: exec: /usr/bin/tini: not found", "crash_loop"],
    ["image pull failed (ImagePullBackOff): ghcr.io/x/y:z", "image_pull"],
    ["pod failed: Error seen: PVC \"workspace-a\" is owned by Sandbox/a (UID: 1), not by sandbox \"a\"", "ownership"],
    ["pod failed: pod entered phase Failed", "pod_failed"],
    ["pod unschedulable: 0/3 nodes are available", "unschedulable"],
    ["something else entirely", "other"],
  ])("maps %j to %s", (reason, expected) => {
    expect(startupKindOf(reason)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/lifecycle.test.ts -t startupKindOf`
Expected: FAIL, `startupKindOf` is not exported.

- [ ] **Step 3: Implement**

In `lifecycle.ts`, directly below `classifyPodFailure`:

```ts
import type { SandboxStartupKind } from "@valet/engine";

/** Bounded kind for the `valet.sandbox.startup_failed` counter, derived
 * from the reason strings this module and the provider produce. Matched on
 * stable prefixes so detail appended after a colon does not change the
 * answer. */
export function startupKindOf(reason: string): SandboxStartupKind {
  if (reason.startsWith("container crash-looping")) return "crash_loop";
  if (reason.startsWith("image pull failed")) return "image_pull";
  if (reason.includes("is owned by Sandbox/")) return "ownership";
  if (reason.startsWith("pod failed")) return "pod_failed";
  if (reason.startsWith("pod unschedulable") || reason.includes("Unschedulable")) return "unschedulable";
  return "other";
}
```

Confirm the exact prefix the pending-diagnosis path uses by reading `podPendingDiagnosis` in `provider.ts`; if its message does not start with `pod unschedulable`, add that prefix to the `unschedulable` branch rather than changing the message.

Export `startupKindOf` from `packages/sandbox-kubernetes/src/index.ts`.

In `provider.ts:1606`:

```ts
          throw new SandboxStartupError(name, status.error ?? "unknown", startupKindOf(status.error ?? ""));
```

`pendingTerminalError` (`provider.ts:1659`) constructs `PendingTerminalStartupError`, a subclass declared at `provider.ts:227` (`class PendingTerminalStartupError extends SandboxStartupError {}`), which inherits the three-argument constructor from Task 4. At that one `new PendingTerminalStartupError(name, <message>)` call, pass `"unschedulable"` as the third argument.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/lifecycle.test.ts test/provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-kubernetes/src/lifecycle.ts packages/sandbox-kubernetes/src/index.ts packages/sandbox-kubernetes/src/provider.ts packages/sandbox-kubernetes/test/lifecycle.test.ts
git commit -S -m "feat(sandbox-kubernetes): classify terminal startup failures by kind"
```

---

### Task 6: Crash-loop errors carry the container's last words

**Files:**
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts:1125-1130` (`PodContainerStatus`), `1225-1232` (status builder), `1425-1427` (`classifyPodFailure` crash-loop branch)
- Modify: `packages/sandbox-kubernetes/src/manifest.ts` (sandbox container definition; find where `name: SANDBOX_CONTAINER_NAME` is set on the container object)
- Test: `packages/sandbox-kubernetes/test/lifecycle.test.ts`, `packages/sandbox-kubernetes/test/manifest.test.ts`

**Interfaces:**
- Produces: `PodContainerStatus.lastTerminated?: { exitCode?: number; reason?: string; message?: string }`; crash-loop reason string format `container crash-looping (CrashLoopBackOff): exit <code>: <message or reason>`. Task 5's `startupKindOf` already tolerates the suffix.

- [ ] **Step 1: Write the failing tests**

In `lifecycle.test.ts`, in `describe("classifyPodFailure (pure)")`:

```ts
  it("appends the last termination exit code and message to a crash loop", () => {
    const pod: PodStatusInfo = {
      phase: "Running",
      containerStatuses: [{
        name: "sandbox", image: "img", waitingReason: "CrashLoopBackOff",
        lastTerminated: { exitCode: 127, reason: "Error", message: "valet-home-start: 14: exec: /usr/bin/tini: not found\n" },
      }],
    };
    expect(classifyPodFailure(pod)).toBe(
      "container crash-looping (CrashLoopBackOff): exit 127: valet-home-start: 14: exec: /usr/bin/tini: not found",
    );
  });

  it("falls back to the termination reason when the message is empty", () => {
    const pod: PodStatusInfo = {
      phase: "Running",
      containerStatuses: [{ name: "sandbox", waitingReason: "CrashLoopBackOff", lastTerminated: { exitCode: 1, reason: "Error" } }],
    };
    expect(classifyPodFailure(pod)).toBe("container crash-looping (CrashLoopBackOff): exit 1: Error");
  });

  it("keeps the bare crash-loop text when there is no termination record", () => {
    const pod: PodStatusInfo = { phase: "Running", containerStatuses: [{ name: "sandbox", waitingReason: "CrashLoopBackOff" }] };
    expect(classifyPodFailure(pod)).toBe("container crash-looping (CrashLoopBackOff)");
  });
```

In the `podStatusApiAdapter` test block of the same file, add:

```ts
  it("carries lastState.terminated through the pod adapter", async () => {
    const adapter = podStatusApiAdapter({
      readNamespacedPod: async (): Promise<V1Pod> => ({
        spec: { containers: [{ name: "sandbox", image: "sandbox:v1" }] },
        status: {
          phase: "Running",
          containerStatuses: [{ name: "sandbox", image: "sandbox:v1", imageID: "", ready: false, restartCount: 3,
            state: { waiting: { reason: "CrashLoopBackOff" } },
            lastState: { terminated: { exitCode: 127, reason: "Error", message: "boom\n" } } }],
        },
      }),
    });
    const pod = await adapter.getPodStatus("ns", "pod");
    expect(pod?.containerStatuses?.[0]?.lastTerminated).toEqual({ exitCode: 127, reason: "Error", message: "boom\n" });
  });
```

In `manifest.test.ts`:

```ts
  it("asks the kubelet to copy the log tail into the termination message", () => {
    const manifest = buildSandboxManifest(baseConfig, "sess-tm", {});
    const container = manifest.spec.podTemplate.spec.containers.find((c) => c.name === SANDBOX_CONTAINER_NAME);
    expect(container?.terminationMessagePolicy).toBe("FallbackToLogsOnError");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/lifecycle.test.ts test/manifest.test.ts -t "termination|crash loop|last termination"`
Expected: FAIL on the type (`lastTerminated` unknown) and on the policy being undefined.

- [ ] **Step 3: Implement**

`PodContainerStatus`:

```ts
export interface PodContainerStatus {
  name: string;
  image?: string;
  waitingReason?: string;
  waitingMessage?: string;
  /** `status.lastState.terminated`, present after at least one crash. With
   * `terminationMessagePolicy: FallbackToLogsOnError` the kubelet fills
   * `message` with the log tail, which is the line a human needs. */
  lastTerminated?: { exitCode?: number; reason?: string; message?: string };
}
```

Status builder (`lifecycle.ts:1225-1232`), inside the `.map((cs) => ({ ... }))`:

```ts
        waitingMessage: cs.state?.waiting?.message,
        ...(cs.lastState?.terminated
          ? { lastTerminated: {
              exitCode: cs.lastState.terminated.exitCode,
              reason: cs.lastState.terminated.reason,
              message: cs.lastState.terminated.message,
            } }
          : {}),
```

`classifyPodFailure` crash-loop branch:

```ts
  for (const cs of pod.containerStatuses ?? []) {
    if (cs.waitingReason === "CrashLoopBackOff") {
      const base = "container crash-looping (CrashLoopBackOff)";
      const last = cs.lastTerminated;
      if (!last) return base;
      const detail = (last.message?.trim().split("\n").filter(Boolean).pop() ?? last.reason ?? "").trim();
      const exit = last.exitCode !== undefined ? `exit ${last.exitCode}` : "";
      const parts = [exit, detail].filter(Boolean).join(": ");
      return parts ? `${base}: ${parts}` : base;
    }
  }
```

In `packages/sandbox-kubernetes/src/types.ts:174`, `SandboxContainer` is a local interface; add after `workingDir?: string;`:

```ts
  /** `FallbackToLogsOnError` makes the kubelet copy the log tail into
   * `lastState.terminated.message` when a container exits non-zero with no
   * termination file, which is how crash-loop errors learn the last line. */
  terminationMessagePolicy?: "File" | "FallbackToLogsOnError";
```

In `manifest.ts`, on the sandbox container object literal at line 454 (`name: SANDBOX_CONTAINER_NAME`), add:

```ts
    terminationMessagePolicy: "FallbackToLogsOnError",
```

- [ ] **Step 4: Run the package tests**

Run: `pnpm --filter @valet/sandbox-kubernetes test`
Expected: PASS. Manifest fingerprint tests must still pass; the policy is not part of any fingerprint input. If a fingerprint test fails, the policy was added inside a fingerprinted sub-object; move it to the container top level.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-kubernetes/src/lifecycle.ts packages/sandbox-kubernetes/src/manifest.ts packages/sandbox-kubernetes/test/lifecycle.test.ts packages/sandbox-kubernetes/test/manifest.test.ts
git commit -S -m "feat(sandbox-kubernetes): include the crashed container's last line in crash-loop errors"
```

---

### Task 7: Ownership condition is retry-shaped and the readiness timeout carries detail

**Files:**
- Modify: `packages/sandbox-kubernetes/src/lifecycle.ts:1430-1433` (`classifyPodFailure` pod-failed branch)
- Modify: `packages/sandbox-kubernetes/src/provider.ts:1555-1625` (`waitReady`)
- Test: `packages/sandbox-kubernetes/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `startupKindOf` (Task 5), `SandboxStartupError(name, reason, kind)` (Task 4).
- Produces: `export const OWNERSHIP_CONDITION_PATTERN = /is owned by Sandbox\//` in `lifecycle.ts`; `waitReady` throws `SandboxStartupError(name, <timeout message>, "ownership")` when it times out with that detail last seen. Task 9 reads `err.kind === "ownership"` to skip cleanup.

- [ ] **Step 1: Write the failing tests**

In `lifecycle.test.ts`, `describe("classifyPodFailure (pure)")`:

```ts
  it("treats the controller's ownership condition as still provisioning, not terminal", () => {
    const pod: PodStatusInfo = { phase: "Pending", containerStatuses: [] };
    const ready: SandboxCondition = {
      type: "Ready", status: "False", reason: "PodFailed",
      message: 'Error seen: PVC "workspace-a" is owned by Sandbox/a (UID: 8f3311cf), not by sandbox "a"',
    };
    expect(classifyPodFailure(pod, ready)).toBeNull();
  });

  it("still reports other PodFailed conditions as terminal", () => {
    const pod: PodStatusInfo = { phase: "Pending", containerStatuses: [] };
    const ready: SandboxCondition = { type: "Ready", status: "False", reason: "PodFailed", message: "node lost" };
    expect(classifyPodFailure(pod, ready)).toBe("pod failed: node lost");
  });
```

In `provider.test.ts`, near the readiness timeout test at line 1148 ("times out with the persistent Kubernetes read failure and corrective action"), read that test's harness and add a sibling that drives `create()` with a fake objects API whose CR carries the ownership `Ready=False` condition and a pods API that never reports Ready. Use `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync(61_000)` to pass `READY_TIMEOUT_MS`:

```ts
  it("times out on a persistent ownership condition as a retry-shaped startup error that keeps the CR", async () => {
    vi.useFakeTimers();
    try {
      const objectsApi = new OwnershipConditionObjectsApi(); // defined below
      const provider = makeProvider(new FakeSecretsApi(), objectsApi);
      const pending = provider.create({ workspace: "/w", sessionId: "s-own" });
      const outcome = pending.then(() => "resolved", (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(61_000);
      const err = await outcome;
      expect(err).toBeInstanceOf(SandboxStartupError);
      expect((err as SandboxStartupError).kind).toBe("ownership");
      expect((err as SandboxStartupError).message).toContain("is owned by Sandbox/");
      expect(objectsApi.deleteCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
```

Define the fake in the test file next to `ResourceAdoptingObjectsApi`:

```ts
/** Fresh CR whose Ready condition is the controller's ownership refusal and
 * never clears: the shape of the 2026-10-26 race. */
class OwnershipConditionObjectsApi extends FakeObjectsApi {
  deleteCalls = 0;
  private cr: SandboxCRRead | null = null;
  override async createNamespacedCustomObject(params: CreateSandboxParams): Promise<unknown> {
    this.createCalled = true;
    this.cr = { ...params.body, metadata: { ...params.body.metadata, uid: "cr-new", resourceVersion: "1" },
      status: { conditions: [{ type: "Ready", status: "False", reason: "PodFailed",
        message: 'Error seen: PVC "workspace-x" is owned by Sandbox/x (UID: 8f3311cf), not by sandbox "x"' }] } };
    return this.cr;
  }
  override async getNamespacedCustomObject(): Promise<unknown> {
    if (!this.cr) throw new FakeApiError(404, "not found");
    return this.cr;
  }
  override async deleteNamespacedCustomObject(): Promise<unknown> {
    this.deleteCalls++;
    this.cr = null;
    return {};
  }
}
```

`makeProvider` takes a secrets fake first; pass `new FakeSecretsApi()` (class at `provider.test.ts:186`). The `deleteCalls === 0` assertion depends on Task 9; until then it may fail on that line only. Leave it in; Task 9 turns it green.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/lifecycle.test.ts test/provider.test.ts -t "ownership"`
Expected: the classifier test FAILS (`pod failed: Error seen: ...`), the provider test FAILS with a plain `Error` about not becoming ready.

- [ ] **Step 3: Implement the classifier change**

In `lifecycle.ts`, above `classifyPodFailure`:

```ts
/** The agent-sandbox controller refuses to adopt a pod or PVC whose owner
 * UID belongs to a deleted Sandbox of the same name. Kubernetes garbage
 * collection removes those dependents once the old owner is gone and the
 * controller then creates fresh ones, so this condition heals on its own.
 * It must read as provisioning, never as a terminal failure. */
export const OWNERSHIP_CONDITION_PATTERN = /is owned by Sandbox\//;
```

Change the pod-failed branch:

```ts
  if (pod.phase === "Failed" || crReadyCondition?.reason === "PodFailed") {
    const detail = crReadyCondition?.message ?? crReadyCondition?.reason ?? "pod entered phase Failed";
    if (OWNERSHIP_CONDITION_PATTERN.test(detail)) return null;
    return `pod failed: ${detail}`;
  }
```

Export the pattern from the package index.

- [ ] **Step 4: Implement the readiness timeout detail**

In `provider.ts` `waitReady`:

After `let lastState: SandboxStatus["state"] = "provisioning";` add:

```ts
    let lastDetail: string | undefined;
```

Inside the `try`, right after `lastState = status.state;`, read the Ready condition message from the CR. `sandboxStatus` does not return it, so fetch it from the CR that `sandboxStatus` already read by adding one line before the status call:

```ts
        const cr = await getSandbox(this.deps.objectsApi, this.cfg, name);
        lastDetail = cr?.status?.conditions?.find((c) => c.type === "Ready")?.message ?? lastDetail;
```

(`getSandbox` is already imported in `provider.ts`; this is one extra GET per poll second during readiness, acceptable for a 60 second window.)

Replace the deadline throw:

```ts
      if (Date.now() >= deadline) {
        const readDetail = lastReadError ? ` Last Kubernetes read error: ${lastReadError}.` : "";
        const conditionDetail = lastDetail ? ` Last condition: ${lastDetail}.` : "";
        const message =
          `Sandbox CR "${name}" did not become ready within ${READY_TIMEOUT_MS}ms (state: ${lastState}).${conditionDetail}${readDetail} ` +
          "Check Kubernetes API access, the sandbox controller, and pod events, then retry.";
        if (lastDetail && OWNERSHIP_CONDITION_PATTERN.test(lastDetail)) {
          // Retry-shaped (spec 8.4): the controller heals this once garbage
          // collection finishes. Surface it fast and let the attachment back
          // off; create()'s cleanup keeps the CR for kind "ownership".
          throw new SandboxStartupError(name, message, "ownership");
        }
        throw new Error(message);
      }
```

Import `OWNERSHIP_CONDITION_PATTERN` from `./lifecycle.js`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/lifecycle.test.ts test/provider.test.ts`
Expected: PASS except possibly the `deleteCalls === 0` line, which Task 9 fixes.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-kubernetes/src/lifecycle.ts packages/sandbox-kubernetes/src/index.ts packages/sandbox-kubernetes/src/provider.ts packages/sandbox-kubernetes/test/lifecycle.test.ts packages/sandbox-kubernetes/test/provider.test.ts
git commit -S -m "fix(sandbox-kubernetes): treat the controller ownership condition as retry-shaped"
```

---

### Task 8: Attachment backoff after a terminal startup error, with fast-fail inside the window

**Files:**
- Modify: `packages/engine/src/sandbox/attachment.ts` (fields near line 195, `replace()` 366-395, `ensureReady()` 401-458, `kickProvision()` 847-868, `doProvisionInner` catch 1240-1260, `destroy()`)
- Test: `packages/engine/test/sandbox-attachment.test.ts`

**Interfaces:**
- Consumes: `SandboxStartupError.kind` (Task 4).
- Produces: private `terminalFailure: { at: number; attempts: number; error: SandboxStartupError | SandboxPreparationError } | null`; exported constants `STARTUP_BACKOFF_BASE_MS = 15_000`, `STARTUP_BACKOFF_CAP_MS = 120_000` from `attachment.ts` (re-export not needed).

- [ ] **Step 1: Write the failing tests**

In `sandbox-attachment.test.ts`:

```ts
describe("terminal startup backoff", () => {
  it("does not call create() again inside the window, and a caller inside it fails fast with the memoized cause", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const attachment = new SandboxAttachment(provider, {});
      const d = provider.nextDeferred();
      const first = attachment.ensureReady({ timeoutMs: 60_000 });
      const cause = new SandboxStartupError("sess-1", "container crash-looping (CrashLoopBackOff): exit 127: tini not found", "crash_loop");
      d.reject(cause);
      await expect(first).rejects.toBe(cause);
      expect(provider.createCalls).toBe(1);

      // 1 second later: still inside the 15s window.
      await vi.advanceTimersByTimeAsync(1_000);
      const started = Date.now();
      const second = attachment.ensureReady({ timeoutMs: 60_000 });
      await expect(second).rejects.toSatisfy((e: unknown) =>
        e instanceof SandboxStartupError && e.kind === "crash_loop" && e.message.includes("tini not found") && /retry in \d+s/.test(e.message));
      expect(Date.now() - started).toBeLessThan(50);
      expect(provider.createCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries after the window and doubles the window on a second terminal failure", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const attachment = new SandboxAttachment(provider, {});
      const d1 = provider.nextDeferred();
      const p1 = attachment.ensureReady({ timeoutMs: 60_000 });
      d1.reject(new SandboxStartupError("s", "boom", "pod_failed"));
      await expect(p1).rejects.toBeInstanceOf(SandboxStartupError);

      await vi.advanceTimersByTimeAsync(15_000);
      const d2 = provider.nextDeferred();
      const p2 = attachment.ensureReady({ timeoutMs: 60_000 });
      expect(provider.createCalls).toBe(2);
      d2.reject(new SandboxStartupError("s", "boom again", "pod_failed"));
      await expect(p2).rejects.toBeInstanceOf(SandboxStartupError);

      await vi.advanceTimersByTimeAsync(20_000); // 20s < 30s second window
      await expect(attachment.ensureReady({ timeoutMs: 60_000 })).rejects.toBeInstanceOf(SandboxStartupError);
      expect(provider.createCalls).toBe(2);

      await vi.advanceTimersByTimeAsync(10_000); // now 30s
      provider.nextDeferred().resolve(makeFakeSandbox("ok"));
      await attachment.ensureReady({ timeoutMs: 60_000 });
      expect(provider.createCalls).toBe(3);
      expect(attachment.state).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the window at 120 seconds", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const attachment = new SandboxAttachment(provider, {});
      for (let i = 0; i < 5; i++) {
        const d = provider.nextDeferred();
        const p = attachment.ensureReady({ timeoutMs: 60_000 });
        d.reject(new SandboxStartupError("s", `fail ${i}`, "other"));
        await expect(p).rejects.toBeInstanceOf(SandboxStartupError);
        await vi.advanceTimersByTimeAsync(120_000);
      }
      expect(provider.createCalls).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replace() bypasses the window", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const attachment = new SandboxAttachment(provider, {});
      const d = provider.nextDeferred();
      const p = attachment.ensureReady({ timeoutMs: 60_000 });
      d.reject(new SandboxStartupError("s", "boom", "other"));
      await expect(p).rejects.toBeInstanceOf(SandboxStartupError);
      provider.nextDeferred().resolve(makeFakeSandbox("replaced"));
      await attachment.replace();
      expect(provider.createCalls).toBe(2);
      expect(attachment.state).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy() inside the window clears the memo and rejects later callers as destroyed, not as the old cause", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const attachment = new SandboxAttachment(provider, {});
      const d = provider.nextDeferred();
      const p = attachment.ensureReady({ timeoutMs: 60_000 });
      d.reject(new SandboxStartupError("s", "boom", "other"));
      await expect(p).rejects.toBeInstanceOf(SandboxStartupError);
      await attachment.destroy();
      await expect(attachment.ensureReady({ timeoutMs: 1_000 })).rejects.toBeInstanceOf(SandboxUnavailableError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-terminal create failure does not arm the window", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider();
      const attachment = new SandboxAttachment(provider, {});
      const d = provider.nextDeferred();
      const p = attachment.ensureReady({ timeoutMs: 500 });
      d.reject(new Error("transient apiserver 503"));
      await vi.advanceTimersByTimeAsync(500);
      await expect(p).rejects.toBeInstanceOf(WorkspaceProvisioningError);
      provider.nextDeferred().resolve(makeFakeSandbox("ok"));
      await attachment.ensureReady({ timeoutMs: 1_000 });
      expect(provider.createCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/engine test -- test/sandbox-attachment.test.ts -t "terminal startup backoff"`
Expected: the first three and the "destroy" test FAIL (`createCalls` is 2 where 1 expected, or the second call waits). "replace() bypasses" and "non-terminal" may pass already.

- [ ] **Step 3: Implement**

Fields, next to `private lastStartError`:

```ts
  /** Armed by a terminal startup failure (spec 8.1). `kickProvision` stays
   * quiet until `at + window`; `ensureReady` inside the window rejects at
   * once with `error` so callers get the cause instead of a timeout. */
  private terminalFailure: { at: number; attempts: number; error: SandboxStartupError | SandboxPreparationError } | null = null;
```

Constants near the existing `REPLACE_BACKOFF_CAP_MS`:

```ts
/** First wait after a terminal startup failure; doubles per attempt. */
export const STARTUP_BACKOFF_BASE_MS = 15_000;
/** Longest wait between terminal-failure retries. */
export const STARTUP_BACKOFF_CAP_MS = 120_000;
```

Helper method, near `kickProvision`:

```ts
  /** Milliseconds left in the terminal-failure window, or 0 when none. */
  private startupBackoffRemainingMs(): number {
    const failure = this.terminalFailure;
    if (!failure) return 0;
    const window = Math.min(STARTUP_BACKOFF_CAP_MS, STARTUP_BACKOFF_BASE_MS * 2 ** (failure.attempts - 1));
    return Math.max(0, failure.at + window - Date.now());
  }
```

`kickProvision`, after the `if (this.inFlight) return;` line:

```ts
    if (this.startupBackoffRemainingMs() > 0) return;
```

`ensureReady`, before `this.kickProvision();`:

```ts
    const remainingMs = this.startupBackoffRemainingMs();
    if (remainingMs > 0 && this.terminalFailure) {
      const prior = this.terminalFailure.error;
      const seconds = Math.ceil(remainingMs / 1000);
      if (prior instanceof SandboxStartupError) {
        return Promise.reject(new SandboxStartupError(prior.sandboxId, `${prior.reason} (retry in ${seconds}s)`, prior.kind));
      }
      return Promise.reject(prior);
    }
```

`doProvisionInner` catch, inside the `if (err instanceof SandboxStartupError || err instanceof SandboxPreparationError)` block, before rejecting waiters:

```ts
        const attempts = (this.terminalFailure?.attempts ?? 0) + 1;
        this.terminalFailure = { at: Date.now(), attempts, error: err };
```

Where a provision succeeds (`publishReady`), clear it:

```ts
  private publishReady(): void {
    this.lastStartError = undefined;
    this.terminalFailure = null;
    ...
```

`replace()`, immediately before its `this.kickProvision();`:

```ts
    this.terminalFailure = null;
```

`destroy()`: find where it sets `this.destroyed = true` and add `this.terminalFailure = null;` beside it.

- [ ] **Step 4: Run the whole engine suite**

Run: `pnpm --filter @valet/engine test`
Expected: PASS. Watch `attachment-replace.test.ts` and `attachment-reconcile.test.ts`; if a reconcile test expected an immediate re-provision after a `SandboxStartupError`, that expectation now conflicts with spec 8.1 and should advance fake timers by 15 seconds instead.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/sandbox/attachment.ts packages/engine/test/sandbox-attachment.test.ts
git commit -S -m "fix(engine): back off after a terminal sandbox startup failure while failing callers fast

kickProvision recreated the CR within a second of create() deleting it,
racing the controller's garbage collection. Callers inside the window get
the memoized cause immediately instead of waiting out their timeout."
```

---

### Task 9: Provider waits for its own cleanup and for orphaned same-name resources

**Files:**
- Modify: `packages/sandbox-kubernetes/src/provider.ts` (constants near 160, `create()` before the `applySandbox` call and the failed-create catch at 1258-1278)
- Test: `packages/sandbox-kubernetes/test/provider.test.ts`

**Interfaces:**
- Consumes: `this.deps.livenessApi.getPodUid(ns, pod)`, `this.deps.pvcApi?.readPvc(ns, name)`, `getSandbox(objectsApi, cfg, name)`, `SandboxStartupError.kind` (Task 4), `startupKindOf` (Task 5).
- Produces: private `awaitSameNameResourcesGone(name: string, timeoutMs: number): Promise<boolean>`; `export const RESOURCE_GONE_TIMEOUT_MS = 30_000`; `export const RESOURCE_GONE_POLL_MS = 500`.

- [ ] **Step 1: Write the failing tests**

In `provider.test.ts`, add fakes next to `FakeLivenessApi`:

```ts
/** Liveness fake that reports a pod uid for the first `present` calls, then null. */
class CountdownLivenessApi implements PodLivenessApi {
  calls = 0;
  constructor(private present: number) {}
  async getPodUid(): Promise<string | null> {
    this.calls++;
    return this.calls <= this.present ? "pod-uid" : null;
  }
}

/** PVC fake that reports the claim for the first `present` calls, then null. */
class CountdownPvcApi implements SandboxPvcApi {
  calls = 0;
  constructor(private present: number) {}
  async readPvc(): Promise<WorkspacePvcRead | null> {
    this.calls++;
    return this.calls <= this.present ? { requestedStorage: "10Gi", capacityStorage: "10Gi", annotations: {} } : null;
  }
  async patchPvcStorage(): Promise<void> {}
}

/** Objects API whose fresh CR never becomes ready: pod status reports a
 * crash loop, so create() takes the failed-create path. */
class CrashLoopObjectsApi extends FakeObjectsApi {
  deleteCalls = 0;
  cr: SandboxCRRead | null = null;
  override async createNamespacedCustomObject(params: CreateSandboxParams): Promise<unknown> {
    this.cr = { ...params.body, metadata: { ...params.body.metadata, uid: "cr-fresh", resourceVersion: "1",
      annotations: { ...params.body.metadata.annotations, "agents.x-k8s.io/pod-name": "pod-fresh" } },
      status: { conditions: [{ type: "Ready", status: "False", reason: "PodFailed" }] } };
    return this.cr;
  }
  override async getNamespacedCustomObject(): Promise<unknown> {
    if (!this.cr) throw new FakeApiError(404, "not found");
    return this.cr;
  }
  override async deleteNamespacedCustomObject(): Promise<unknown> {
    this.deleteCalls++;
    this.cr = null;
    return {};
  }
}

/** The stock FakeObjectsApi answers every GET with a Ready CR, which would
 * make the pre-create orphan check take the adopt path. This one is absent
 * until create() is called, then Ready. */
class AbsentUntilCreatedObjectsApi extends FakeObjectsApi {
  private created: unknown = null;
  override async createNamespacedCustomObject(params: CreateSandboxParams): Promise<unknown> {
    this.created = await super.createNamespacedCustomObject(params);
    return this.created;
  }
  override async getNamespacedCustomObject(params: GetSandboxParams): Promise<unknown> {
    if (!this.created) throw new FakeApiError(404, "not found");
    return super.getNamespacedCustomObject(params);
  }
}

const crashLoopPodStatusApi: SandboxPodStatusApi = {
  async getPodStatus() {
    return { phase: "Running", containerStatuses: [{ name: "sandbox", waitingReason: "CrashLoopBackOff" }] };
  },
};
```

Import `SandboxPvcApi`, `WorkspacePvcRead`, `SandboxPodStatusApi`, `RESOURCE_GONE_POLL_MS` from `../src/index.js` (export the two types from the index if they are not already).

Tests:

```ts
describe("create() waits for its own cleanup and for orphans", () => {
  it("after a failed create, waits until the pod and PVC are gone before returning the startup error", async () => {
    vi.useFakeTimers();
    try {
      const objectsApi = new CrashLoopObjectsApi();
      const liveness = new CountdownLivenessApi(3);
      const pvc = new CountdownPvcApi(5);
      const provider = new KubernetesSandboxProvider(
        { objectsApi, podsApi: new FakePodsApi(), execApi: fakePodExecApi, livenessApi: liveness, pvcApi: pvc,
          podStatusApi: crashLoopPodStatusApi, secretsApi: new FakeSecretsApi() },
        providerCfg,
      );
      const outcome = provider.create({ workspace: "/w", sessionId: "s-cleanup" }).then(() => "resolved", (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(RESOURCE_GONE_POLL_MS * 8);
      const err = await outcome;
      expect(err).toBeInstanceOf(SandboxStartupError);
      expect((err as SandboxStartupError).kind).toBe("crash_loop");
      expect(objectsApi.deleteCalls).toBe(1);
      expect(liveness.calls).toBeGreaterThanOrEqual(4);
      expect(pvc.calls).toBeGreaterThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up waiting after RESOURCE_GONE_TIMEOUT_MS and still returns the startup error", async () => {
    vi.useFakeTimers();
    try {
      const objectsApi = new CrashLoopObjectsApi();
      const provider = new KubernetesSandboxProvider(
        { objectsApi, podsApi: new FakePodsApi(), execApi: fakePodExecApi, livenessApi: new CountdownLivenessApi(Number.MAX_SAFE_INTEGER),
          pvcApi: new CountdownPvcApi(Number.MAX_SAFE_INTEGER), podStatusApi: crashLoopPodStatusApi, secretsApi: new FakeSecretsApi() },
        providerCfg,
      );
      const outcome = provider.create({ workspace: "/w", sessionId: "s-stuck" }).then(() => "resolved", (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await outcome).toBeInstanceOf(SandboxStartupError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits on the pod only when no pvcApi is configured", async () => {
    vi.useFakeTimers();
    try {
      const objectsApi = new CrashLoopObjectsApi();
      const liveness = new CountdownLivenessApi(2);
      const provider = new KubernetesSandboxProvider(
        { objectsApi, podsApi: new FakePodsApi(), execApi: fakePodExecApi, livenessApi: liveness,
          podStatusApi: crashLoopPodStatusApi, secretsApi: new FakeSecretsApi() },
        providerCfg,
      );
      const outcome = provider.create({ workspace: "/w", sessionId: "s-nopvc" }).then(() => "resolved", (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(RESOURCE_GONE_POLL_MS * 4);
      expect(await outcome).toBeInstanceOf(SandboxStartupError);
      expect(liveness.calls).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delete the CR when the startup error kind is ownership", async () => {
    vi.useFakeTimers();
    try {
      const objectsApi = new OwnershipConditionObjectsApi(); // from Task 7
      const provider = makeProvider(new FakeSecretsApi(), objectsApi);
      const outcome = provider.create({ workspace: "/w", sessionId: "s-own2" }).then(() => "resolved", (e: unknown) => e);
      await vi.advanceTimersByTimeAsync(61_000);
      const err = await outcome;
      expect((err as SandboxStartupError).kind).toBe("ownership");
      expect(objectsApi.deleteCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("before creating a fresh CR, waits for an orphaned same-name pod or PVC to disappear", async () => {
    vi.useFakeTimers();
    try {
      const objectsApi = new AbsentUntilCreatedObjectsApi(); // 404 on get until created; Ready=True afterwards
      const liveness = new CountdownLivenessApi(2);
      const pvc = new CountdownPvcApi(2);
      const provider = new KubernetesSandboxProvider(
        { objectsApi, podsApi: new FakePodsApi(), execApi: fakePodExecApi, livenessApi: liveness, pvcApi: pvc, secretsApi: new FakeSecretsApi() },
        providerCfg,
      );
      const pending = provider.create({ workspace: "/w", sessionId: "s-orphan" });
      await vi.advanceTimersByTimeAsync(0);
      expect(objectsApi.createCalled).toBe(false); // still waiting on the orphan
      await vi.advanceTimersByTimeAsync(RESOURCE_GONE_POLL_MS * 3);
      await pending;
      expect(objectsApi.createCalled).toBe(true);
      expect(liveness.calls).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait at all when the CR already exists (adopt path)", async () => {
    const objectsApi = new ResourceAdoptingObjectsApi(buildSandboxManifest(providerCfg, "s-adopt", {}));
    const liveness = new CountdownLivenessApi(Number.MAX_SAFE_INTEGER);
    const provider = new KubernetesSandboxProvider(
      { objectsApi, podsApi: new FakePodsApi(), execApi: fakePodExecApi, livenessApi: liveness,
        pvcApi: new CountdownPvcApi(Number.MAX_SAFE_INTEGER), secretsApi: new FakeSecretsApi() },
      providerCfg,
    );
    await provider.create({ workspace: "/w", sessionId: "s-adopt" });
    expect(objectsApi.calls[0]).toBe("get");
  });
});
```

The last test relies on the adopt path doing a GET before create (the orphan check must GET first and skip the wait when the CR exists). If `ResourceAdoptingObjectsApi` requires `podsApi` to resolve the pod name for readiness, reuse whatever the existing adoption tests pass; copy their provider construction.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @valet/sandbox-kubernetes test -- test/provider.test.ts -t "waits for its own cleanup"`
Expected: FAIL: `RESOURCE_GONE_POLL_MS` not exported; liveness call counts too low; `createCalled` true immediately in the orphan test.

- [ ] **Step 3: Implement**

Constants in `provider.ts` next to `READY_TIMEOUT_MS`:

```ts
/** Upper bound on waiting for a same-name pod and PVC to disappear, both
 * after our own failed-create cleanup and before creating over an orphan
 * left by an earlier delete (spec 8.2, 8.3). */
export const RESOURCE_GONE_TIMEOUT_MS = 30_000;
export const RESOURCE_GONE_POLL_MS = 500;
```

Export both from the package index.

Private method on `KubernetesSandboxProvider`:

```ts
  /** Polls until no pod named `name` and no PVC named `workspace-<name>`
   * exist, or `timeoutMs` passes. Returns true when both are gone. The pod
   * check uses the liveness API; the PVC check is skipped when no pvcApi is
   * wired. Never throws: a read error counts as "still present" and the
   * deadline bounds the wait. */
  private async awaitSameNameResourcesGone(name: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pvcName = `workspace-${name}`;
    for (;;) {
      const podPresent = await this.deps.livenessApi.getPodUid(this.cfg.namespace, name).then((uid) => uid !== null, () => true);
      const pvcPresent = this.deps.pvcApi
        ? await this.deps.pvcApi.readPvc(this.cfg.namespace, pvcName).then((pvc) => pvc !== null, () => true)
        : false;
      if (!podPresent && !pvcPresent) return true;
      if (Date.now() >= deadline) {
        console.warn(`k8s sandbox ${name}: pod or PVC still present after ${timeoutMs}ms; continuing`);
        return false;
      }
      await sleep(RESOURCE_GONE_POLL_MS);
    }
  }
```

The controller names the pod after the Sandbox (`root-valet-...` in the incident events) and the PVC `workspace-<name>`; both confirmed from the 2026-10-26 controller log.

Pre-create orphan wait: in `create()`, immediately before the `applySandbox(...)` call, add:

```ts
    // Spec 8.3: a pod or PVC with our name whose Sandbox was deleted is
    // being garbage-collected. Creating over it makes the controller reject
    // the new CR ("is owned by Sandbox/... not by sandbox"). Only relevant
    // when no CR exists; an existing CR is the adopt path and owns them.
    if ((await getSandbox(this.deps.objectsApi, this.cfg, name)) === null) {
      await this.awaitSameNameResourcesGone(name, RESOURCE_GONE_TIMEOUT_MS);
    }
```

Failed-create cleanup: change the block at `provider.ts:1258-1278` to:

```ts
      const ownsPendingCreate = applied.metadata.annotations?.[NEVER_READY_OWNER_ANNOTATION_KEY] === neverReadyOwner;
      if (err instanceof SandboxStartupError && err.kind !== "ownership" &&
        (!adopted || ownsPendingCreate)) {
        // (existing comment block stays)
        await this.destroy(name).catch((cleanupErr) => {
          console.error(`k8s sandbox ${name}: CR cleanup after failed create failed:`, cleanupErr);
        });
        // Spec 8.2: do not hand control back while the pod and PVC we just
        // orphaned are still terminating; the next create would race the
        // controller's garbage collection.
        await this.awaitSameNameResourcesGone(name, RESOURCE_GONE_TIMEOUT_MS);
      }
      throw err;
```

- [ ] **Step 4: Run the package suite**

Run: `pnpm --filter @valet/sandbox-kubernetes test`
Expected: PASS, including Task 7's `deleteCalls === 0` assertion. Existing failed-create tests that used a liveness fake returning a fixed uid forever will now wait 30 fake seconds; if any such test runs on real timers and slows down, give it `CountdownLivenessApi(0)`.

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-kubernetes/src/provider.ts packages/sandbox-kubernetes/src/index.ts packages/sandbox-kubernetes/test/provider.test.ts
git commit -S -m "fix(sandbox-kubernetes): wait for same-name pod and PVC removal around CR deletes

After a failed create the provider deleted the CR and returned while the
pod and PVC were still terminating; the retry recreated the same name and
the controller rejected it over the stale owner UID. Wait for removal after
our own cleanup, wait for orphans before any fresh create, and keep the CR
when the failure is the ownership condition itself."
```

---

### Task 10: Workflow sessions pin the same stock image as every other session

**Files:**
- Modify: `packages/api/src/engine/host.ts:4626` and the two other create-opts sites that read `this.opts.defaultImages?.full ?? this.opts.defaultImage` (lines 1296, 3191, 4409)
- Test: `packages/api/src/engine/host.default-image.test.ts`

**Interfaces:**
- Produces: private `stockImage(): string | undefined` on `EngineHost`, returning `this.opts.defaultImages?.full ?? this.opts.defaultImage`; used by all four create sites and by `buildSpecProvider`'s `stockImage` local (line 1786).

- [ ] **Step 1: Write the failing test**

Find the method that contains line 4626 (search upward from it for the nearest `async ...(` method signature; the reviewer located it as the workflow-step session builder). In `host.default-image.test.ts`, add a test shaped like the existing "headless-profile session boots defaultImages.full" case but creating the session through the workflow path. If the workflow path cannot be driven from `bootTestApi` without a workflow run, test the seam instead: export nothing new, and assert with a source-level pin:

```ts
  it("no create site pins defaultImage directly; all go through the single stock lineage", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./host.ts", import.meta.url), "utf8");
    expect(source.match(/image: this\.opts\.defaultImage,/g)).toBeNull();
    expect(source.match(/this\.stockImage\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
```

Prefer the behavioral test if the workflow builder can be reached; keep the source pin either way, since it is what prevents the fifth site from drifting again.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @valet/api test -- src/engine/host.default-image.test.ts -t "single stock lineage"`
Expected: FAIL, one match for `image: this.opts.defaultImage,` and zero for `this.stockImage()`.

- [ ] **Step 3: Implement**

Add to `EngineHost`:

```ts
  /** The one stock image every session shape boots when no bake applies.
   * `buildSpecProvider` compares the resolved spec against this same value
   * (`spec.image !== stockImage` means an override), so every create site
   * must use it; a site that pins `defaultImage` alone boots the headless
   * image under a kubernetes deployment that only ships the full lineage. */
  private stockImage(): string | undefined {
    return this.opts.defaultImages?.full ?? this.opts.defaultImage;
  }
```

Replace at lines 1296, 3191, 4409: `this.opts.defaultImages?.full ?? this.opts.defaultImage` with `this.stockImage()`. Replace at 4626: `image: this.opts.defaultImage,` with `image: this.stockImage(),`. In `buildSpecProvider` (line 1786), replace the three-line `const stockImage = ...` with `const stockImage = this.stockImage() ?? "";`.

- [ ] **Step 4: Run the api engine tests**

Run: `pnpm --filter @valet/api test -- src/engine/host.default-image.test.ts src/engine/host.spec-provider.test.ts src/engine/host.prebuild.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/engine/host.ts packages/api/src/engine/host.default-image.test.ts
git commit -S -m "fix(api): boot workflow sandboxes from the same stock image lineage as other sessions"
```

---

### Task 11: Whole-branch verification and PR

**Files:**
- None new.

- [ ] **Step 1: Run every affected package's full suite**

Run:
```bash
pnpm --filter @valet/engine test
pnpm --filter @valet/sandbox-kubernetes test
pnpm --filter @valet/api test -- src/bakes src/engine/host.default-image.test.ts src/engine/host.spec-provider.test.ts
pnpm -w typecheck 2>/dev/null || pnpm -r --filter './packages/*' exec tsc --noEmit
```
Expected: all PASS, typecheck clean. The cluster-tagged suites (`*.cluster.test.ts`) are skipped without a cluster; do not try to run them.

- [ ] **Step 2: Review the diff against the spec's PR 1 list**

Run: `git log --oneline origin/dev-v2..HEAD` and `git diff --stat origin/dev-v2..HEAD`
Expected: ten commits (Tasks 1 to 10), touching only `packages/api`, `packages/engine`, `packages/sandbox-kubernetes`, and `docker/Dockerfile.sandbox-k8s`. No file under `packages/api/src/schema` or any `0000_app.sql`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin conner/image-pipeline-health-pr1
gh pr create -R tkhq/valet --base dev-v2 --title "Sandbox startup: stop the bleeding (image pipeline health, PR 1 of 4)" --body-file - <<'EOF'
First of four PRs from docs/plans/2026-10-26-image-pipeline-health-design.md (section 14). No schema change.

- bakes: read lockfiles over 1 MB through the blobs API (unblocks tkhq/sdk rebakes)
- sandbox-kubernetes: guarded tini in the browser-enabled headless command; crash-loop errors carry the container's last line; the controller's ownership condition is retry-shaped; the provider waits for same-name pod and PVC removal after its own cleanup and before creating over an orphan
- engine: backoff after a terminal startup failure with fast-fail inside the window; `valet.sandbox.startup_failed` counter by kind
- api: workflow sandboxes use the single stock image lineage
- docker: `LABEL io.valet.sandbox.contract="3"` on the stock image, read by PR 2

After this deploys: press "Bake now" on tkhq/sdk in organization settings.
EOF
```

Pushing and the signed commits need a Yubikey tap; announce before each.

---

## Self-review notes

- Spec 14.1 items, each mapped: blobs fallback (Task 1), guarded tini (Task 2), label (Task 3), `startup_failed` counter and kind (Tasks 4, 5), crash-loop detail (Task 6), ownership retry-shaped with detail (Task 7), `kickProvision` backoff with fast-fail (Task 8), wait-for-gone and pre-create orphan wait (Task 9), workflow image pin (Task 10).
- Names used across tasks: `SandboxStartupKind`, `SandboxStartupError(sandboxId, reason, kind)`, `recordSandboxStartupFailure(kind)`, `startupKindOf(reason)`, `OWNERSHIP_CONDITION_PATTERN`, `RESOURCE_GONE_TIMEOUT_MS`, `RESOURCE_GONE_POLL_MS`, `STARTUP_BACKOFF_BASE_MS`, `STARTUP_BACKOFF_CAP_MS`, `awaitSameNameResourcesGone`, `stockImage()`. Each is defined in the task that first introduces it.
- Review Focus lines: 1 is Task 1's third test; 2 and 3 are Task 8's fourth and fifth tests; 4 is Task 9's third test; 5 is Task 9's sixth test.
- Two deliberate refinements of the spec are declared at the top; the spec file should get a one-line note under 8.4 and 8.5 when PR 1 merges.
