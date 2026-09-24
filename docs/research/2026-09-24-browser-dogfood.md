# Sandbox browser dogfood, 2026-09-24

## Environment

The test used the local Valet web client on port 5174 and API on port 8788.
The sandbox ran the production Dockerfile on arm64 with browser confinement enabled.
The test page served synthetic form data on sandbox port 5173. No external account was used.

The UI checks used the Codex browser interface against Valet. They did not bypass the UI with Playwright scripts.
API checks separately verified downloaded bytes and exported evidence.

## Defects found and fixed

1. Dialog responses waited behind the pointer request that opened the dialog. A separate client mutation now sends responses immediately.
2. Frame requests timed out during dialogs. The viewer pauses capture until the dialog closes and disables screenshot capture.
3. Chromium downloads used a private temporary filesystem. Downloads now use the broker state directory and retain the correct bytes.
4. Saved annotation warnings did not update after navigation. Open annotation panels now refresh document staleness every two seconds.
5. A new viewer request could conflict with an interrupted capture. The client makes three bounded retries for HTTP 409 responses.
6. Navigation did not restart a failed viewer. A document change now resets frame capture.
7. Reloading a session omitted sandbox readiness from its WebSocket handshake. The handshake now sends current state after replay.
8. VS Code WebSocket upgrades omitted the gateway session cookie. The API now forwards the same allowlisted cookie as HTTP.
9. Review found that rejected downloads retained raw files outside broker accounting. Cleanup now runs after successful and failed imports.

Each code change has a regression test. The real Docker download test failed with zero bytes before the fix.
It passed after the production image rebuild and verified the exact response body.

## Manual control coverage

| Area | Controls and states exercised | Result |
| --- | --- | --- |
| Session | Create, rename, session list, re-entry, Browser/Chat switching, page reload | Passed |
| Startup | Refresh status, Start browser, ready state, empty tab state | Passed |
| Ownership | Take control, Release control, Stop actions, Resume, lease expiry, Renew | Passed |
| Private mode | Private sign-in, disabled screenshot, real agent observation denial, release | Passed |
| Tabs | New tab, select tab, close background tab, close selected and last tab | Passed |
| Navigation | Go, Enter, Back, Forward, Reload, HTTP local fixture | Passed |
| Errors | Invalid scheme, denied metadata address, failed TLS navigation, recovery, Retry viewer | Passed |
| Remote input | Pointer mapping, name input, checkbox, select with keyboard, form submission | Passed |
| Text | Multiline Unicode paste, keyboard navigation, Escape then Tab leaving capture | Passed |
| Pointer and scroll | Drag and drop, scroll down and up, bottom-page button click | Passed |
| Dialogs | Alert accept/dismiss, confirm true/false, prompt text/null, viewer resumption | Passed after fix |
| Files | Page download, Downloads link, exact retrieved file contents | Passed after fix |
| Evidence | Save screenshot, screenshot link, dismiss evidence | Passed |
| Annotations | Open/close, label, image pin, X/Y pin, Add, Remove, Save, New, saved selection | Passed |
| Annotation export | Download annotated image, reopen saved pins, stale warning after navigation | Passed after fix |
| Access | Capabilities disclosure, Owner, personal-session Team rejection, Revoke synthetic grant | Passed |
| Lifecycle | Disable access, Enable browser, Start again | Passed |
| Agent tools | Real describe/execute, approval, code disclosure, expanded output, Open browser | Passed |
| Agent evidence | Inline screenshot, artifact link, annotations, retained text and image after reload | Passed |
| Gateway | Terminal command, session reload, VS Code connection, folder picker, fixture source in restricted mode | Passed after fixes |

## Limits and observations

- This pass covered the new browser feature and adjacent session views. It was not an audit of all Valet administration screens.
- The UI ran at approximately 670 by 910 pixels. Native IME composition and mobile breakpoints were not manually exercised.
- Team-member viewing and unsupported-provider states have automated tests. This UI pass used a personal local-auth session.
- The local-auth gateway signing fallback changes when the API process restarts. Old sandbox gateways rejected fresh tokens after that restart.
  A new sandbox accepted the current token and executed a terminal command. This behavior is separate from browser tickets.
- Gateway cookies expire after 15 minutes. A later VS Code folder navigation returned Unauthorized. Reloading Valet restored access.
- Shorthand addresses default to HTTPS. Use an explicit `http://` address for a development server without TLS.
- Screenshot polling can show the preceding image briefly while a request finishes.
- The test did not exercise real third-party sign-in, native OS dialogs, or native amd64 execution.

## Validation

Focused web and WebSocket regressions passed. The rebuilt production image passed the real Docker browser integration.
Early full-suite attempts crossed repeated macOS sleep intervals. Those runs produced expired sessions and unrelated timeout failures.
A bounded `caffeinate` process prevents idle sleep during the final validation run.
The final full `VALET_BROWSER_TEST_IMAGE=valet-sandbox-browser:local make e2e` scorecard was **33 passed, 0 failed, 4 skipped**.
Skipped rows required opt-in fullstack Kubernetes, Telegram credentials, GitHub App credentials, or a 1Password token.
The full log is `/tmp/valet-browser-dogfood-e2e-awake.log`.

The production image rebuilt successfully after the cleanup fix. All 10 real Chromium fixture tests passed.
The quota-rejection test failed on a retained raw file before the fix and passed with an empty download directory afterward.
The final image passed both `browser-runtime` and `browser-docker` scorecard rows: **2 passed, 0 failed**.
That log is `/tmp/valet-browser-dogfood-e2e-image-final.log`.
Independent review found no remaining issues in the dogfood diff.
