# Browser harness research

Date: 2026-09-23, America/Los_Angeles. Some tool timestamps are 2026-09-24 UTC.
Purpose: support the [sandbox browser design](../specs/2026-09-23-sandbox-browser-design.md).

This report distinguishes observed behavior, supplied interface documentation,
public upstream sources and design recommendations. It does not describe private
Codex implementation code. No Valet runtime feature was implemented during this
research.

## 1. Method and evidence limits

The Codex session exposes a persistent JavaScript tool named `mcp__cua_repl.js`.
Connecting to the browser returns interface documentation and an initial
accessibility observation. Further documentation is available through documented
capability and topic methods.

Research used the in-app browser, public OpenAI documentation and a disposable
localhost fixture. The fixture contained text input, buttons, a status region,
collapsed controls, a same-origin iframe, an open shadow root and a canvas. It was
served only on loopback. Temporary research tabs and the server were closed.

The research did not inspect personal browsing history, user tabs, credentials,
hidden runtime files, private browser source or undocumented object internals.
It did not test external-browser extensions, privileged CDP, cross-origin frames,
actual uploads, financial workflows or recovery after killing the Codex runtime.

## 2. Live harness findings

| Check | Evidence | Design implication |
| --- | --- | --- |
| Persistent handles | A tab binding created in one tool call worked in later calls | Keep browser/REPL state across model tool calls |
| Background creation | `cua.createBrowserTab("1", url, {visible:false})` created readable tabs | Observation must not require a visible user panel |
| Initial observation | Tab creation emitted URL, title and numbered accessibility nodes | Bootstrap can return documentation and useful state together |
| Form interaction | `setValue(5,"Valet")`, then `click(6)`, changed the status to `Hello, Valet` | Element actions need a fresh verification observation |
| Reference continuity | Existing indices stayed; changed status text received a new index | Reference identity is more useful than positional enumeration |
| Diff behavior | This fixture still returned a full tree after changes | Documentation permits diffs; do not promise every response is a diff |
| Accessibility coverage | Iframe content and an open shadow-root button appeared in the tree | Frames and open shadows belong in conformance fixtures |
| Visual coverage | Canvas appeared as `image Painted rectangle`; pixels showed a blue rectangle | Semantic text cannot replace screenshots |
| DOM coverage | The DOM snapshot included select options inside a collapsed details control | DOM presence does not prove visual visibility |
| Secondary actions | The tree advertised Expand; invoking it expanded the details control | Only expose supported actions; do not guess action strings |
| Frame locator | The iframe-scoped button locator returned count 1 | Preserve frame scoping in the SDK |
| Shadow locator | Role-based shadow-button locator returned count 1 | Public locator support can avoid custom traversal code |
| Text field visibility | Label-based visibility query returned true | Expose explicit visibility queries |
| Evaluation | Read-only calls returned document title, status text and a canvas label | Offer structured extraction with a defined scope |
| Console capture | `tab.dev.logs` returned `Applied name` with level/time/URL | Use bounded diagnostic buffers |
| Screenshot | Returned a 1280 by 720 rendered image | Image observation is a separate model input |
| Capabilities | Browser listed visibility and viewport; tab listed pageAssets and webmcp | Negotiate backend features rather than assume them |
| Website tools | OpenAI docs exposed search and lookup tools; both returned results | WebMCP can replace repeated UI traversal |
| Missing capability docs | `webmcp.documentation()` returned documentation unavailable | Missing optional docs must not crash unrelated capability discovery |
| Unsupported export | `fixtureTab.content.export()` failed: in-app browser does not support `tab_content_export` | A method in the shared TypeScript surface does not prove backend support |

The screenshot and text observations were consistent about the visible form.
The screenshot exposed layout and canvas content that the text representations
did not encode. No inference about Codex's internal screenshot or AX implementation
is justified by this comparison.

### Actual accessibility excerpt

```text
0 AXWebArea Valet browser research fixture
  1 heading Browser observation fixture
  5 text field (settable) Name, Value: Valet, ID: name
  6 button Apply name, ID: apply
  20 text Hello, Valet
  9 button (collapsed) More controls, Secondary Actions: Expand
  13 container Nested frame
    14 AXWebArea about:srcdoc
      17 button Frame button
  18 button Shadow button
  19 image Painted rectangle
```

