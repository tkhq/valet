# Sandbox browser deployment

The managed browser needs Linux user namespaces and the reviewed seccomp profile.
Browser sessions can also enable Docker-in-sandbox or nested Kubernetes.
These sessions run the browser in a separate companion container.
The companion shares the workload network so it can reach development servers on localhost.
Only the companion mounts private browser state.
Its trusted upload broker receives a read-only working-directory mount.
Chromium and the REPL cannot access that mount.
The companion receives no workload credentials, Docker socket, or elevated Docker capabilities.

## Build and inspect the image

1. Build `docker/Dockerfile.sandbox-k8s` from the repository root.
2. Set `VALET_SANDBOX_IMAGE` to the resulting image reference.
3. Set `VALET_BROWSER_ENABLED=1` after installing the image and seccomp profile.
4. Use an immutable registry digest for a deployment.
5. Check `/opt/valet/browser/runtime-manifest.json` inside the image.

The companion uses `VALET_FULL_BASE_IMAGE`, then `VALET_SANDBOX_IMAGE`, then the published default image.
Set `VALET_FULL_BASE_IMAGE` to a browser-capable stock image, including when repository bakes use older images.
Helm exposes this setting as `sandbox.fullBaseImage`.
Repository bakes do not select the companion image.
Rebuild the stock image for this release before enabling combined sessions.
The preflight must support the companion's read-only upload mount.

Set Helm `sandbox.browserEnabled=true` after installing the managed image and node profile.
The chart keeps this value disabled by default.
Docker keeps browser support off until explicitly enabled, so plain coding images continue to work.

The image pins Node 22.23.3 and Playwright Core 1.63.0.
Playwright installs its matching Chromium revision 1243 with `--no-shell`.
The managed runtime selects `channel: chromium`.
The legacy `agent-browser` command uses the same executable with a separate profile.
The image installs no browsers at session startup.
The local and virtual providers do not expose the managed browser runtime.

## Prepare Kubernetes nodes

1. Copy this repository's `deploy/install-browser-seccomp.sh` and `packages/sandbox-docker/seccomp/browser.json` to each sandbox node.
2. Run `sudo ./deploy/install-browser-seccomp.sh /var/lib/kubelet/seccomp` on each node.
3. If kubelet uses another root directory, pass its seccomp directory instead.
4. Set Helm `sandbox.browserSeccompProfile` to `valet/browser.json`.
5. Set Helm `sandbox.browserRuntimeStorage` to the private storage request, which defaults to `2Gi`.
6. Restart browser sandboxes after a profile change.

The chart does not install node files or change kernel settings.
The kubelet must permit unprivileged user namespaces.
A missing profile prevents the pod from starting.
A failed namespace probe prevents pod readiness.
Do not substitute an unconfined profile.

Combined pods keep the workload's Docker runtime class and `hostUsers: false` setting.
The browser container retains its Localhost seccomp profile.
The pod does not mount a Kubernetes service-account token.
The companion requests 100m CPU, 256Mi memory, and 256Mi ephemeral storage.
Its limits are one CPU, 2Gi memory, and 2Gi ephemeral storage.
These resources are additional to the workload's resource settings.
Readiness checks both containers and their requested browser configuration.

The API creates a session-owned private PVC separately from the Sandbox CR.
CR replacement and suspension retain that PVC.
Final session deletion flushes the audit records before deleting it.
A missing adopted PVC is an error; the provider does not silently replace it.

## Docker state and identities

Docker stores inventory and private state beneath `~/.valet/docker-runtime` by default.
If `VALET_DATA_DIR` is set, the API uses its `docker-runtime` subdirectory instead.
Each API instance must retain its own data directory across restarts.
The provider mounts private state at `/var/lib/valet` separately from `/workspace`.
It validates daemon identity, labels, image identity, and mount paths before adoption.
An API restart adopts the existing containers.
Combined sessions record each container's role, image, and identity.
The browser must share the exact recorded workload network namespace.
Docker limits the companion to two CPUs, 2Gi memory, and 256Mi shared memory.
The provider removes the browser before removing its workload network owner.
If companion creation fails, the provider retains its ownership record for explicit release.
Release that runtime before retrying creation.
Existing Docker-only sessions gain a companion when the host next provisions them.
The provider retains their working directory and reserves fresh private browser state.
It does not trust files from the old workload-mounted state directory as browser state.
Final deletion also removes that old state directory.
Execution-environment release retains private state; final session deletion removes it.
A stopped Docker owner exports its audit through a network-disabled helper before deletion.
The helper reads a private SQLite copy and never starts Chromium.
A shared owner lock prevents concurrent daemon access.
Incomplete audit export blocks final deletion.

All ordinary Docker file APIs execute inside the container.
A symlink cannot expose a host path that the container does not mount.
Single-container browser shell commands and ordinary file APIs run as UID 1500.
Combined sessions keep the workload's existing Docker identity and execution rules.
The browser daemon uses a separate identity and private directories with mode `0700`.
Docker maps that identity to the API process UID for retained-state access.
Kubernetes uses UID 1501.
The root-owned browser client drops to that identity and clears its environment.
The workload cannot call that client as the daemon owner.
The terminal and editor also use the workload identity.

Single-container startup assigns `/workspace` to the workload user.
Before its Docker release or deletion, the provider restores ownership to the API process.
The provider does not follow working-directory symlinks during ownership changes.
Ordinary file APIs cannot read browser state.
The trusted browser export reader permits only validated transfer files.

The browser broker permits approved public origins and bounded local development ports.
The default development ports are `5173`, `3000`, and `8080`.
Provider configuration can set `VALET_BROWSER_DEV_PORTS` explicitly.
The gateway and interactive-service ports are outside that default set.

## Browser command transport

Docker and Kubernetes keep one private exec stream open for active browser requests.
The stream uses the existing provider authentication and private browser identity.
Trusted commands select the browser execution target explicitly.
The provider rejects a missing or invalid companion instead of executing in the workload.
Socket checks, audit reads, and evidence transfers use the same target.
It requires no public browser port or gateway permission change.
Idle connections close automatically. In-flight mutations are never replayed after a connection failure.
Rebuild the sandbox image when updating the API to this transport version.
Existing containers must use the rebuilt runtime before they can serve inline preview frames.
