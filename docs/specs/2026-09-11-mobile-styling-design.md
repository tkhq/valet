# Mobile styling

## Scope

Improve navigation and common controls in `packages/web` on phones and tablets. Preserve desktop behavior and workspace access rules.

## Design

- Below `md`, primary destinations move into a labelled menu. Desktop retains its navigation links.
- Keep the workspace switcher, notifications, and settings reachable. Long workspace names truncate within the available width.
- Below `sm`, settings uses a section menu above the form. Both layouts use the same role-filtered section lists.
- Use the existing Radix dialog primitive for the thread drawer. Support Escape, focus containment, backdrop dismissal, and focus restoration.
- Use dynamic viewport height for the app shell. Dialogs retain edge spacing and scroll within the viewport.
- Let session headers wrap. Keep titles, status, and actions reachable with long names.
- Keep thread menus visible without hover on mobile. Increase assistant and thread navigation touch targets.
- Increase common control touch targets on phones. Keep desktop sizing through responsive classes.
- Review list toolbars and session tabs for overflow. Contain wide tables and code within their own scrollers.

## Validation

Test menu navigation, permission filtering, and drawer keyboard behavior. Check representative pages at 375, 390, 768, and 1440 pixels.
Run web tests, web typecheck, and the required `make e2e` scorecard. Record environment failures separately.

## Acceptance criteria

Mobile common controls have a 44-pixel minimum target. Dialogs keep 16-pixel side margins. Pages do not scroll horizontally.
Settings menus preserve group labels and role filtering, including unresolved organization queries.
Check 639/640 and 767/768-pixel breakpoint transitions. Opening an overlay and then widening the viewport must release focus and scroll locks.

## Results

Browser checks cover chat, settings, and sessions at 320, 375, 390, 639, 640, 767, 768, and 1440 pixels.
Additional phone checks cover memory, workflows, usage, events, artifacts, and integrations.
The menus preserve destination access and settings groups. Long workspace names fit within the header.
Drawer checks cover Escape, focus return, backdrop dismissal, and breakpoint changes. Dialogs retain their side margins.
The independent code review found no remaining issues after corrections to input sizing and drawer focus.

Dark-mode checks use a 320-by-568-pixel viewport with a long notification list and the model picker open.
Tooltips wrap within the viewport. Model reasoning controls keep phone-sized touch targets.
The full web suite passes: 256 files, 2,848 tests. Root typecheck, web typecheck, and production bundle checks pass.

The first full `make e2e` run passed 29 checks and failed two build checks. Both build checks passed on rerun.
The initial web build found duplicate props, which this pass corrected. The API bundle ran before web assets were available.
All 31 enabled checks passed across the full run and targeted reruns. Four optional integrations were skipped:
Kubernetes full stack, Telegram, live GitHub App, and 1Password.
Final targeted tests also pass for assistant/thread navigation, model controls, and drawer focus.

## Text entry polish

The composer uses one rounded surface for the draft, attachments, and actions. Its focus border and ring use theme tokens.
The textarea grows with the draft, shrinks when cleared, and measures again when its container width changes.
Long drafts scroll within a cap of 14 rem or 35 percent of the dynamic viewport height, whichever is smaller.
The writing area also shrinks when the surrounding layout has less room. The action row keeps its height.
Send, Queue, and Steer retain explicit labels and existing submission behavior. Desktop shows the keyboard shortcuts below the draft.

Shared phone inputs use 48-pixel minimum heights, 16-pixel text, rounded corners, and more padding.
Focus, caret, and text selection use the active palette. Desktop field sizing remains unchanged.
Motion-reduction preferences disable the added transitions.

Browser checks cover long-draft growth, height limits, internal scrolling, clearing, and typing at the end of a draft.
The send control stays inside the viewport at 320 by 568, 390 by 400, 640 by 844, and 1440 by 900 pixels.
These are Chromium viewport checks; they do not certify native iOS keyboard behavior.

Text entry validation passes: 2,850 web tests, including 97 composer and autosize checks, plus web typecheck and production build.
Light and dark screenshots confirm the mobile composer and shared form field styling. Existing drafts reflow without losing text.
The second full e2e run passed 30 checks. The engine step failed on two child-process startup timeouts.
Both tests passed in isolation, and the complete engine step then passed in the e2e runner.
All 31 enabled checks passed across the full run and rerun. The same four optional integrations were skipped.
The final flex sizing change passed browser checks, targeted tests, typecheck, production build, and independent code review.
