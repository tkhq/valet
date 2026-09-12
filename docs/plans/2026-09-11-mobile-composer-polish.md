# Mobile composer polish

## Goal

Make text entry comfortable and visually consistent with the mobile interface.

## Design

Use one rounded composer surface for text, attachments, and actions. Keep Send, Queue, and Steer labels explicit.
Grow the textarea with its content. Cap its height and scroll long drafts internally. Recalculate after container width changes.
Keep submission shortcuts, per-thread drafts, attachments, and error recovery unchanged.
Use a brief placeholder and move keyboard instructions into the desktop action row.
Improve shared mobile input corners, spacing, caret color, and focus feedback. Preserve compact desktop field overrides.

## Steps

- [x] Add tests for growth, shrinkage, and container resize.
- [x] Add the autosize hook and integrate it into the composer.
- [x] Style the unified composer and shared mobile inputs.
- [x] Check phone, short-screen, and desktop layouts with multiline text in both themes.
- [x] Run composer and web tests, typechecks, production build, and the required e2e scorecard.
- [x] Review and commit the changes.
