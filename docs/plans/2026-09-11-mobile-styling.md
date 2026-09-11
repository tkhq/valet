# Mobile Styling Implementation Plan

**Goal:** Make navigation and common Valet controls usable on small screens.

**Architecture:** Keep existing routes and data flow. Use responsive Tailwind classes and existing Radix primitives.

**Tech Stack:** React, TanStack Router, Tailwind, Radix, Vitest.

## Tasks

- [x] Add failing interaction tests in `packages/web/src/components/layout/top-nav.test.tsx` and `app-shell.test.tsx`.
- [x] Update `components/layout/top-nav.tsx` with a mobile destination menu using the existing links and entitlement gates.
- [x] Update `components/layout/app-shell.tsx` to use a focus-managed drawer and dynamic viewport height.
- [x] Update `components/settings/settings-rail.tsx` with a compact mobile section menu using the existing access-filtered groups.
- [x] Adjust shared dialog, dropdown, button, and input primitives for mobile sizes and viewport constraints.
- [x] Adjust session headers, composer, tabs, and list toolbars where content cannot fit.
- [x] Run focused web tests and web typecheck. Inspect mobile and desktop rendering in a browser.
- [x] Run `make e2e` with full output saved.
- [x] Review the final scorecard and commit the validated work.

## Commands

`pnpm --filter @valet/web test top-nav app-shell settings`

`pnpm --filter @valet/web typecheck`

`make e2e 2>&1 | tee /tmp/valet-mobile-e2e.log`

## Review additions

- Test the settings menu's current section, navigation, unresolved organization data, and role filtering in `components/settings/settings-rail.test.tsx`.
- Test mobile drawer focus return and menu dismissal. Close mobile overlays when their desktop breakpoint activates.
- Shared files: `components/primitives/{button,input,dialog,dropdown-menu,tooltip}.tsx`.
- Session files: `components/session/{session-header,composer,sandbox-tabs}.tsx`.
- Check 44-pixel mobile targets, 16-pixel dialog margins, and page overflow at 639/640 and 767/768-pixel boundaries.
