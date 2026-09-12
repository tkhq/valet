# Mobile chat viewport

## Problem

The phone transcript can scroll sideways when inline code contains long hashes. Session controls wrap into several header rows.
Page zoom can leave app controls outside the visible area. The user requested a stable viewport and compact app navigation.

## Design

- Keep the conversation column within the available width. Wrap long words, URLs, and inline code without changing copied text.
- Contain wide tables and fenced code within their own scrollers. The transcript itself scrolls vertically only.
- Reduce the phone navigation bar to 48 pixels. Use a compact single-row session header with the title, model, and one menu.
- Move phone ratings, copy, and pause actions into that menu. Preserve permissions, pending states, errors, and confirmations.
- Keep phone text entry at 16 pixels. On touchscreens, use inherited pan-x and pan-y touch actions to suppress page-scale gestures while preserving scrolling.
  Existing canvas gesture overrides remain in force. Do not add a maximum-scale viewport restriction.
- Give the floating Latest control an opaque surface and a 44-pixel phone touch target.
- Preserve desktop layouts, browser keyboard zoom, and system accessibility magnification.

## Validation

Reproduce the screenshot with long inline hashes, URLs, lists, fenced code, and tables at 320, 375, and 390 pixels.
Check Chromium and WebKit layouts, phone gesture behavior, short viewports, desktop sizing, and portrait-to-landscape changes.
Test the moved actions and their permission gates. Verify code copying preserves the original text.
Run web tests, typecheck, the full make e2e scorecard, and changelog commit validation before opening the new PR.

## Results

- Chromium and WebKit passed at 320, 375, 390, 768, and 1440 pixels. The document and transcript had no horizontal overflow.
- At 375 pixels, navigation height fell from 56 to 48 pixels. Session header height fell from 163 to 56 pixels.
- A wide table scrolled inside its own region. Long inline hashes and copied transcript text retained their original contents.
- Phone fields used 16-pixel text. Copy feedback and menu dismissal after rotation passed in both browsers.
- Chromium touch tests kept page scale at 1 during pinch and double-tap gestures. Workflow canvas pinch zoom still changed the graph scale.
- A 390-by-400 viewport kept the composer and menu usable. This simulates reduced space, not the native keyboard lifecycle.
- The full web suite passed 2,969 tests. The targeted suite passed 78 tests. Web typecheck passed. Independent standards and requirements reviews found no remaining issues.
- Physical iOS gesture and keyboard testing remains outstanding.

The full `make e2e` run reported 28 passed, 3 failed, and 4 optional suites skipped.
The API bundle passed on rerun after the parallel web build produced its assets.
The unchanged engine archive test calls `/bin/tar`, which does not exist on this macOS host.
The Kubernetes provider test hit a clock race between the eviction cutoff and its mock event timestamp.
All 90 provider tests passed separately. The initial Kubernetes unit-only scorecard row also passed.
All GitHub CI checks passed for the implementation commit.
[PR #672](https://github.com/tkhq/valet/pull/672) records the final isolated Kubernetes suite result.
