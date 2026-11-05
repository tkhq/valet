# Browser interaction latency

## Problem and measurements

The viewer launches three sandbox processes for each JPEG: capture, read, and acknowledge.
The frontend then waits 250 ms. Each input also launches a client process.
On the local Docker fixture, 12 samples gave these medians:

| Operation | Median |
| --- | ---: |
| Sandbox status command | 49.3 ms |
| Capture, read, acknowledge | 159.1 ms |
| HTTP status | 73.2 ms |
| HTTP frame | 152.2 ms |

A queued keydown and keyup each pay the command cost. This makes typing lag behind the user.

## Design

Add an optional portable `Sandbox.openCommandChannel(command, options)` method.
It returns `SandboxCommandChannel | null`. The channel has asynchronous `write(string)` and synchronous `close()` methods.
Options supply `onData(string)`, `onClose(Error?)`, and optional `privileged`, `waitForReady`, and abort signal fields.
Agent calls await sandbox readiness. Viewer connections set `waitForReady=false` and cannot wake compute.
Docker uses one interactive exec process. Kubernetes uses one pods/exec WebSocket with an open stdin stream.
HTTP and agent calls use the session policy sandbox and share its connection.
The policy wrapper fences writes and incoming replies against sandbox replacement.
It closes channels when their attachment leaves the ready state, including suspend and destroy.
Providers retain the existing workload identity rules. The browser client still drops to its private user.

The host plugin opens `/usr/local/bin/valet-browser-client --stream`.
Each newline-delimited JSON envelope has an `id` and `request`. Each reply has the same `id` and a `response`.
The client accepts at most 16 concurrent requests. Each request is limited to 512,000 bytes; replies are limited to 1,000,000 bytes.
Requests run concurrently so event polls and frames cannot block input or dialog replies.
The host keeps one connection per sandbox object. It closes after 30 seconds with no pending requests.
The remote client exits after 45 seconds without active requests or traffic, or when stdin closes.
Kubernetes abort and startup timeout terminate the actual WebSocket upgrade. Late authentication cannot create a new connection.
These timers release an owned idle transport. They do not repair sandbox state.
The host reserves four slots for dialog replies, approval resolution, cancellation, and control.
It rejects excess requests immediately instead of accumulating an unbounded queue.
A canceled caller retains its request ID and slot until its reply arrives.
A 35-second request deadline closes the connection and rejects all pending operations.
A lost connection rejects pending operations. The host never replays a mutation after a write.
Later requests may open a new connection. Providers without channel support keep the existing single-request path.

Add an optional `inline` flag to frame requests and a bounded `frame` response field.
The daemon captures a JPEG directly into that response with document, viewport, size, and SHA-256 metadata.
JPEG data is limited to 700,000 bytes to leave room for base64 encoding and envelope metadata.
The host validates identity, size, canonical base64, JPEG signature, digest, and MIME type. This avoids transfer files for live preview.
Durable screenshots, downloads, and evidence retain their existing file broker and integrity checks.
Private mode and runtime checks apply before and after capture and viewport retrieval.
A control generation change rejects captures that span private sign-in transitions. Reject frames from a changed document.
No browser transport port, raw CDP endpoint, or new browser authority is exposed.
All HTTP and agent requests retain their existing session authorization and control checks.
The browser chart changes use version `0.10.17`; version `0.10.16` is already published.

Frame polling starts at most once per 100 ms and permits only one request in flight.
Slow frames consume that interval rather than adding another fixed delay.
Hidden and unmounted viewers stop polling. Failed input remains fail-stop and is never retried automatically.
The existing input queue preserves keyboard, pointer, IME, and dialog semantics.

## Validation

Test channel identity, ordering, concurrent replies, cancellation, size limits, disconnects, idle cleanup, and sandbox replacement.
Test inline frame integrity, private mode, document changes, and transport limits.
Test frame cadence and abort behavior with fake timers.
Measure the same local status and frame paths after rebuilding the sandbox image.
Dogfood typing, pointer controls, navigation, dialogs, and the floating preview.
Run focused tests, real Docker integration, Kubernetes channel coverage, and the full `make e2e` scorecard.
