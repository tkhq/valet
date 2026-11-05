# Browser agent pointer implementation plan

**Goal:** Show animated agent interactions in both browser views and remove the browser-wide focus border.

**Architecture:** Runtime tracking produces optional frame metadata. The API validates and forwards it. A shared SVG overlay animates in image coordinates.

- [x] Runtime: implement agent-only interaction tracking and real Chromium regression tests.
- [x] Transport: add the shared cursor shape, frame metadata, safe API header, and client parsing tests.
- [x] Viewer: add the shared animated overlay, letterbox mapping, stale-frame protection, reduced motion, and focused component tests.
- [x] Remove the transparent input layer's focus ring and verify it live.
- [x] Review, rebuild the sandbox, and dogfood an actual agent browser turn.
- [x] Run full `make e2e`, retry infrastructure failures, commit with a changelog, and push to PR #801.