This is an agent observation, not a live video feed. Screenshots are requested
separately. The runtime recommends observing again after interactions and treats
indices as dependent on current state.

## 3. Documented harness surface

These methods were present in supplied runtime documentation. Unless listed in
the previous table, they were not verified by executing them.

### Control entry points

- `cua.getState`, `listBrowsers`, `listTabs`, `getBrowser`, `getTab` and
  `createBrowserTab` discover or bind surfaces.
- Tab selection can use an ID, URL or explicit conversation tab mention.
- Browser metadata distinguishes in-app, extension and CDP backends.
- The JavaScript REPL retains bindings between calls. Reset discards bindings,
  but does not inherently close tabs or erase browser state.

### Observation and input

- `getAXState`, `getScreenshot`, `getAXStateAndScreenshot`.
- Click by index or coordinates; drag; scroll; select text; set a value.
- Type, paste and press keys into a named element or current focus.
- Secondary accessibility actions, such as expand and collapse.
- Navigation, tab closing, and marks that preserve agent-created tabs.

The facade spans native apps as well as browsers. Valet's requested scope needs
the browser subset, not platform-specific native app accessibility automation.

### Playwright-style surface

- DOM snapshot and documented read-only evaluation.
- Role, label, placeholder, text, test ID and selector locators.
- Nested frame locators and composable locator filters.
- Click, fill, check, select, keyboard actions and state/text reads.
- Bounded navigation, load-state, URL, filechooser and download waits.

The documentation describes a subset. It does not grant arbitrary Playwright,
Node, network or Chrome DevTools Protocol access.

### Optional features

| Feature | Documented contract |
| --- | --- |
| Visibility | Get/set whether the browser is presented to the user |
| Viewport | Explicit width/height override and reset |
| Page assets | Inventory observed assets; bundle by inventory and asset IDs |
| WebMCP | Discover page-bound tool schemas; call named tools with inputs |
| Console | Filter captured logs by severity, text and count |
| Dialogs | Inspect alert/confirm/prompt/beforeunload; accept or dismiss |
| Clipboard | Text or typed items with MIME metadata |
| History | Date bounds, query terms and result limit |
| Export | Generic page export; named GSuite formats; YouTube transcript |
| Screenshot | Viewport, full page or clip rectangle |
| Upload | Arm filechooser, click control, set absolute file paths |

The public OpenAI page says built-in browser upload automation is unavailable,
while shared runtime documentation describes a filechooser API. This was not
resolved by an upload test. Treat the difference as backend/version uncertainty.
The export failure is direct evidence that such mismatches occur.

## 4. OpenAI documentation

