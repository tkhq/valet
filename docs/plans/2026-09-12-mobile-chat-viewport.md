# Mobile chat viewport implementation plan

**Goal:** Keep phone chat inside its viewport with compact navigation and reliable touch behavior.

**Architecture:** Use responsive Tailwind rules in existing chat primitives and layout components. Preserve action handlers and permission checks.

**Tech stack:** React, Radix, Tailwind, Vitest, Playwright Chromium and WebKit.

- [x] Reproduce horizontal transcript overflow and measure the current header with a populated browser fixture.
- [x] Update Markdown, MessageItem, and MessageList width and wrapping rules. Contain table and code overflow locally.
- [x] Compact SessionHeader and TopNav. Test phone menu callbacks, pending states, and team permission filtering.
- [x] Apply scoped touch behavior and verify browser gestures, field focus, resize, and short viewport behavior.
- [x] Run web tests, typecheck, browser checks, full e2e, and independent review. Record results in the spec.
- [x] Commit with accepted subjects and Changelog trailers. Open a new PR against dev-v2.
