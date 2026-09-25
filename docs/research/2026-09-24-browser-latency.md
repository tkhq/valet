# Browser approval and latency validation

## Local benchmark

Run `scripts/browser-latency.mts` from the repository root with `pnpm exec tsx`.
Set `VALET_BROWSER_TEST_IMAGE` to a rebuilt sandbox image.
Set `VALET_BROWSER_BENCH_MODE=exec` for the original process-per-command path, or `channel` for the persistent path.
The script creates and deletes a disposable sandbox and fixture. It records 30 samples for each operation.

| Operation | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Status command | 51.53 ms | 0.92 ms | 60.34 ms | 7.68 ms |
| Keyboard event | 55.66 ms | 2.22 ms | 69.99 ms | 5.68 ms |
| Complete preview frame | 182.46 ms | 32.88 ms | 220.81 ms | 37.46 ms |

Thirty keyboard events took 1,719 ms before and 81 ms after the change.
The old preview also waited 250 ms after each frame. The new viewer starts frames at most once per 100 ms.
These are warm local Docker measurements on one fixture, not production network latency or model response time.
The preview remains bounded JPEG polling. It does not stream video.

## Approval regression

The real Docker HTTP integration executes navigation, reload, form fill, button clicks, and screenshot capture without routine approval prompts.
The same turn requests one explicit content export. The test requires exactly one approval, named `Browser: tab.export`.
Policy unit tests retain owner, membership, enabled-state, version, expiry, and grant checks.
The browser skill requires the existing `ask_approval` tool for consequential effects that lack prior user authorization.
Low-level method classes do not detect every click's business consequences.

## Lifecycle checks

HTTP requests now use the session's policy sandbox, which rejects replies after attachment replacement.
A regression reproduced the stale HTTP 200 response before the fix and requires HTTP 409 afterward.
Agent first-touch requests await cold or provisioning compute. Passive viewer requests cannot provision or resume compute.
Canceled callers retain remote request slots until a reply arrives. Connection loss never causes automatic mutation replay.
Runtime tests reject frames that span navigation, runtime replacement, or private sign-in transitions.

## Hands-on checks

The local UI passed individual keystrokes, form submission, drag-and-drop, wheel scrolling, reload, Back, Forward, and prompt-dialog response checks.
The floating preview passed minimize, restore, close, and full Browser view checks. Restoring it retained the selected page and resumed frames.
A real agent turn reloaded the existing landing page, read its title, and captured screenshot evidence without an approval prompt.
The tool reported 135 ms for reload, 44 ms for title retrieval, and 182 ms for screenshot capture, totaling 361 ms.
These timings measure operations within one browser tool call. They exclude model response time.
The screenshot rendered in the tool card, and the existing page remained open.

A prompt left open beyond the 35-second deadline caused an uncertain-outcome error, as designed.
The dialog response opened a new connection, resolved the prompt, and restored the preview.
This transport change does not remove page loading time, model latency, or the fixed browser viewport.

## Final checks

`VALET_BROWSER_TEST_IMAGE=valet-sandbox-browser:local make e2e` completed with **33 passed, 0 failed, and 4 skipped**.
The run included runtime, plugin, engine, HTTP, Docker, real Kubernetes, production build, and real-model checks.
The four skips require fullstack Kubernetes opt-in, Telegram credentials, GitHub App credentials, or a 1Password service-account token.
The complete output was captured with `tee` at `/tmp/valet-browser-latency-e2e-final.log`.
The earlier run exposed a test-only TypeScript narrowing error. The final run includes its correction.
The chart version is `0.10.17`, which was absent from the registry during validation.
Independent reviews covered transport bounds, attachment replacement, passive viewer behavior, cold startup, and Kubernetes upgrade cancellation.
