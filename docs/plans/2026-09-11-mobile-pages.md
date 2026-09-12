# Mobile page pass

## Scope and design

Extend the approved mobile treatment across Home, Security, Settings, and the remaining application pages.
Preserve desktop layouts, workspace permissions, API behavior, and drafts.
Use focused mobile views for dense editors and inspectors. Keep a clear way back to lists or the canvas.
Use wrapping action rows, readable forms, and 44-pixel touch targets. Contain charts and code within their own scrollers.

## Ownership

- Security agent: hub, engagement sections, findings, setup, and security dialogs.
- Settings agent: personal, team, and organization forms, management tables, and the workflow editor.
- Home/activity agent: dashboards, Usage, Events, workflow lists and runs, and assistant management.
- Coordinator: Memory, Artifacts, Skills, Integrations, shared components, and combined validation.

## Validation

- [x] Review and integrate each agent's changes.
- [x] Check populated pages and primary navigation at 320 and 390 pixels, plus desktop.
- [x] Run relevant behavior tests for new mobile navigation and preserve permission checks.
- [x] Run web tests, typechecks, production build, and the full e2e scorecard.
- [x] Update the mobile spec and commit the verified changes.
