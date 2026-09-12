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

## Scroll direction follow-up

On phones, the full session header slides above the thread when the reader scrolls down at least 12 pixels.
An upward scroll of 12 pixels brings it back. At the top of the thread, the header stays visible.
Place the header and sandbox tab strip in the transcript's sticky layer. Animate its transform without changing the scroll viewport or composer position.
Streaming, initial positioning, and the Latest action do not change header visibility. Thread switches reveal it.
Keyboard focus reveals header controls. Editing the session title keeps the header visible. Reduced motion disables the slide animation.
Empty threads keep their controls. Resizing reveals the header and resets direction tracking.
Desktop, embedded panel, and non-chat headers remain visible. Menus and dialogs keep their existing action handlers.

Implementation plan: add direction tracking tests, move the full chat header into the sticky layer, verify browser scrolling and controls, then update PR #672.

Scroll follow-up validation: 18 targeted tests passed, including initial messages, streaming, direction thresholds, title editing, and thread switches.
Chromium touch swipes and WebKit wheel input at a phone viewport passed. The transcript height and composer position stayed constant during the slide.
Full-profile sandbox tabs, keyboard focus, rotation, desktop pinning, and reduced-motion behavior passed browser checks.
The complete web suite passed 2,977 tests. The final production build passed. Tab switching retains keyboard focus in both directions.

## Compact composer follow-up

An empty, unfocused composer uses one input row on phones and desktops. Existing queue and working hints remain above that row. Selecting the message field expands the input above its action row.
The composer stays expanded while it contains text, attachments, errors, or a pending submission. An empty composer collapses when focus leaves it.
Focus movement between the input and its actions keeps the expanded layout stable. Attachment and Stop buttons remain usable from the compact row.
Preserve accessible action names, 44-pixel touch targets, 16-pixel input text, draft persistence, and bounded multiline scrolling.

Validation plan: test focus and draft transitions, submission focus, and attachment actions. Check compact and expanded geometry in Chromium and WebKit.
Run the web tests, typecheck, production build, full make e2e scorecard, and independent review before updating the PR.

Compact composer validation: all 2,984 web tests passed. The production build and typecheck passed.
Chromium and WebKit passed at 320, 375, 390, 768, and 1440 pixels. The idle composer measured 78 pixels tall.
Mouse clicks and touch taps opened attachments from both layouts. Drafts, attachment removal, disappearing actions, and short viewports passed.
The focus handler prevents Safari's default mouse focus change while preserving touch clicks. Independent reviews found no remaining issues.
The full unit scorecard row passed on rerun after an unrelated API redirect test failed during concurrent validation.
Physical iPhone keyboard testing remains outstanding.

The compact composer full make e2e run reported 29 passed, 2 failed, and 4 optional skips.
The unit row passed on rerun. The remaining engine archive failure requires `/bin/tar`, which is absent on this Mac.
