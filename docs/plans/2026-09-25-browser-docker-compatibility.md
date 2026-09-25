# Browser and Docker compatibility implementation plan

> Use the executing-plans and test-driven-development skills for each implementation task.

**Goal:** TKAI-562: children on Docker-enabled repositories can use the managed browser and Docker in the same session.

**Architecture:** Keep ordinary browser sessions on their existing runtime. When Docker or nested Kubernetes is enabled, put the browser in a companion container. Share the workload network, but give only the browser container its private state volume. Route trusted browser operations explicitly through the provider.

**Tech stack:** TypeScript, existing Sandbox contracts, Docker CLI, Kubernetes Sandbox CRs, existing Chromium and browser broker.

## Contracts and boundaries

- Add `target?: "browser"` to `ExecOpts` and `SandboxCommandChannelOptions`. Absence continues to select the workload.
- Only trusted browser calls set the target and `privileged: true`. A provider rejects a browser target when no browser was provisioned.
- The policy wrapper forwards the target. Browser RPC, evidence reads, socket probes, and lifecycle hooks use it.
- Kubernetes adds a `browser` container for the combined mode. Its private PVC is absent from the workload. Its seccomp profile stays Localhost. It receives no workload credentials or elevated capabilities.
- Docker records a companion container in its durable inventory. The companion shares the workload network namespace. It receives a read-only working-directory mount for the trusted upload broker. It receives no credential or Docker socket mount. Chromium and the REPL cannot access the working directory.
- Companions use the configured stock browser-capable image, not the repository bake. The existing preflight initializes private state. No new public control port is added.
- The companion starts with tini, runs `/browser-preflight.sh`, and idles for the lazy browser client. It does not run the workload startup scripts or a gateway, and receives no `VALET_BROWSER_VIEWER` flag.
- Existing single-container browser records remain supported. Adopted combined runtimes must converge to the new container topology before reporting ready.
- Kubernetes readiness and drift compare the browser container image and topology in addition to the workload generation. Docker adoption checks both live owners and the companion network attachment. Partial creation retains ownership records for explicit recovery.
- The stopped Docker audit reader uses the recorded companion image. Never use a repository image to read the companion journal.
- Suspension and replacement retain browser state. Final deletion removes both containers and private state after the existing audit flush.
- Browser access is no longer suppressed by Docker or nested Kubernetes flags. Provider capability and policy checks remain authoritative.

## Tasks

### 1. Browser transport target

Files: `packages/engine/src/types.ts`, `packages/engine/src/sandbox/policy.ts`, `packages/plugin-browser/src/client.ts`, `packages/plugin-browser/src/channel.ts`, `packages/api/src/routes/browser.ts`, `packages/api/src/services/browser-host.ts` and their tests.

- [x] Add a failing policy-wrapper test proving browser targets reach the underlying provider.
- [x] Add the contract and forward the target without changing cancellation or retry semantics.
- [x] Route every trusted browser command and export through the browser target.
- [x] Run engine, browser plugin, browser route, and browser lifecycle tests.

### 2. Kubernetes companion

Files: `packages/sandbox-kubernetes/src/manifest.ts`, `types.ts`, `provider.ts`, `lifecycle.ts`, and browser/provider tests.

- [x] Write failing manifest tests for browser plus Docker and browser plus nested Kubernetes.
- [x] Add the companion with private volume, reviewed profile, bounded resources, and stock image.
- [x] Route browser exec/channel operations to the companion while normal operations stay in `sandbox`.
- [x] Cover restore, adoption, readiness, replacement, and retained-state lifecycle.
- [ ] Run a local cluster test with a real Docker command and browser navigation to a workload HTTP fixture.

### 3. Docker companion

Files: `packages/sandbox-docker/src/sandbox.ts`, `inventory.ts`, a focused companion module, and Docker tests.

- [x] Write failing tests for container arguments, inventory validation, and target routing.
- [x] Add companion creation with shared network, private state, and a read-only working-directory mount.
- [x] Validate identity, network ownership, mounts, and image when adopting either container.
- [x] Stop/remove the companion on release or deletion; preserve state until final deletion.
- [x] Test real Docker execution, browser navigation, screenshot/export, adoption, replacement, and isolation.

### 4. Host behavior and release validation

Files: `packages/api/src/engine/host.ts`, host tests, `packages/api/src/routes/browser.ts`, `deploy/browser.md`, browser design specification.

- [x] Add failing tests that Docker-enabled repository children retain browser automation.
- [x] Remove Docker/nested Kubernetes suppression in host and browser API availability checks.
- [x] Document companion resources, deployment image requirements, and security boundaries.
- [x] Run targeted suites and `make e2e`, preserving the full output.
- [ ] Review the final diff, create one PR against `dev-v2`, and attach it to this task.

## Validation constraints

Rancher Desktop uses cri-dockerd on this host. The combined pod was admitted, but the runtime rejected `hostUsers: false`. Its `crun` handler does not support pod user namespaces. The ordinary browser lifecycle passed on this cluster. The combined fixture remains available through `VALET_BROWSER_K8S_DOCKER=1` on a compatible local runtime.

Adversarial review also found an existing namespace-proxy crash when a client resets during the origin handshake. Add connection-lifecycle regression coverage and close both sockets without stopping the proxy.
