# In-app tour

Status: implemented (2026-11-03).

## Goal

A new user gets a short guided tour of Valet's main surfaces. After a large UI change, an operator re-shows the tour to every user by raising one number. No database edit is necessary.

## What it replaces

The product announcement notice (`ProductAnnouncement`, `/api/product-announcements`, tables `product_announcements` and `product_announcement_acknowledgements`) is deleted. It held one release notice that pointed at a top-bar Workflows entry, which the Spaces sidebar removed. The tour covers Workflows, and its version replaces per-notice acknowledgements. Deployed databases keep the two old tables; no code reads them.

The legacy stack's `users.onboardingCompleted` profile page (`packages/client`) is frozen and is not used.

## Steps

`packages/web/src/components/tour/tour-steps.ts` holds the steps in order: Home, Tasks, Spaces, Threads and projects, Workflows, Presence, Integrations, Slack. Each step has an id, a title, desktop copy, optional phone copy, and an optional `data-tour` target.

- **Desktop (768px and wider).** Each step with a target is a popover (`PopoverAnchor` with a `virtualRef`) next to the element with that `data-tour` value. The element gets a ring (`[data-tour-active]`). A step with no target is a centered card.
- **Phone (below 768px).** Each step is a full-screen card. The sidebar is in the closed drawer, so the copy names the menu and the tabs.
- **Missing targets.** If a step's element is not on the page, the step waits up to 1.5 seconds for a slow render, then the tour moves on. Back and Next skip steps whose elements are absent. The cause can be a collapsed sidebar, a feature that is off, or a page the person cannot open.
- **Plugin gating.** The Slack step shows only when the `slack` plugin is on for the person.

Targets: `home` (sidebar Home row), `tasks` (Home's Tasks button), `spaces` (the Spaces section), `projects` (the Projects header), `workflows` and `presence` (the open space's rows), `space-settings` (the open space's row for Integrations, Skills, Memory, and Usage).

## When it shows

The tour starts by itself only on Home (`/`), once per page load, when `GET /api/tutorial` returns `due: true`.

`due` is true when one of these is true:

- The person has no outcome (never finished or skipped, or a pass is in progress).
- The stored `seen_version` is below the instance version.
- The stored `seen_org_version` is below `orgs.tutorial_version`.

The instance version comes from `org.tutorialVersion` in `valet.yaml` or from `VALET_TUTORIAL_VERSION` (whole number from 1, default 1). If both are set, the api refuses to boot, the same as the other env and file pairs.

An org admin can choose **Show the tour to everyone again** in Settings, Organization, General. It adds 1 to `orgs.tutorial_version` (`POST /api/tutorial/reset`).

## Saved state

Table `user_tutorial`, one row per user (cascade delete with the user): `seen_version`, `seen_org_version`, `outcome` (`completed`, `skipped`, or null), `step` (the resume point), `updated_at`. `SCHEMA_REPAIRS` creates the table and the `orgs.tutorial_version` column on deployed databases.

- Each step shown saves `step` (`PUT /api/tutorial`) and sets `outcome` to null. A reload resumes at that step.
- Done saves `completed`; Skip tour or Escape saves `skipped`. Both send the versions the person saw. The server caps them at the current versions and never lowers a stored version, so a stale tab cannot re-show the tour.
- A version bump does not delete or change rows. It only makes `due` true again, and the tour starts at the first step.

## Replay

The account menu has **Take the tour**. It opens Home and starts the tour at the first step. A replay saves progress and an outcome the same way.

## Changing the tour

1. Edit the steps or the UI.
2. If the change is large, raise `VALET_TUTORIAL_VERSION` (or `org.tutorialVersion`) and deploy.
3. If you rename a step id, raise the version too. Otherwise a person in the middle of the tour restarts at the first step.
