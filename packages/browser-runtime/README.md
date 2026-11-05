# Sandbox browser runtime

The daemon owns one Chromium profile and one SQLite journal per session.
The fixed client accepts one JSON request on stdin. It sends that request through
`/var/lib/valet/browser/browser.sock`. Model source never enters shell arguments.

`valet-browser-client` starts the daemon lazily. A kernel `flock` lock prevents
concurrent daemon owners. Runtime state uses `/var/lib/valet/browser` by default.
`VALET_BROWSER_STATE` can select another private directory.

## Production setup

1. Build this package and deploy its production dependencies.
2. Install Chromium with this package's pinned Playwright release.
3. Run the daemon as the dedicated browser UID.
4. Set `VALET_BROWSER_ENABLED=1` and `VALET_BROWSER_CONFINE=1`.
5. Set `VALET_SESSION_ID` to the sandbox's owning session.
6. Set `VALET_BROWSER_DEV_PORTS` to approved development ports, separated by commas.

The provider must install the reviewed container seccomp profile. It must keep
the coding workload UID separate from the browser UID. Only the privileged host
client can use the private control socket and exported transfer files.

The runtime uses Bubblewrap user, mount, IPC, PID, and network isolation for the
REPL. It exposes no profile, journal, working directory, or host socket to cells.
A child seccomp filter blocks process forks, new namespaces, tracing, and selected
kernel interfaces. Resource limits bound data memory, CPU, and open files.
The V8 heap uses a smaller limit to leave space for native allocations.

Chromium retains its renderer sandbox. Its network namespace reaches a private
Unix broker through an internal HTTP proxy. The broker validates resolved IPs
before connecting. Public traffic requires an approved HTTPS origin. Development
traffic requires an approved loopback port. Revocation closes existing connections.

## Client contract

Requests use the shared `BrowserRequest` union. The host supplies session, thread,
actor, owner, and audience identities. The model supplies cell source and title.
`submit` attaches to the durable invocation ID. It does not rerun an existing cell.
`events` reads bounded batches. A gap requires receipt inspection.

Each facade operation pauses before dispatch and emits an approval request.
`resolve` binds the operation hash, policy version, runtime, actor, and page state.
The journal commits `in_flight` before dispatch. Recovery marks incomplete effects
uncertain. Recovery never repeats an effect.

`export` returns a private transfer path, byte count, MIME type, and SHA-256 hash.
The host reads bytes through the sandbox binary API. The host then sends `ack`.
Viewer frames are ephemeral JPEG transfers. Saved evidence uses PNG artifacts.
Each viewer retains at most two queued frames.

`revoke` closes browser execution and network access. The production transport
then exits. The next authorized host call starts a new runtime with fresh grants.
`turn_end` closes only temporary tabs owned by the thread. Human control defers
that cleanup until explicit release.

## Capabilities and limits

The method registry generates the runtime reference. Locator queries remain
serializable until execution. Single-element actions reject ambiguous matches.
ARIA observations include opaque, thread-owned references. References fail after
navigation, node replacement, changed semantics, or control handoff.

`playwright.evaluate` reads a detached LinkeDOM observation in the confined child.
It cannot evaluate source in the live page. Unsupported DOM properties throw.
Open shadow content appears inside `valet-shadow-root` snapshot boundaries.

The viewer uses bounded screenshot polling. It does not claim CDP screencast
support. HTML clipboard transfer and native browser dialogs are unavailable.
The WebMCP adapter detects `document.modelContext`. It reports unavailable until
the browser exposes a verified discovery and invocation contract.

Cells retain Node REPL bindings and support top-level await. Lexical redeclaration
throws. `reset` discards the thread's bindings. Observations emit automatically;
use `output.write` for other returned values. Approval wait time does not consume
the normal cell deadline. The process CPU limit remains active during that wait.

## Validation

Run `pnpm --filter @valet/browser-runtime test` for protocol, journal, subprocess,
control, file, proxy, and browser fixtures. Browser fixtures use the pinned Chromium
build. They skip when it is absent. Set `VALET_BROWSER_REQUIRE_REAL=1` to require it.
Linux confinement and provider identity tests run against the built sandbox image.
