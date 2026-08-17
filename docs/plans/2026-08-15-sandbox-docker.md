# Sandbox Docker Support (rootless DinD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions can opt into a rootless docker daemon inside their sandbox, on both the docker and kubernetes providers, with no privileged containers.

**Architecture:** A `docker?: boolean` flag threads session-create API / `.valet/prebuild.yaml` → session meta → `SandboxCreateOpts` → provider deltas (seccomp/AppArmor unconfined + `/dev/fuse` + `VALET_SANDBOX_DOCKER=1`). The sandbox image bakes a dormant rootless docker toolchain (dockerd-rootless, rootlesskit, fuse-overlayfs, slirp4netns) run by a dedicated non-root `dockerd` user; start scripts launch it only when the env var is set.

**Tech Stack:** TypeScript monorepo (pnpm, vitest), Docker CE rootless extras, agent-sandbox CRD on kubernetes.

**Spec:** `docs/specs/2026-08-15-sandbox-docker-design.md`

**Working tree:** `/tmp/valet-sandbox-docker`, branch `feat/sandbox-docker` (off `dev-v2`). Run all commands from that directory.

## Global Constraints

> Amended 2026-08-15 (see spec decision 2): rootless DinD additionally requires CAP_SYS_ADMIN + CAP_NET_ADMIN, /dev/net/tun, and unmasked system paths; "never add capabilities" no longer holds. The ledger records the ruling.

- Never `--privileged`, never mount a host docker socket, never add Linux capabilities (spec decision 2).
- The daemon must NOT start in sandboxes that did not opt in; their run args / manifests must be byte-identical to today.
- No `any`, no `as unknown as T`, no `@ts-ignore` (CLAUDE.md type-safety rules).
- Pre-1.0 migrations: edit `packages/api/migrations/pg/0000_app.sql` in place + Drizzle schema; after editing run `rm -rf ~/.valet/pg`.
- Pin every installed tool version; bump deliberately (matches `GH_VERSION` pattern).
- Prose (docs, comments, errors) follows ASD-STE100 per CLAUDE.md; user-facing errors name the corrective action.
- Commit per task, subjects ≤72 chars, no AI co-author trailers.
- Final validation is `make e2e` with a clean scorecard (capture FULL output).

---

### Task 1: Engine contract — `docker` flag and capability

**Files:**
- Modify: `packages/engine/src/types.ts:903-923` (`SandboxCreateOpts`), `:931+` (`SandboxCapabilities`)

**Interfaces:**
- Consumes: nothing.
- Produces: `SandboxCreateOpts.docker?: boolean`; `SandboxCapabilities.dockerSupport?: boolean` (optional so existing capability literals stay valid — same pattern as `isolated?`). All later tasks reference exactly these names.

- [ ] **Step 1: Add the fields**

In `SandboxCreateOpts`, after `credsFiles`:

```ts
  /**
   * Request a rootless docker daemon inside the sandbox. Providers that
   * support it (capabilities().dockerSupport) relax seccomp/AppArmor to
   * unconfined, add /dev/fuse, and set VALET_SANDBOX_DOCKER=1 so the image
   * start scripts launch dockerd-rootless. Never privileged. Providers
   * without support ignore the flag.
   * See docs/specs/2026-08-15-sandbox-docker-design.md.
   */
  docker?: boolean;
```

In `SandboxCapabilities`, after `isolated?`:

```ts
  /**
   * Whether the backend honors SandboxCreateOpts.docker (rootless
   * docker-in-sandbox). Absent means not supported; the flag is ignored.
   */
  dockerSupport?: boolean;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean (optional fields break nothing).

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/types.ts
git commit -m "feat(engine): docker flag on SandboxCreateOpts + dockerSupport capability"
```

---

### Task 2: sandbox-docker — run-args delta and capability

**Files:**
- Modify: `packages/sandbox-docker/src/sandbox.ts` (`BuildDockerRunArgsOpts`, `buildDockerRunArgs` at ~line 169, `DockerSandboxProvider.create` at ~757, `capabilities()` at ~743)
- Test: `packages/sandbox-docker/test/run-args.test.ts`

