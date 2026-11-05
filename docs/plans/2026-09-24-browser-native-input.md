# Browser dropdown and cursor implementation plan

**Goal:** Make native dropdown choices visible and show the remote element's cursor in the Browser panel.

**Architecture:** Use Chromium's in-page select picker for native single-select dropdowns. Return a safe cursor keyword with human input responses. Keep the image transport and ordered input queue.

**Tech stack:** Playwright, Chromium, TypeScript, React, Vitest.

- [x] Add real Chromium regression fixtures for dropdown opening, option clicks, disabled options, keyboard input, frames, and shadow roots.
- [x] Add `viewer-page.ts` for select rendering and cursor hit testing. Install the select rendering hook before pages load.
- [x] Return cursor feedback through the shared response and daemon. Forward it through BrowserPane to BrowserViewport.
- [x] Test cursor changes, leaving the page, stale replies, navigation, and safe cursor values.
- [x] Run focused suites and typecheck. Rebuild the sandbox runtime and dogfood both fixes in the local viewer.
- [x] Run full `make e2e`. Commit with a changelog and push to PR #801.

## Verification notes

Eleven real Chromium cases cover captured JPEG pixels, option clicks, disabled choices, keyboard selection, cancellation, and long menus. They also cover strict CSP, style priority, size transitions, dynamic shadow roots, and cross-origin frames. Cursor checks include text, links, resize styles, URL fallbacks, and blank space. Web tests cover stale replies, image margins, document changes, and control loss.

Live dogfooding confirmed visible dropdown options, a changed selection, the text cursor over an input, and the pointer cursor over a link. Review found and resolved text hit testing, style priority, and repeated subtree scans.

Full `make e2e` completed with 32 passes and four credential or opt-in skips. The unrelated Kubernetes eviction-reporting unit test failed once. Its isolated suite retry passed.
