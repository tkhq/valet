# Artifact authoring validation

Date: 2026-11-06
Base: `dev-v2`, based on `4a8962f80`.
Environment: Node 24, macOS, separate worktree database and ports.
No production deployment or integration configuration changed.

## Final checks

| Check | Result |
| --- | --- |
| Artifact editor, creation, frame, templates, gallery, composer, draft, context and transcript regressions | 330 passed across 17 web files |
| API, revision, selection and agent tool regressions | 36 passed across 4 files |
| Existing artifact privacy, source, publishing and memory-tool coverage | 124 passed across 10 files |
| Shared artifact document and CSP tests | 43 passed |
| Final root typecheck and web production build | Passed |
| API production bundle and maintained documentation lint | Passed |
| Independent code review and re-review | No remaining actionable findings |

The first review corrected source disclosure through comments, access to another publisher's history, and ambiguous preview-text mapping. The UI re-review corrected uncertain retries that changed artifact context, selection replacement during delivery, and hidden context appearing after an unclosed Markdown fence. Regression tests cover these cases. Copy, prompt recall, and message editing retain the human request without internal context. Slash commands keep their original arguments.

## Actual browser flow

The local browser used the real API, database, conversation component and agent on ports 15173 and 18788. The model credential stayed server-side.

1. Create a Document through the title-first chooser. Document and HTML Page are the only template choices.
2. Highlight a preview paragraph. Edit with Valet appears beside the selection. Choosing it attaches the passage to the existing chat draft and focuses that input.
3. Send the targeted request. The agent uses `artifact_edit`; version 2 appears beside the conversation without reloading.
4. Send a broad request through the same input. The agent uses the fresh artifact context and updates the existing artifact as version 3.
5. Open the footer version menu, preview version 1, and confirm Restore. Version 4 equals version 1; intermediate revisions remain available.
6. Create an HTML Page. Select its heading with the element picker, choose Edit with Valet, and request italic text. The live preview updates.
7. Switch compact panes and reload. The draft, conversation, artifact and history remain available.
8. Inspect 1440px, 1280px, 760px and 375px widths. Both desktop pane headers measure 56px, with the same top and bottom coordinates. Compact layouts have no horizontal page overflow. The existing sidebar and team navigation remain unchanged.

Read-only revision comparisons confirmed that the targeted Document and HTML edits preserved every other source byte, restore exactly reproduced the original source, and the reader token stayed the same. The broad edit changed the requested paragraph and normalized a trailing newline; it does not promise bounded replacement.

Automated tests cover stale selections, historical previews, failed or undelivered requests, oversized source, attachments, changed drafts, uncertain retries across reloads, denied source access, and shared-pin preservation.

## Repository scorecard

The latest full `make e2e` completed with **24 passed, 4 failed, 9 skipped**. Full output was retained locally. The four failed steps were conventions, the root unit sweep, plugin suites, and the Keycloak fixture. The unit sweep passed 15,842 tests and reported six failures.

That sweep overlapped the final metadata fix. Its two artifact-context assertions pass in the final 330-test focused run and independent re-review. The remaining issues are outside the changed implementation:

- Three double-cast convention violations exist in unchanged tests: `packages/api/src/bakes/source-service.test.ts:93`, `packages/sandbox-kubernetes/test/provider.test.ts:2781`, and `packages/workflow/src/dag/validate.test.ts:502`.
- The Keycloak fixture uses password-only authentication by default. Its real flow passes with the process-only `AUTH_METHODS=password,oidc` override.
- Presence overview, credential-tripwire timing assertions, and GitHub action tests exceeded their existing timing bounds in the broad run. Separate reruns passed without changing their code or timeouts: Presence 20 tests, credential tripwire 27 tests, and GitHub actions 74 tests.

GNU command tools resolve the existing macOS `chmod 700 --` incompatibility. Credential-gated suites were skipped by the canonical runner. Browser validation separately exercised real bounded and broad agent edits.

## Limits and follow-up

Preview selections that cross formatting, entities or ambiguous source require selection in Source. Broad chat context is limited to 100,000 source characters; larger artifacts use selection edits. Legacy artifacts without a source thread support preview and restore only. Historical bodies require their recorded author because old versions lack source-conversation metadata, including for org admins.

Slides, team design systems, direct document editing, per-version provenance and integration-backed dashboards remain proposed work. The MVP retains workspace permissions, sharing controls, pinned reader revisions, anchored comments and iframe/CSP isolation.
