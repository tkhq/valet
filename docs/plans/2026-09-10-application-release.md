# Application release implementation plan

**Goal:** Add manual application releases and separate Helm chart history.

**Architecture:** A release workflow allocates stable application tags and calls the existing publishers as reusable workflows. Changelog generation accepts application tags only.

**Tech Stack:** GitHub Actions, Node.js, Git, Vitest.

- [x] Add regression tests for major/minor/patch calculation and chart exclusion.
- [x] Add a version helper and a serialized manual release workflow.
- [x] Add reusable entry points to CLI and Docker publishers with explicit release tags.
- [x] Remove chart backfill patterns and rebuild the committed changelog.
- [x] Update the changelog spec and document manual release and retry commands.
- [x] Run the full e2e scorecard and verify corrected failures with focused reruns.

Validation: full e2e reported 29 passes, two build failures, and four missing-configuration skips.
The web selector type correction and serial build rerun passed all four selected checks.
Release tests (4), changelog tests (34), web wrapping tests (4), and actionlint passed.