**Interfaces:**
- Consumes: `SandboxCreateOpts.docker` (Task 1).
- Produces: `BuildDockerRunArgsOpts.docker?: boolean`. When true, argv additionally contains, in order and before the image: `--security-opt seccomp=unconfined`, `--security-opt apparmor=unconfined`, `--device /dev/fuse`, `--env VALET_SANDBOX_DOCKER=1`. Headless+docker command becomes the `/start-headless.sh` probe wrapper. `capabilities().dockerSupport === true`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/sandbox-docker/test/run-args.test.ts`:

```ts
describe("docker flag (rootless DinD)", () => {
  const base = {
    containerName: "valet-sandbox-x",
    image: "img:1",
    workspaceHostPath: "/tmp/ws",
    network: "bridge",
  };

  it("adds exactly the rootless relaxations when docker is true", () => {
    const args = buildDockerRunArgs({ ...base, docker: true });
    const joined = args.join(" ");
    expect(joined).toContain("--security-opt seccomp=unconfined");
    expect(joined).toContain("--security-opt apparmor=unconfined");
    expect(joined).toContain("--device /dev/fuse");
    expect(joined).toContain("--env VALET_SANDBOX_DOCKER=1");
    expect(joined).not.toContain("--privileged");
  });

  it("headless+docker runs the start-headless probe wrapper", () => {
    const args = buildDockerRunArgs({ ...base, docker: true });
    expect(args[args.length - 1]).toBe(
      "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
    );
  });

  it("emits nothing docker-related when the flag is absent", () => {
    const joined = buildDockerRunArgs(base).join(" ");
    expect(joined).not.toContain("seccomp");
    expect(joined).not.toContain("apparmor");
    expect(joined).not.toContain("/dev/fuse");
    expect(joined).not.toContain("VALET_SANDBOX_DOCKER");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/sandbox-docker test test/run-args.test.ts`
Expected: FAIL (unknown property `docker` / missing args).

- [ ] **Step 3: Implement**

In `BuildDockerRunArgsOpts` add:

```ts
  /** Rootless docker-in-sandbox (SandboxCreateOpts.docker). Adds the
   * seccomp/AppArmor/fuse relaxations and VALET_SANDBOX_DOCKER=1 — never
   * --privileged. */
  docker?: boolean;
```

In `buildDockerRunArgs`, after the `credsHostDir` mount line:

```ts
  if (opts.docker) {
    runArgs.push("--security-opt", "seccomp=unconfined");
    runArgs.push("--security-opt", "apparmor=unconfined");
    runArgs.push("--device", "/dev/fuse");
    runArgs.push("--env", "VALET_SANDBOX_DOCKER=1");
  }
```

In the headless (`else`) branch, replace the fixed tail command:

```ts
  } else if (opts.docker) {
    // Same probe-and-degrade idiom as the full profile: images without the
    // rootless toolchain still come up (docker commands then fail inside).
    runArgs.push(
      opts.image,
      "sh",
      "-c",
      "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
    );
  } else {
```

In `DockerSandboxProvider.create`, pass `docker: opts.docker` where `BuildDockerRunArgsOpts` is assembled. In `capabilities()` add `dockerSupport: true`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @valet/sandbox-docker test test/run-args.test.ts`
Expected: PASS (including all pre-existing cases — the flag-absent path must be unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-docker
git commit -m "feat(sandbox-docker): rootless DinD run args behind docker flag"
```

---

### Task 3: sandbox-kubernetes — securityContext, manifest delta, capability

**Files:**
- Modify: `packages/sandbox-kubernetes/src/types.ts` (`SandboxContainer`, `SandboxPodSpec`, `Volume`, `VolumeMount`), `packages/sandbox-kubernetes/src/manifest.ts` (`buildSandboxManifest`), `packages/sandbox-kubernetes/src/provider.ts:625` (`capabilities()`)
- Test: `packages/sandbox-kubernetes/test/manifest.test.ts`

**Interfaces:**
- Consumes: `SandboxCreateOpts.docker` (Task 1).
- Produces: `SandboxContainer.securityContext?: { seccompProfile?: { type: "Unconfined" | "RuntimeDefault" } }`; exported consts `DOCKER_STATE_VOLUME_NAME = "docker-state"`, `DOCKER_STATE_MOUNT_PATH = "/home/dockerd/.local/share/docker"`, `DEV_FUSE_VOLUME_NAME = "dev-fuse"`. When `opts.docker`: pod-template annotation `container.apparmor.security.beta.kubernetes.io/sandbox: unconfined`, container seccomp Unconfined, `VALET_SANDBOX_DOCKER=1` env, emptyDir `docker-state` mounted at the docker data-root, hostPath char-device volume `dev-fuse` at `/dev/fuse` (the same `/dev/fuse` mechanism the rootless BuildKit builder uses — mirror `packages/api/src/prebuilds/k8s-builder.ts`'s exact volume shape when implementing).

- [ ] **Step 1: Write the failing tests**

Append to `packages/sandbox-kubernetes/test/manifest.test.ts` (reuse the file's existing `cfg` fixture):

```ts
describe("docker flag (rootless DinD)", () => {
  it("adds the rootless securityContext, annotation, volumes, and env", () => {
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    const pod = cr.spec.podTemplate;
    expect(pod.metadata?.annotations?.[
      "container.apparmor.security.beta.kubernetes.io/sandbox"
    ]).toBe("unconfined");
    const c = pod.spec.containers[0]!;
    expect(c.securityContext?.seccompProfile?.type).toBe("Unconfined");
    expect(c.env).toContainEqual({ name: "VALET_SANDBOX_DOCKER", value: "1" });
    expect(c.volumeMounts).toContainEqual({
      name: DOCKER_STATE_VOLUME_NAME,
      mountPath: DOCKER_STATE_MOUNT_PATH,
    });
    expect(pod.spec.volumes).toContainEqual(
      expect.objectContaining({ name: DOCKER_STATE_VOLUME_NAME }),
    );
    expect(pod.spec.volumes).toContainEqual(
      expect.objectContaining({ name: DEV_FUSE_VOLUME_NAME }),
    );
    expect(JSON.stringify(cr)).not.toContain("privileged");
  });

  it("headless+docker uses the start-headless probe wrapper command", () => {
    const cr = buildSandboxManifest(cfg, "sb-docker", { docker: true });
    expect(cr.spec.podTemplate.spec.containers[0]!.command).toEqual([
      "sh",
      "-c",
      "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
    ]);
  });

  it("emits nothing docker-related when the flag is absent", () => {
    const cr = buildSandboxManifest(cfg, "sb-plain", {});
    const s = JSON.stringify(cr);
    expect(s).not.toContain("seccomp");
    expect(s).not.toContain("apparmor");
    expect(s).not.toContain("VALET_SANDBOX_DOCKER");
    expect(s).not.toContain(DOCKER_STATE_VOLUME_NAME);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/sandbox-kubernetes test test/manifest.test.ts`
Expected: FAIL (missing exports / fields).

- [ ] **Step 3: Implement**

`types.ts` — extend the corev1 subsets:

```ts
export interface SeccompProfile {
  type: "Unconfined" | "RuntimeDefault";
}

export interface ContainerSecurityContext {
  seccompProfile?: SeccompProfile;
}
```

Add `securityContext?: ContainerSecurityContext;` to `SandboxContainer`. Add to `Volume`:

```ts
  emptyDir?: Record<string, never>;
  /** `corev1.HostPathVolumeSource` subset — only the /dev/fuse char device. */
  hostPath?: { path: string; type: "CharDevice" };
```

`manifest.ts` — export the consts from the Interfaces block, then in `buildSandboxManifest` after the creds handling:

```ts
  if (opts.docker) {
    container.securityContext = { seccompProfile: { type: "Unconfined" } };
    container.env = [...(container.env ?? []), { name: "VALET_SANDBOX_DOCKER", value: "1" }];
    container.volumeMounts = [
      ...(container.volumeMounts ?? []),
      { name: DOCKER_STATE_VOLUME_NAME, mountPath: DOCKER_STATE_MOUNT_PATH },
      { name: DEV_FUSE_VOLUME_NAME, mountPath: "/dev/fuse" },
    ];
    if (!isFullProfile) {
      container.command = [
        "sh",
        "-c",
        "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null",
      ];
    }
  }
```

Add the pod-level pieces where `podSpec`/metadata are assembled:

```ts
  if (opts.docker) {
    podSpec.volumes = [
      ...(podSpec.volumes ?? []),
      { name: DOCKER_STATE_VOLUME_NAME, emptyDir: {} },
      { name: DEV_FUSE_VOLUME_NAME, hostPath: { path: "/dev/fuse", type: "CharDevice" } },
    ];
  }
```

and on the pod template metadata (add an `metadata.annotations` object to `podTemplate` — the `SandboxPodTemplate` type already allows it):

```ts
  ...(opts.docker
    ? {
        metadata: {
          annotations: {
            [`container.apparmor.security.beta.kubernetes.io/${SANDBOX_CONTAINER_NAME}`]: "unconfined",
          },
        },
      }
    : {}),
```

Before finishing, open `packages/api/src/prebuilds/k8s-builder.ts`, find its BuildKit-rootless pod spec, and copy its exact `/dev/fuse` + AppArmor mechanism if it differs from the above (the cluster already runs that shape; match it). `provider.ts` `capabilities()`: add `dockerSupport: true`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @valet/sandbox-kubernetes test test/manifest.test.ts` then `pnpm --filter @valet/sandbox-kubernetes test test/lifecycle.test.ts test/provider.test.ts`
Expected: PASS; no-flag manifests byte-identical (existing snapshot-style cases stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/sandbox-kubernetes
git commit -m "feat(sandbox-k8s): rootless DinD securityContext + volumes behind docker flag"
```

---

### Task 4: Sandbox image — dormant rootless toolchain + start scripts

**Files:**
- Modify: `docker/Dockerfile.sandbox-k8s`, `docker/start-full.sh`
- Create: `docker/start-docker.sh`, `docker/start-headless.sh`

**Interfaces:**
- Consumes: `VALET_SANDBOX_DOCKER=1` env (Tasks 2–3).
- Produces: image with docker CLI + rootless daemon toolchain, `dockerd` user (uid 1500, subuid/subgid `100000:65536`), `/start-docker.sh` (idempotent daemon launcher, logs to `/var/log/valet/dockerd.log`, symlinks `/var/run/docker.sock`), `/start-headless.sh` (starts docker if enabled, then execs tail).

- [ ] **Step 1: Dockerfile — toolchain layer**

In the final-image stage of `docker/Dockerfile.sandbox-k8s` (after the `gh` layer), add:

```dockerfile
# Rootless docker-in-sandbox toolchain (sandbox-docker design,
# docs/specs/2026-08-15-sandbox-docker-design.md). Baked always, dormant
# unless VALET_SANDBOX_DOCKER=1 — start scripts launch dockerd-rootless as
# the non-root `dockerd` user. Pinned; bump deliberately.
ARG DOCKER_VERSION=5:27.3.1-1~debian.12~bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      gnupg uidmap fuse-overlayfs slirp4netns iproute2 iptables \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce-cli=${DOCKER_VERSION} \
        docker-ce=${DOCKER_VERSION} \
        docker-ce-rootless-extras=${DOCKER_VERSION} \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1500 dockerd \
    && echo "dockerd:100000:65536" >> /etc/subuid \
    && echo "dockerd:100000:65536" >> /etc/subgid

COPY docker/start-docker.sh /start-docker.sh
COPY docker/start-headless.sh /start-headless.sh
RUN chmod +x /start-docker.sh /start-headless.sh
```

- [ ] **Step 2: Create `docker/start-docker.sh`**

```bash
#!/usr/bin/env bash
# Launches rootless dockerd as the `dockerd` user. Idempotent: a second
# call while the daemon runs is a no-op. Never fails the caller — a broken
# daemon must not keep the sandbox from starting. If docker commands fail,
# read /var/log/valet/dockerd.log inside the sandbox.
set -u
if [ "${VALET_SANDBOX_DOCKER:-0}" != "1" ]; then exit 0; fi
RUNTIME_DIR=/run/docker
SOCK="$RUNTIME_DIR/docker.sock"
LOG=/var/log/valet/dockerd.log
mkdir -p "$RUNTIME_DIR" /var/log/valet /home/dockerd/.local/share/docker
chown -R dockerd:dockerd "$RUNTIME_DIR" /home/dockerd/.local/share/docker
touch "$LOG" && chown dockerd:dockerd "$LOG"
if [ -S "$SOCK" ] && su -s /bin/sh dockerd -c "DOCKER_HOST=unix://$SOCK docker version" >/dev/null 2>&1; then
  exit 0
fi
su -s /bin/bash dockerd -c \
  "XDG_RUNTIME_DIR=$RUNTIME_DIR HOME=/home/dockerd PATH=/usr/bin:/usr/sbin:/usr/local/bin \
   nohup dockerd-rootless.sh --storage-driver=fuse-overlayfs >> $LOG 2>&1 &" || true
# Root-run docker CLIs (the agent) reach the daemon at the default path.
ln -sf "$SOCK" /var/run/docker.sock
exit 0
```

- [ ] **Step 3: Create `docker/start-headless.sh` and hook `start-full.sh`**

`docker/start-headless.sh`:

```bash
#!/usr/bin/env bash
set -u
/start-docker.sh || true
exec tail -f /dev/null
```

In `docker/start-full.sh`, immediately after `mkdir -p "$WORK_DIR"`:

```bash
if [ -x /start-docker.sh ]; then /start-docker.sh || true; fi
```

- [ ] **Step 4: Build and smoke the image locally**

```bash
docker build -f docker/Dockerfile.sandbox-k8s -t valet-sandbox:dind-dev .
docker run -d --name dind-smoke \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  --device /dev/fuse --env VALET_SANDBOX_DOCKER=1 \
  valet-sandbox:dind-dev sh -c "[ -f /start-headless.sh ] && exec /bin/bash /start-headless.sh || exec tail -f /dev/null"
sleep 8
docker exec dind-smoke docker run --rm hello-world
docker exec dind-smoke sh -c 'echo "FROM alpine:3.20\nRUN echo built" > /tmp/Dockerfile && docker build -t t1 -f /tmp/Dockerfile /tmp'
docker rm -f dind-smoke
```

Expected: hello-world output and a successful build. If the daemon does not come up, read `/var/log/valet/dockerd.log` (`docker exec dind-smoke cat /var/log/valet/dockerd.log`) and fix before continuing — common causes: missing `uidmap` (rootlesskit refuses), missing `iptables`, wrong `DOCKER_VERSION` pin string (check `apt-cache madison docker-ce` inside the image for the exact current pin).

- [ ] **Step 5: Also verify a non-docker container is unchanged**

```bash
docker run -d --name plain-smoke valet-sandbox:dind-dev sh -c "tail -f /dev/null"
docker exec plain-smoke sh -c 'pgrep dockerd && echo DAEMON-RUNNING || echo NO-DAEMON'
docker rm -f plain-smoke
```

Expected: `NO-DAEMON`.

- [ ] **Step 6: Commit**

```bash
git add docker/Dockerfile.sandbox-k8s docker/start-docker.sh docker/start-headless.sh docker/start-full.sh
git commit -m "feat(docker): bake dormant rootless docker toolchain into sandbox image"
```

---

### Task 5: `.valet/prebuild.yaml` — `docker` key

**Files:**
- Modify: `packages/api/src/prebuilds/recipe.ts` (`PrebuildOverride`, `loadPrebuildOverride`, `ResolvedRecipe`, `resolveRecipe`), `docs/prebuild-yaml.md`
- Test: `packages/api/src/prebuilds/recipe.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PrebuildOverride.docker?: boolean`; `ResolvedRecipe.docker?: boolean` (copied verbatim from the override by `resolveRecipe`). The identity hash (`canonicalRecipeJson(recipe, setup)`) must NOT change — `docker` stays out of it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/api/src/prebuilds/recipe.test.ts`:

```ts
describe("docker key", () => {
  const read = (yaml: string) => async (p: string) =>
    p === ".valet/prebuild.yaml" ? yaml : null;

  it("parses docker: true", async () => {
    const o = await loadPrebuildOverride(read("docker: true"));
    expect(o?.docker).toBe(true);
  });

  it("rejects a non-boolean docker value with a corrective error", async () => {
    await expect(loadPrebuildOverride(read("docker: yes please"))).rejects.toThrow(
      ".valet/prebuild.yaml: docker must be a boolean",
    );
  });

  it("does not leak into the identity hash inputs", async () => {
    // generateDockerfile's inputs are (baseImage, cloneUrl, commitSha,
    // recipe, setup) — docker is not among them, so two overrides that
    // differ only in `docker` must produce byte-identical Dockerfiles.
    const withDocker = await resolveRecipe([], read("setup: [x]\ndocker: true"));
    const without = await resolveRecipe([], read("setup: [x]"));
    const df = (r: ResolvedRecipe) =>
      generateDockerfile({
        baseImage: "b", cloneUrl: "u", commitSha: "s",
        recipe: r.recipe, setup: r.setup,
      });
    expect(df(withDocker)).toBe(df(without));
  });

  it("resolveRecipe forwards docker", async () => {
    const resolved = await resolveRecipe([], read("docker: true\nskipDetect: true"));
    expect(resolved.docker).toBe(true);
    expect(resolved.recipe).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/api test recipe`
Expected: FAIL.

- [ ] **Step 3: Implement**

`PrebuildOverride` gains `docker?: boolean;`. In `loadPrebuildOverride`, after the `skipDetect` block:

```ts
  if (obj.docker !== undefined) {
    if (typeof obj.docker !== "boolean") {
      throw new Error(".valet/prebuild.yaml: docker must be a boolean");
    }
    override.docker = obj.docker;
  }
```

`ResolvedRecipe` gains `docker?: boolean;` and `resolveRecipe` copies it: `...(override?.docker !== undefined ? { docker: override.docker } : {})`.

`docs/prebuild-yaml.md`: add a `### docker` section under Fields:

```markdown
### `docker`

Type: `boolean` (default `false`)

Set `true` to give this repo's sessions a rootless docker daemon inside the
sandbox. The daemon runs as a non-root user; the sandbox is never
privileged. Docker state is ephemeral — images pull again after the sandbox
restarts. See `docs/specs/2026-08-15-sandbox-docker-design.md`.
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @valet/api test recipe`
Expected: PASS, including all pre-existing identity-hash cases untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/prebuilds/recipe.ts packages/api/src/prebuilds/recipe.test.ts docs/prebuild-yaml.md
git commit -m "feat(api): docker key in .valet/prebuild.yaml override"
```

---

### Task 6: API — session-create `docker` flag through session meta

**Files:**
- Modify: `packages/api/migrations/pg/0000_app.sql` (agent_sessions table), `packages/api/src/schema/index.ts` (`agentSessions`), `packages/api/src/routes/sessions.ts` (~line 158 body validation + insert + row→wire mapping), `packages/api/src/engine/session-meta.ts` (`SessionMetaSource`, `loadSessionMeta`), `packages/api/src/engine/host.ts` (`SessionMeta` interface ~line 240, `buildSession` sandboxOpts ~line 600)
- Test: `packages/api/src/routes/sessions.test.ts` (or the api integration suite file that exercises session create — locate with `rg -l "profile" packages/api/src --glob '*test*'` and extend the same test that covers `profile`)

**Interfaces:**
- Consumes: `SandboxCreateOpts.docker` (Task 1).
- Produces: `agent_sessions.docker boolean NOT NULL DEFAULT false` column; `SessionMetaSource.docker?: boolean`; `SessionMeta.docker?: boolean`; `sandboxOpts.docker` set from meta. Task 7 ORs in the repo-config flag.

- [ ] **Step 1: Write the failing test**

In the same test file that asserts `profile` round-trips through session create, add:

```ts
it("accepts docker: true at session create and persists it", async () => {
  const res = await createSession({ workspace: "w", docker: true });
  expect(res.status).toBe(200);
  const row = await getSessionRow(res.id);
  expect(row.docker).toBe(true);
});

it("rejects a non-boolean docker value", async () => {
  const res = await createSessionRaw({ workspace: "w", docker: "yes" });
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("docker must be a boolean");
});
```

(Adapt helper names to the file's existing fixtures — copy exactly how the neighboring `profile` tests create sessions and read rows.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/api test sessions`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `0000_app.sql`: in `CREATE TABLE agent_sessions`, next to the `profile` column, add `docker boolean NOT NULL DEFAULT false,`.
2. `schema/index.ts`: in `agentSessions`, next to `profile`, add `docker: boolean("docker").notNull().default(false),` (import `boolean` from drizzle pg-core if not present).
3. `routes/sessions.ts`: next to the `profile` validation (~line 158):

```ts
  if (body.docker !== undefined && typeof body.docker !== "boolean") {
    return c.json({ error: "docker must be a boolean" }, 400);
  }
  const docker = body.docker === true;
```

Include `docker` in the insert values and in the row→wire mappings beside `profile` (lines ~294, ~340 pattern).
4. `session-meta.ts`: add `docker?: boolean;` to `SessionMetaSource`; in `loadSessionMeta`'s return add `...(src.docker !== undefined ? { docker: src.docker } : {}),`.
5. `host.ts`: add `docker?: boolean;` to `SessionMeta` (next to `profile`, same docblock style); in `buildSession`, extend `sandboxOpts`:

```ts
      ...(meta.docker ? { docker: true } : {}),
```

6. Reset dev state: `rm -rf ~/.valet/pg` (mandatory after editing 0000).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @valet/api test sessions && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/migrations/pg/0000_app.sql packages/api/src/schema/index.ts \
  packages/api/src/routes/sessions.ts packages/api/src/engine/session-meta.ts \
  packages/api/src/engine/host.ts
git commit -m "feat(api): docker flag on session create, threaded to SandboxCreateOpts"
```

---

### Task 7: Repo-config flag — resolve `.valet/prebuild.yaml` docker at session build

**Files:**
- Modify: `packages/api/src/bakes/source-service.ts` (new exported helper near `resolveRecipeFromGitHub` at line 281), `packages/api/src/engine/host.ts` (`buildSession`)
- Test: `packages/api/src/bakes/source-service.test.ts` (or create `packages/api/src/bakes/repo-docker-flag.test.ts` if source-service has no unit test file)

**Interfaces:**
- Consumes: `loadPrebuildOverride` (Task 5), the GitHub contents `read` mechanics already inside `resolveRecipeFromGitHub` (source-service.ts:281-293), `SessionMeta.docker` (Task 6).
- Produces: `export async function repoDockerFlag(deps: GitHubTokenDeps-shaped args matching resolveRecipeFromGitHub, apiToken: string, owner: string, repo: string, ref: string): Promise<boolean>` — reads only `.valet/prebuild.yaml`, returns `override?.docker === true`; caches per `owner/repo@ref` for 10 minutes (module-level `Map<string, { value: boolean; at: number }>`). Host: `sandboxOpts.docker = meta.docker || repoFlag`, best-effort (errors log and resolve `false`).

- [ ] **Step 1: Write the failing test**

Mock the same fetch/contents seam `resolveRecipeFromGitHub`'s existing tests mock (copy their fixture setup):

```ts
describe("repoDockerFlag", () => {
  it("true when .valet/prebuild.yaml has docker: true", async () => {
    stubContents({ ".valet/prebuild.yaml": "docker: true" });
    expect(await repoDockerFlag(deps, "tok", "o", "r", "main")).toBe(true);
  });

  it("false when the file is absent, and caches per ref", async () => {
    stubContents({});
    expect(await repoDockerFlag(deps, "tok", "o", "r", "main")).toBe(false);
    expect(contentsCallCount()).toBe(1);
    await repoDockerFlag(deps, "tok", "o", "r", "main");
    expect(contentsCallCount()).toBe(1); // cached
  });

  it("false on read errors (best-effort)", async () => {
    stubContentsError(500);
    expect(await repoDockerFlag(deps, "tok", "o", "r", "main")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @valet/api test source-service`
Expected: FAIL (helper missing).

- [ ] **Step 3: Implement**

In `source-service.ts`, factor the single-file contents read `resolveRecipeFromGitHub` already performs into a reusable inner function, then:

```ts
const repoDockerCache = new Map<string, { value: boolean; at: number }>();
const REPO_DOCKER_TTL_MS = 10 * 60 * 1000;

/** Best-effort read of `.valet/prebuild.yaml`'s `docker` key for a repo ref.
 * Errors (auth, rate limit, bad YAML) resolve false: the session still
 * starts, without docker. The session-create `docker` option is the
 * corrective override when the repo read cannot succeed. */
export async function repoDockerFlag(/* same dep/token/owner/repo args as resolveRecipeFromGitHub, plus ref */): Promise<boolean> {
  const key = `${owner}/${repo}@${ref}`;
  const hit = repoDockerCache.get(key);
  if (hit && Date.now() - hit.at < REPO_DOCKER_TTL_MS) return hit.value;
  let value = false;
  try {
    const override = await loadPrebuildOverride(readOneFileAtRef);
    value = override?.docker === true;
  } catch (err) {
    console.error(`repoDockerFlag: read failed for ${key}:`, err instanceof Error ? err.message : String(err));
  }
  repoDockerCache.set(key, { value, at: Date.now() });
  return value;
}
```

In `host.ts` `buildSession`, before `sandboxOpts` is assembled, resolve the flag (guard on `githubTokenDeps`/`db` exactly the way `buildCredentialResolver` does; mint the api token via the same `resolveSessionGitHubToken(purpose: "api")` path; primary repo = `meta.repos?.[0]`, `ref` = `repo.ref ?? "HEAD"`; non-GitHub hosts and repo-less sessions resolve `false`):

```ts
    const dockerFlag = meta.docker === true || (await this.resolveRepoDockerFlag(sessionId, meta));
```

and in `sandboxOpts`: replace Task 6's spread with `...(dockerFlag ? { docker: true } : {})`. `resolveRepoDockerFlag` is a small private method that wraps `repoDockerFlag` in try/catch → `false`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @valet/api test source-service && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/bakes/source-service.ts packages/api/src/engine/host.ts
git commit -m "feat(api): honor repo .valet/prebuild.yaml docker flag at session build"
```

---

### Task 8: E2e suite, security-model doc, full validation

**Files:**
- Create: `packages/sandbox-docker/test/dind.e2e.test.ts`
- Modify: `scripts/e2e/lib.ts` (SUITES array, docker group), `docs/security-model.md`

**Interfaces:**
- Consumes: everything above.
- Produces: e2e row `sandbox-dind` (`group: "docker"`, `needs: ["docker"]`); security-model subsection.

- [ ] **Step 1: Write the e2e test**

`packages/sandbox-docker/test/dind.e2e.test.ts` — follow the provider setup used in `docker-sandbox.test.ts` (same provider construction and cleanup), with the image from `VALET_SANDBOX_IMAGE` (skip when unset, since the default image has no toolchain):

```ts
import { describe, expect, it } from "vitest";
// reuse docker-sandbox.test.ts's provider fixture imports

const image = process.env.VALET_SANDBOX_IMAGE;

describe.skipIf(!image)("rootless docker-in-sandbox (e2e)", () => {
  it("builds and runs containers inside a docker:true sandbox", async () => {
    const sandbox = await provider.create({
      workspace: tmpWorkspace(),
      image,
      docker: true,
    });
    try {
      // Daemon startup is async; poll up to 30s.
      await waitFor(async () => (await sandbox.exec("docker version")).exitCode === 0, 30_000);
      const run = await sandbox.exec("docker run --rm hello-world");
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("Hello from Docker!");
      const build = await sandbox.exec(
        "mkdir -p /tmp/ctx && printf 'FROM alpine:3.20\\nRUN echo baked-ok\\n' > /tmp/ctx/Dockerfile && docker build /tmp/ctx",
      );
      expect(build.exitCode).toBe(0);
      const port = await sandbox.exec(
        "docker run -d -p 8099:80 --name web nginx:alpine && sleep 2 && curl -sf localhost:8099 | head -1",
      );
      expect(port.exitCode).toBe(0);
    } finally {
      await provider.destroy(sandbox.id);
    }
  });
});
```

(Adapt `sandbox.exec` to the actual `Sandbox.exec` signature in `packages/engine/src/types.ts` — check the return shape used by `docker-sandbox.test.ts` and match it exactly.)

- [ ] **Step 2: Register the e2e row**

In `scripts/e2e/lib.ts` SUITES, after the `sandbox-docker` row (line ~176):

```ts
  { id: "sandbox-dind", group: "docker", title: "rootless docker-in-sandbox", command: ["pnpm", "--filter", "@valet/sandbox-docker", "test", "test/dind.e2e.test.ts"], needs: ["docker"], timeoutMs: 15 * MIN },
```

- [ ] **Step 3: Run it**

```bash
docker build -f docker/Dockerfile.sandbox-k8s -t valet-sandbox:dind-dev .
VALET_SANDBOX_IMAGE=valet-sandbox:dind-dev make e2e E2E_ARGS="--only sandbox-dind"
```

Expected: green. Debug via `/var/log/valet/dockerd.log` in the container if not.

- [ ] **Step 4: Security-model doc**

Add to `docs/security-model.md`, after the sandbox isolation section:

```markdown
## Docker-in-sandbox (`docker: true`)

A session can request a rootless docker daemon inside its sandbox
(`docker: true` at session create, or `docker: true` in the repo's
`.valet/prebuild.yaml`). For that sandbox only, the provider relaxes:

- seccomp: unconfined (larger kernel syscall surface)
- AppArmor: unconfined
- adds the `/dev/fuse` device

It does NOT make the sandbox privileged, mount the host docker socket, or
add Linux capabilities. The daemon and all inner containers run inside the
sandbox's user namespace: an escape from an inner container lands in the
rootless daemon's user namespace, not on the host. The residual risk is
kernel attack surface through unconfined seccomp — the same trade the
rootless BuildKit build pods already accept. Sandboxes that do not opt in
are unchanged.
```

- [ ] **Step 5: Full validation**

```bash
pnpm typecheck
make e2e 2>&1 | tee /tmp/e2e-dind.log
```

Expected: clean scorecard (name any red row's unrelated environmental cause explicitly). Capture full output — no `tail`/`grep`.

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-docker/test/dind.e2e.test.ts scripts/e2e/lib.ts docs/security-model.md
git commit -m "test(e2e): rootless docker-in-sandbox suite + security-model docs"
```

---

### Task 9: Acceptance — valet's docker e2e inside a `docker: true` sandbox (manual)

**Files:** none (validation only, recorded in the PR description).

- [ ] **Step 1:** Start the dev stack with the DinD image: `VALET_SANDBOX_IMAGE=valet-sandbox:dind-dev make dev-local` (follow the CLAUDE.md clean-start checklist first).
- [ ] **Step 2:** Create a session on the valet repo with `docker: true` (the repo's `.valet/prebuild.yaml` `docker: true` from the prebuild-config PR also covers it once merged).
- [ ] **Step 3:** Inside the session, run `make e2e E2E_ARGS="--only sandbox-docker,store-postgres,prebuilds-docker"`.
- [ ] **Step 4:** Record the scorecard in the PR. Rows that fail for environmental reasons (no Anthropic key inside the sandbox, Docker Hub rate limits) are acceptable only with the cause named per row.