The official [Browser page](https://learn.chatgpt.com/docs/browser) was read through
its page-defined `lookup_page` tool. It describes a separate built-in browser
profile, shared page viewing, browser comments, developer mode and managed controls.

The official [Browser extension page](https://learn.chatgpt.com/docs/chrome-extension)
describes access to existing signed-in browser tabs through supported extensions.
It is evidence for an additional product surface, not a requirement to add a
desktop extension to Valet's sandbox browser.

The [developer-mode section](https://learn.chatgpt.com/docs/browser#app-developer-mode)
describes separately enabled full CDP access. Ordinary browser capabilities do
not establish that this mode is available. Valet should likewise keep privileged
diagnostics distinct from routine browser operations.

## 5. Public software research

### Playwright version and browser pairing

The npm registry returned stable `1.63.0` for both
[playwright](https://registry.npmjs.org/playwright/latest) and
[playwright-core](https://registry.npmjs.org/playwright-core/latest).
The tagged [browser manifest](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/browsers.json)
specifies Chromium revision `1243`, version `153.0.8010.12`.

The registry returned `@playwright/mcp` version `0.0.82`, depending on
`1.64.0-alpha-1789764292000`. The
[MCP registry record](https://registry.npmjs.org/@playwright%2Fmcp/latest) is a
moving URL; the values above record what the research retrieved. This supports
pinning stable Playwright directly instead of following MCP latest.

The [connectOverCDP documentation](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)
explicitly calls it significantly lower fidelity than Playwright's native
connection. Let the daemon launch and own Playwright, then use selected CDP
sessions for supplementary features.

### Public snapshot APIs

[Locator documentation](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot)
and [tagged 1.63.0 documentation](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-locator.md)
provide AI snapshot mode and depth from 1.59, boxes from 1.60, and structured
`ariaSnapshotJSON` from 1.63. These were also checked in the
[tagged public types](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/types/types.d.ts).

The [snapshot implementation](https://github.com/microsoft/playwright/blob/v1.63.0/packages/injected/src/ariaSnapshot.ts)
uses DOM traversal and ARIA computations. It is not a native CDP AX snapshot.
The [injected selector implementation](https://github.com/microsoft/playwright/blob/v1.63.0/packages/injected/src/injectedScript.ts)
implements `aria-ref` using the last snapshot map and node connectivity.

A new snapshot can replace the map. A connected node can change its role or label
between observations. This requires Valet-owned identity, revalidation and stale
errors. Do not expose `aria-ref` syntax as a stable Valet public contract. Its
presence in upstream source is weaker than a public selector compatibility promise.

Playwright and Playwright MCP are Apache-2.0. Preserve notices for any copied
implementation. Prefer public APIs over vendored snapshot internals.

### CDP observation, input and video

- [Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/):
  native AX nodes and backend DOM IDs; experimental methods and overhead caveats.
- [Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/):
  mouse, keyboard, touch and text input; mouse coordinates use viewport CSS pixels.
- [Page screencast](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast):
  encoded page frames and acknowledgments; experimental API.
- [Runtime evaluation](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-evaluate):
  `throwOnSideEffect` rejects cases where effects cannot be ruled out. It does not
  establish a general read-only DOM interpreter with full compatibility.

CDP page streaming does not provide native browser chrome or audio. A viewer must
implement tabs, navigation and browser-event controls. Backpressure and coordinate
transforms are protocol requirements, not cosmetic UI details.

[noVNC](https://github.com/novnc/noVNC) supplies a browser VNC client. It still needs
a display, VNC server and WebSocket transport. Its primary license is MPL-2.0.
[WebRTC](https://webrtc.org/getting-started/peer-connections) needs an application
capture/encoding pipeline and signaling; it is not a replacement browser server.

### JavaScript execution

[Node REPL documentation](https://nodejs.org/api/repl.html#await-keyword) describes
persistent declarations and top-level await, including const lexical limitations.
The [Node VM documentation](https://nodejs.org/api/vm.html) explicitly says it is
not a security mechanism and must not be used to run untrusted code.

Use a separate confined process if selecting Node's REPL. A same-user child with
normal filesystem/network access is not sufficient isolation. Test programmatic
cell framing and completion with the exact Node release before committing to the
adapter; top-level-await behavior alone does not supply the whole tool protocol.

[QuickJS](https://bellard.org/quickjs/quickjs.html) and
[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) offer explicit
host APIs, memory limits and interrupts. They are MIT licensed. Ordinary promises
with explicit job pumping are preferable to treating Asyncify as a generic
multi-request runtime.

Asyncify suspends the whole WASM module and allows only one pending asynchronous
suspension. Reentrant suspensions have documented hazards. `evalCodeAsync` does
not automatically create persistent top-level-await lexical semantics.

[isolated-vm](https://github.com/laverdet/isolated-vm) is in maintenance mode and
has native V8 compatibility and reference-leak concerns. Its own guidance favors
a separate process. It is not the recommended foundation here.

[Bubblewrap's documentation](https://github.com/containers/bubblewrap) describes
user, mount, PID, IPC and network namespaces, seccomp and a minimal filesystem.
It also states that Bubblewrap is not a complete sandbox policy. Valet must own
the arguments, mounts, file descriptors, syscall policy and tests. Unprivileged
user namespaces must work in the target provider; do not assume they do.

### Browser sandbox and network policy

[Playwright Docker guidance](https://playwright.dev/docs/docker) explains that
root disables Chromium's sandbox. The browser launch options document
`chromiumSandbox` as false by default. Run non-root and enable it explicitly.
Test user namespaces, seccomp and shared memory under the actual deployment.

Browser URL allowlists and request routing are not sufficient network boundaries.
Redirects, service workers, DNS rebinding and other transports need lower-layer
controls. The Playwright MCP documentation itself warns that its origin lists
are not security boundaries and do not cover redirects.

### WebMCP status

The [WebMCP specification](https://webmachinelearning.github.io/webmcp/), dated
17 September 2026 when inspected, calls itself a Draft Community Group Report,
not a W3C Standard or Standards Track document.

[Implementation status](https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md)
lists Chrome and Edge origin trials. The
[Chrome announcement](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
describes an experimental, time-limited trial. Current proposal text uses
`document.modelContext`. Older `navigator.modelContext` examples are not a safe
contract to freeze.

WebMCP must be feature-detected, versioned and optional in the runtime manifest.
Site-provided tools remain site code with potentially consequential effects.

## 6. Valet integration findings

The repository was inspected with unrelated working-tree changes present. The
following files are current v2 integration points. Line numbers can change.

| File | Finding |
| --- | --- |
| `packages/plugin-browser/src/plugin.ts` | Skill-only plugin |
| `packages/plugin-browser/skills/browser/SKILL.md` | CLI workflow, screenshot files, unrestricted CLI evaluation examples |
| `docker/Dockerfile.sandbox-k8s` | apt Chromium and agent-browser 0.34.0 installed |
| `packages/engine/src/types.ts` | Tool context, attachments, sandbox exec and gateway contracts |
| `packages/engine/src/plugin-catalog.ts` | Existing action policy path; ToolDef approval metadata is not enforced |
| `packages/engine/src/decision-gate.ts` | Restart re-invokes a blocked tool from its beginning |
| `packages/engine/src/sandbox/attachment.ts` | Clean suspend/resume can retain attachment epoch |
| `packages/engine/src/builtin-tools/index.ts` | Built-in file read is text-oriented |
| `packages/engine/src/tool-bridge.ts` | Immediate tool image support exists |
| `packages/engine/src/thread.ts` | Live tool-end and historical rehydration have text-only paths |
| `packages/api/src/engine/bridge.ts` | Standalone attachment parts can be dropped |
| `packages/api/src/routes/gateway-proxy.ts` | HTTP/WS proxy, owner checks, auth stripping and cookie confinement |
| `packages/api/src/auth/sandbox-tokens.ts` | Existing JWT lacks browser-specific audience/scopes/runtime identity |
| `packages/api/src/services/session-access.ts` | Personal/team view and administration helpers |
| `packages/sandbox-gateway/src/gateway.ts` | Targets currently cover ttyd and VS Code |
| `packages/web/src/components/session/sandbox-tabs.tsx` | Only full-profile terminal/editor panes |
| `docker/start-full.sh` | Startup/shutdown owner for current interactive services |
| `packages/sandbox-docker/src/sandbox.ts` | Working-directory persistence; restore currently uses an in-memory map |
| `packages/sandbox-kubernetes/src/provider.ts` | Suspend retains persistent state; destroy owns volume cleanup |
| `packages/sandbox-local/src/sandbox.ts` | Host execution without sandbox isolation |

The existing gateway activity accounting counts client WS traffic as activity.
Viewer acknowledgments and heartbeats must not inadvertently prevent hibernation.
The browser needs a separate runtime generation and an explicit turn-completion
hook for temporary-tab cleanup.

## 7. What remains to measure

This research supports the interface and software direction. It does not replace
the design's compatibility spike. The spike must measure actual provider resource
budgets, screencast behavior, REPL confinement, native-module packaging, browser
sandbox support, cross-origin/OOPIF behavior and WebMCP availability.

The inspection did not establish how Codex implements its read-only evaluation,
reference mapping, backend transport, REPL isolation or permission enforcement.
Valet's proposed mechanisms are explicit design choices with their own tests.

## 8. Document validation

An independent spec review checked the design against current Valet code. The
revised document addresses shared-agent authorization, transcript audience,
durable Docker adoption and replacement versus final deletion. The second review
approved the design for the stated planning scope, subject to its explicit spike.

Repository documentation lint passed. Local checks found no broken relative
document links, unbalanced code fences or trailing whitespace in either new file.
The STE diagnostic reports include identifiers and tables; they are not a formal
certification of the prose.

The required `make e2e` run completed with 22 passed, 1 failed and 11 skipped. The
failed row was `plugins-unit`: the existing Slack catalog test expected a list
without `slack.app_mention`. An unrelated change already present in
`packages/plugin-slack/src/triggers.ts` adds that key. This documentation task did
not modify that source or its test.

Skipped suites reported an unreachable Docker daemon, unset Kubernetes fullstack
opt-in, or absent Telegram/GitHub live-test configuration. The full scorecard was
captured in `/tmp/valet-browser-spec-e2e.log`. It is not a clean repository result;
it does not invalidate the browser design's separate, still-unrun acceptance tests.
